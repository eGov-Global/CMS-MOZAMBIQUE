const channelProvider = require("../channel"),
  telemetry = require("./telemetry"),
  system = require("./system"),
  userService = require("./user-service");
const InboundRequestModel = require("../machine/util/inbound-request-model.js");
const config = require("../env-variables");
const SandboxOrgTracker = require("./sandbox-org-tracker");
const SandboxLoginFlow = require("./sandbox-login-flow");
const StandardLoginFlow = require("./standard-login-flow");
const ChatService = require("./chat-service");

// Simple in-memory store for tracking email validation requests in sandbox mode
// Format: { mobileNumber: { timestamp: Date, waitingForEmail: boolean } }
const sandboxOrgCodeTracker = {};
const sandboxOrgTracker = new SandboxOrgTracker(sandboxOrgCodeTracker);

// Prevent memory leak - automatically clean up expired sessions every 5 minutes
const cleanupInterval = setInterval(() => {
  try {
    const now = Date.now();
    const EXPIRY_TIME = 30 * 60 * 1000; // 30 minutes
    let cleanedCount = 0;
    
    Object.keys(sandboxOrgCodeTracker).forEach(mobileNumber => {
      const entry = sandboxOrgCodeTracker[mobileNumber];
      if (entry && (now - entry.timestamp) > EXPIRY_TIME) {
        delete sandboxOrgCodeTracker[mobileNumber];
        cleanedCount++;
      }
    });
    
    if (cleanedCount > 0) {
      console.log(`Session cleanup: Removed ${cleanedCount} expired sessions. Active sessions: ${Object.keys(sandboxOrgCodeTracker).length}`);
    }
  } catch (error) {
    console.error('Session cleanup error:', error);
  }
}, 5 * 60 * 1000); // Run cleanup every 5 minutes

// Don't let the housekeeping timer hold the event loop open; the HTTP server
// keeps the process alive in production, and this makes the module requirable
// from a test without hanging the runner.
if (typeof cleanupInterval.unref === 'function') cleanupInterval.unref();

// Clear interval on process termination to prevent memory leaks
process.on('SIGINT', () => clearInterval(cleanupInterval));
process.on('SIGTERM', () => clearInterval(cleanupInterval));

async function getAuthenticatedSandboxUser(mobileNumber, tenantId) {
  const user = await userService.loginOrCreateUser(mobileNumber, tenantId);
  if (!user || !user.userInfo) {
    throw new Error(`Failed to authenticate or create user in tenant ${tenantId}`);
  }

  // User is already enriched by loginOrCreateUser
  user.userId = user.userInfo.uuid;
  user.mobileNumber = mobileNumber;
  user.name = user.userInfo.name;
  user.locale = user.userInfo.locale;
  return user;
}

class SessionManager {

  constructor() {
    // Non-enumerable: chatService.chatInterface circles back to this instance,
    // and the xstate context embeds this as chatInterface, then gets
    // JSON.stringify'd for persistence - an enumerable chatService would make
    // that serialization walk straight into the cycle.
    Object.defineProperty(this, "chatService", {
      value: new ChatService(this),
    });
  }

  async authenticateAndDispatch(rawRequestModel) {
    const inboundRequestModel = InboundRequestModel.create(rawRequestModel);

    const loginFlow = config.isSandboxMode
      ? new SandboxLoginFlow(inboundRequestModel, sandboxOrgTracker, getAuthenticatedSandboxUser)
      : new StandardLoginFlow(inboundRequestModel);

    const session = await loginFlow.resolveSession();
    if (!session) return; // login flow already responded to the user

    await this.chatService.dispatch(session, inboundRequestModel);
  }

  async toUser(user, outputMessages, extraInfo) {
    channelProvider.sendMessageToUser(user, outputMessages, extraInfo);
    for (let message of outputMessages) {
      telemetry.log(user.userId, "to_user", {
        message: { type: "text", output: message, locale: user.locale },
      });
    }
  }

  // Method to get tenant ID for a mobile number from tracker (for image uploads)
  getSandboxTenantForMobileNumber(mobileNumber) {
    if (config.isSandboxMode && sandboxOrgCodeTracker[mobileNumber]) {
      return sandboxOrgCodeTracker[mobileNumber].orgTenantId || null;
    }
    return null;
  }

  system_error(message) {
    system.error(message);
  }
}

module.exports = new SessionManager();

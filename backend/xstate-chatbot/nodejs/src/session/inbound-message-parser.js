/**
 * Turns one inbound HTTP request into the neutral "reformatted message" the
 * session layer consumes, delegating the provider-specific work to the channel
 * adapter it is given.
 *
 * Deliberately dependency-free: the adapter and the upload tenant are both
 * supplied by the caller, so this class knows nothing about session state, user
 * identity or configuration. A `null` message is a normal outcome rather than an
 * error — it means the payload was not a user message, a delivery receipt for
 * instance.
 */
const InboundMessage = require("../machine/util/inbound-message.js");

class InboundRequestParser {
  constructor(req, provider, tenantId = null) {
    this.req = req;
    this.provider = provider;
    this.tenantId = tenantId;
    this.inboundMessageModel = null;
  }

  static create(req, provider, tenantId = null) {
    if (!provider) {
      throw new Error("InboundRequestParser: a channel provider is required.");
    }
    return new InboundRequestParser(req, provider, tenantId);
  }

  async parseMessage() {
    this.inboundMessageModel = await this.provider.processMessageFromUser(
      this.req,
      this.tenantId
    );

    // A null result is a normal outcome, not an error - it means the payload
    // was not a user message (a delivery receipt, for instance). The caller
    // decides whether to act on it.
    return this.inboundMessageModel;
  }

  getInboundMessage() { 
    return InboundMessage.create(this.inboundMessageModel.message);
  }

  getUser() {
    return this.inboundMessageModel.user;
  }

  getExtraInfo() {
    return this.inboundMessageModel.extraInfo;
  }

}

module.exports = InboundRequestParser;

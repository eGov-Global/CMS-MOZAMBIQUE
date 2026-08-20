const channelProvider = require("../channel");
const userService = require("./user-service");
const config = require("../env-variables");
const Session = require("./session");

class StandardLoginFlow {
  constructor(inboundRequestModel) {
    this.inboundRequestModel = inboundRequestModel;
    this.mobileNumber = inboundRequestModel.user.mobileNumber;
  }

  async resolveSession() {
    try {
      const user = await userService.getUserForMobileNumber(this.mobileNumber, config.rootTenantId);
      this.inboundRequestModel.user = user;
      this.inboundRequestModel.extraInfo.tenantId = config.rootTenantId;
      return Session.create(user);
    } catch (error) {
      channelProvider.sendMessageToUser(
        { mobileNumber: this.mobileNumber },
        [`Sorry, there was an error processing your request. Please check your mobile number format (should be 10 digits) and try again. Error: ${error.message}`],
        this.inboundRequestModel.extraInfo
      );
      return null;
    }
  }
}

module.exports = StandardLoginFlow;

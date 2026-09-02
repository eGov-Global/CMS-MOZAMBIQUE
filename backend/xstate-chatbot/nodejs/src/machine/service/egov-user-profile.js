const { StatusCodes } = require('http-status-codes');
const config = require('../../env-variables');
const fetch = require('node-fetch');
const { ExternalServiceError } = require('../../session/errors');
const BASE_URL = config.egovServices.egovServicesHost + config.egovServices.userServiceUpdateProfilePath;

class UserProfileService {

  async updateUser(user, userSlots, tenantId) {
    user.userInfo.locale = userSlots.locale;
    user.userInfo.name = userSlots.name || user.userInfo.name;

    const url = `${BASE_URL}?tenantId=${tenantId}`;
    const requestBody = {
      RequestInfo: {
        authToken: user.authToken,
        userInfo: user.userInfo
      },
      user: user.userInfo
    };
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    }

    const response = await fetch(url, options);

    if(response.status === StatusCodes.OK) {
      return await response.json();
    } else {
      console.error('Error Updating the user profile');
      console.error(JSON.stringify(await response.json()));
      throw new ExternalServiceError('Error updating the user profile');
    }
  }
}

module.exports = new UserProfileService();
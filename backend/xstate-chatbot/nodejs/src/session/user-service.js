const config = require('../env-variables');
const fetch = require('node-fetch');
require('url-search-params-polyfill');

class UserService {

  async getUserForMobileNumber(mobileNumber, tenantId) {
    try {
      let user = await this.loginOrCreateUser(mobileNumber, tenantId);
      if (!user || !user.userInfo) throw new Error('User info is incomplete');

      user.userId = user.userInfo.uuid;
      user.mobileNumber = mobileNumber;
      user.name = user.userInfo.name;
      user.locale = user.userInfo.locale;
      return user;
    } catch (error) {
      throw error;
    }
  }

  async loginOrCreateUser(mobileNumber, tenantId) {
    try {
      this.validateInputs(mobileNumber, tenantId);

      let user = await this.loginUser(mobileNumber, tenantId);
      if (!user) {
        const result = await this.createNewUser(mobileNumber, tenantId);
        user = await this.authenticateCreatedUser(result, mobileNumber, tenantId);
      }
      
      if (!user) 
        throw new Error(`Unable to authenticate user ${mobileNumber} for tenant ${tenantId}`);

      user = await this.enrichuserDetails(user);
      return user;
    } catch (error) {
      throw error;
    }
  }

  validateInputs(mobileNumber, tenantId) {
    if (!mobileNumber || !tenantId) 
      throw new Error('Mobile number and tenant ID are required');
  }

  async createNewUser(mobileNumber, tenantId) {
    try {
      const createResult = await this.createUser(mobileNumber, tenantId);
      if (!createResult) 
        throw new Error(`Failed to create user for ${mobileNumber}`);
      
      return createResult;
       
    } catch (createError) {
      return this.handleCreationError(createError, mobileNumber, tenantId);
    }
  }

async authenticateCreatedUser(createResult, mobileNumber, tenantId) {
    if (createResult.authToken) {
      return createResult;
    }

    if (createResult.access_token && createResult.UserRequest) {
      return {
        authToken: createResult.access_token,
        refreshToken: createResult.refresh_token,
        userInfo: createResult.UserRequest
      };
    }

    return await this.loginAfterCreation(mobileNumber, tenantId);
  } 




  async loginAfterCreation(mobileNumber, tenantId) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return await this.loginUser(mobileNumber, tenantId);
  }

  async handleCreationError(createError, mobileNumber, tenantId) {
    if (createError.message && createError.message.includes('Duplicate')) {
      console.log('User already exists, attempting login again...');
      return await this.loginUser(mobileNumber, tenantId);
    } else {
      throw createError;
    }
  }

  async enrichuserDetails(user) {
    // Skip enrichment if no auth token
    if (!user || !user.authToken) {
      return user;
    }

    let url = `${config.egovServices.userServiceHost}${config.egovServices.userServiceCitizenDetailsPath}?access_token=${user.authToken}`;

    let options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    try {
      let response = await fetch(url, options);
      if (response.status === HttpStatus.OK) {
        let body = await response.json();
        user.userInfo.name = body.name;
        user.userInfo.locale = body.locale;
      }
      return user;
    } catch (error) {
      return user; // Return original user even if enrichment fails
    }
  }

  async loginUser(mobileNumber, tenantId) {

    // Sanitize mobile number for login too
    const cleanMobileNumber = this.sanitizeMobileNumber(mobileNumber) || mobileNumber;

    let data = new URLSearchParams();
    data.append('grant_type', 'password');
    data.append('scope', 'read');
    data.append('password', config.userService.userServiceHardCodedPassword);
    data.append('userType', 'CITIZEN');
    data.append('tenantId', tenantId);
    data.append('username', cleanMobileNumber);

    let headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': config.userService.userLoginAuthorizationHeader
    };

    let url = config.egovServices.userServiceHost + config.egovServices.userServiceOAuthPath;
    
    let options = {
      method: 'POST',
      headers: headers,
      body: data
    };

    try {
      let response = await fetch(url, options);

      if (response.status === 200) {
        let body = await response.json();
        return {
          authToken: body.access_token,
          refreshToken: body.refresh_token,
          userInfo: body.UserRequest
        };
      } else {
        return undefined;
      }
    } catch (error) {
      return undefined;
    }
  }

  async createUser(mobileNumber, tenantId) {
    // Validate mobile number format against the configured country/length
    const cleanMobileNumber = this.sanitizeMobileNumber(mobileNumber);
    if (!cleanMobileNumber) {
      throw new Error(`Invalid mobile number format: ${mobileNumber}. Expected ${config.mobileNumberLength} digits, optionally prefixed with ${config.countryCode}.`);
    }

    let requestBody = {
      RequestInfo: {
        apiId: "Rainmaker",
        ver: ".01",
        ts: "",
        action: "_create",
        did: "1",
        key: "",
        msgId: "20170310130900|en_IN",
        authToken: null
      },
      User: {
        otpReference: config.userService.userServiceHardCodedPassword,
        permanentCity: tenantId,
        tenantId: tenantId,
        username: cleanMobileNumber,
        mobileNumber: cleanMobileNumber,
        name: "Citizen",
        type: "CITIZEN"
      }
    };

    let url = config.egovServices.userServiceHost + config.egovServices.userServiceCreateCitizenPath;
    
    let options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    };

    try {
      let response = await fetch(url, options);
      let responseBody = await response.json();

      if (response.status === 200) {
        return responseBody;
      } else {
        throw new Error(`User creation failed with status ${response.status}`);
      }
    } catch (error) {
      throw error;
    }
  }

  // Helper method to sanitize mobile number.
  // Accepts the national number, or the same number prefixed with the country
  // code, and always returns the national form — that is what DIGIT stores as
  // the citizen's identity.
  // Example: 
  //   sanitizeMobileNumber('919876543210') => '9876543210'
  //   sanitizeMobileNumber('9876543210') => '9876543210'
  sanitizeMobileNumber(mobileNumber) {
    if (!mobileNumber) return null;

    const digitsOnly = String(mobileNumber).replace(/\D/g, '');
    const countryCode = String(config.countryCode).replace(/\D/g, '');
    const nationalLength = config.mobileNumberLength;

    if (digitsOnly.length === nationalLength) {
      return digitsOnly;
    }
    if (countryCode && digitsOnly.length === countryCode.length + nationalLength
        && digitsOnly.startsWith(countryCode)) {
      return digitsOnly.slice(countryCode.length);
    }
    return null;
  }
}

module.exports = new UserService();

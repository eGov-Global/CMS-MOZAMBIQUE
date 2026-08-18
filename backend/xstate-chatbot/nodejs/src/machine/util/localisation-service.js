const config = require('../../env-variables'),
    fetch = require('node-fetch');

class LocalisationService {

    async init() {
        this.messages = {};
        this.localeLabels = {};

        const declared = await this.fetchDeclaredLocales();
        const candidates = declared.length
            ? declared
            : config.supportedLocales.split(',').map((l) => ({ value: l.trim(), label: l.trim() }));

        const covered = [];
        for (const { value, label } of candidates) {
            const messages = await this.fetchMessagesForLocale(value, config.rootTenantId).catch(() => []);
            if (!messages || messages.length === 0) continue;

            const codeToMessages = {};
            messages.forEach((record) => { codeToMessages[record.code] = record.message; });
            this.messages[value] = codeToMessages;
            this.localeLabels[value] = label;
            covered.push(value);
        }

        this.supportedLocales = covered.length ? covered : ['en_IN'];
    }

    async fetchDeclaredLocales() {
        const url = config.egovServices.egovServicesHost + config.egovServices.mdmsSearchPath + '?tenantId=' + config.rootTenantId;
        const body = {
            RequestInfo: {},
            MdmsCriteria: {
                tenantId: config.rootTenantId,
                moduleDetails: [{ moduleName: 'common-masters', masterDetails: [{ name: 'StateInfo' }] }]
            }
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json();
            const languages = data?.MdmsRes?.['common-masters']?.StateInfo?.[0]?.languages ?? [];
            return languages.filter((language) => language?.value);
        } catch (error) {
            return [];
        }
    }

    getLocales() {
        return (this.supportedLocales || ['en_IN']).map((value) => ({
            value,
            label: (this.localeLabels || {})[value] || value
        }));
    }

    getMessageForCode(code, locale) {
        return this.messages[locale][code];
    }

    getMessageBundleForCode(code) {
        var messageBundle = {};
        for(var locale in this.messages) {
            messageBundle[locale] = this.messages[locale][code];
        }
        return messageBundle;
    }

    async getMessagesForCodesAndTenantId(codes, tenantId) {
        let messageBundle = {};
        for(let code of codes) {
            messageBundle[code] = {}
        }
        
        for(let locale of this.supportedLocales) {
            let codeToMessages = {};
            let messages = await this.fetchMessagesForLocale(locale, tenantId);
            
            messages.forEach((record, index) => {
                const code =  record['code'];
                const message = record['message'];
                codeToMessages[code] = message;
            });
            
            for(let code of codes) {
                messageBundle[code][locale] = codeToMessages[code];
            }
        }
        
        return messageBundle;
    }

    async fetchMessagesForLocale(locale, tenantId) {
        var url = config.egovServices.egovlocalizationhost + config.egovServices.localisationServiceSearchPath + '?tenantId=' + tenantId + '&locale=' + locale;
        
        var options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        }
        
        try {
            const response = await fetch(url, options);
            const data = await response.json();
            return data['messages'];
        } catch (error) {
            throw error;
        }
    }

    async getMessagesForModule(module, locale, tenantId) {
        // Fetch messages for a specific module
        var url = config.egovServices.egovlocalizationhost + config.egovServices.localisationServiceSearchPath + 
                  '?tenantId=' + tenantId + '&locale=' + locale + '&module=' + module;
        
        var requestBody = {
            RequestInfo: {
                apiId: "Rainmaker",
                msgId: Date.now() + "|" + locale,
                plainAccessRequest: {}
            }
        };
        
        var options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        }
        
        try {
            const response = await fetch(url, options);
            const data = await response.json();
            
            // Convert to a code->message map
            const messageMap = {};
            if (data['messages']) {
                data['messages'].forEach(msg => {
                    messageMap[msg.code] = msg.message;
                });
            }
            return messageMap;
        } catch (error) {
            console.error('Error fetching module messages:', error);
            return {};
        }
    }

}

const localisationService = new LocalisationService();
localisationService.init();

module.exports = localisationService;
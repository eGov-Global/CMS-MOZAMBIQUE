const { assign } = require('xstate');
const { pgrService } = require('./service/service-loader');
const dialog = require('./util/dialog');
const localisationService = require('./util/localisation-service');
const config = require('../env-variables');
const moment = require("moment-timezone");
let event;
const pgr =  {
  id: 'pgr',
  initial: 'menu',
  onEntry: assign((context, event) => {
    context.slots.pgr = {}
    context.pgr = {slots: {}};
  }),
  states: {
    menu: {
      id: 'pgrMenu',
      initial: 'question',
      states: {
        question: {
          onEntry: assign((context, event) => {
            const message = dialog.get_message(messages.menu.question, context.user.locale);
            context.grammer = grammer.menu.choice;
            dialog.sendMessage(context, message);
          }),
          on: {
            USER_MESSAGE: 'process'
          }
        },
        process: {
          onEntry: assign((context, event) => {
            if (dialog.validateInputType(event, 'text')) {
              context.intention = dialog.get_intention(context.grammer, event, true);
            } else {
              context.intention = dialog.INTENTION_UNKOWN;
            }
          }),
          always: [
            {
              target: '#fileComplaint',
              cond: (context) => context.intention == 'fileComplaint'
            },
            {
              target: '#trackComplaint',
              cond: (context) => context.intention == 'trackComplaint'
            },
            {
              target: 'error'
            }
          ]
        },
        error: {
          onEntry: assign((context, event) => {
            dialog.sendMessage(context, dialog.get_message(dialog.global_messages.error.retry, context.user.locale), false);
          }),
          always: 'question'
        }
      }
    },
    fileComplaint: {
      id: 'fileComplaint',
      initial: 'type',
      states: {
        type: {
          id: 'pgrType',
          initial: 'complaintType2Step',
          states: {
            complaintType2Step: {
              id: 'complaintType2Step',
              initial: 'question',
              states: {
                question: {
                  invoke: {
                    src: (context) => pgrService.fetchComplaintHierarchyStep(
                      context.extraInfo.tenantId,
                      context.slots.pgr.hierarchyPath || []
                    ),
                    id: 'fetchComplaintHierarchyStep',
                    onDone: {
                      actions: assign((context, event) => {
                        let { options, messageBundle, trailBundle, levelLabel, isLeafLevel } = event.data;
                        context.hierarchyIsLeafLevel = isLeafLevel;

                        let atRoot = (context.slots.pgr.hierarchyPath || []).length === 0;
                        let trail = (context.slots.pgr.hierarchyPath || [])
                          .map((code) => (trailBundle[code] ? dialog.get_message(trailBundle[code], context.user.locale) : code))
                          .join(' › ');
                        let preamble = dialog
                          .get_message(messages.fileComplaint.complaintType2Step.level.question.preamble, context.user.locale)
                          .replace('{{level}}', levelLabel);
                        if (trail) preamble = `*${trail}*\n${preamble}`;
                        let { prompt, grammer } = dialog.constructListPromptAndGrammer(
                          options, messageBundle, context.user.locale, false, !atRoot
                        );

                        context.grammer = grammer;
                        dialog.sendMessage(context, `${preamble}${prompt}`);
                      })
                    },
                    onError: {
                      target: '#system_error'
                    }
                  },
                  on: {
                    USER_MESSAGE: 'process'
                  }
                }, //question
                process: {
                  onEntry: assign((context, event) => {
                    context.intention = dialog.get_intention(context.grammer, event, true)
                  }),
                  always: [
                    {
                      target: 'question',
                      cond: (context) => context.intention == dialog.INTENTION_GOBACK,
                      actions: assign((context) => {
                        context.slots.pgr.hierarchyPath = (context.slots.pgr.hierarchyPath || []).slice(0, -1);
                      })
                    },
                    {
                      target: '#other',
                      cond: (context) => context.intention != dialog.INTENTION_UNKOWN && context.hierarchyIsLeafLevel,
                      actions: assign((context) => {
                        context.slots.pgr["complaint"] = context.intention;
                      })
                    },
                    {
                      target: 'question',
                      cond: (context) => context.intention != dialog.INTENTION_UNKOWN,
                      actions: assign((context) => {
                        context.slots.pgr.hierarchyPath = [...(context.slots.pgr.hierarchyPath || []), context.intention];
                      })
                    },
                    {
                      target: 'error'
                    }
                  ]
                }, // process
                error: {
                  onEntry: assign((context) => {
                    dialog.sendMessage(context, dialog.get_message(dialog.global_messages.error.retry, context.user.locale), false);
                  }),
                  always: 'question',
                } // error
              } // states of complaintType2Step
            }, // complaintType2Step
          }
        },
        location: {
          id: 'location',
          initial: 'boundary',
          states: {
            boundary: {
              id: 'boundary',
              initial: 'fetch',
              states: {
                fetch: {
                  invoke: {
                    src: (context) => pgrService.fetchBoundaryStep(
                      context.extraInfo.tenantId,
                      context.slots.pgr.boundaryPath || []
                    ),
                    id: 'fetchBoundaryStep',
                    onDone: {
                      target: 'evaluate',
                      actions: assign((context, event) => {
                        context.boundaryStep = event.data;
                      })
                    },
                    onError: {
                      target: '#system_error'
                    }
                  }
                },
                evaluate: {
                  always: [
                    {
                      target: '#persistComplaint',
                      cond: (context) => (context.boundaryStep.options || []).length === 0,
                      actions: assign((context) => {
                        let path = context.slots.pgr.boundaryPath || [];
                        context.slots.pgr.city = context.extraInfo.tenantId;
                        context.slots.pgr.locality = path[path.length - 1];
                      })
                    },
                    {
                      target: 'question'
                    }
                  ]
                },
                question: {
                  onEntry: assign((context) => {
                    let { options, messageBundle, levelLabel } = context.boundaryStep;
                    let atRoot = (context.slots.pgr.boundaryPath || []).length === 0;
                    let preamble = dialog
                      .get_message(messages.fileComplaint.boundary.question.preamble, context.user.locale)
                      .replace('{{level}}', levelLabel);
                    let { prompt, grammer } = dialog.constructListPromptAndGrammer(
                      options, messageBundle, context.user.locale, false, !atRoot
                    );
                    context.grammer = grammer;
                    dialog.sendMessage(context, `${preamble}${prompt}`);
                  }),
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  onEntry: assign((context, event) => {
                    context.intention = dialog.get_intention(context.grammer, event, true)
                  }),
                  always: [
                    {
                      target: 'fetch',
                      cond: (context) => context.intention == dialog.INTENTION_GOBACK,
                      actions: assign((context) => {
                        context.slots.pgr.boundaryPath = (context.slots.pgr.boundaryPath || []).slice(0, -1);
                      })
                    },
                    {
                      target: '#persistComplaint',
                      cond: (context) => context.intention != dialog.INTENTION_UNKOWN && context.boundaryStep.isLeafLevel,
                      actions: assign((context) => {
                        context.slots.pgr.boundaryPath = [...(context.slots.pgr.boundaryPath || []), context.intention];
                        context.slots.pgr.city = context.extraInfo.tenantId;
                        context.slots.pgr.locality = context.intention;
                      })
                    },
                    {
                      target: 'fetch',
                      cond: (context) => context.intention != dialog.INTENTION_UNKOWN,
                      actions: assign((context) => {
                        context.slots.pgr.boundaryPath = [...(context.slots.pgr.boundaryPath || []), context.intention];
                      })
                    },
                    {
                      target: 'error'
                    }
                  ]
                },
                error: {
                  onEntry: assign((context) => {
                    dialog.sendMessage(context, dialog.get_message(dialog.global_messages.error.retry, context.user.locale), false);
                  }),
                  always: 'question'
                }
              }
            },

            geoLocationSharingInfo: {
              id: 'geoLocationSharingInfo',
              onEntry: assign( (context, event) => {
                var message;
                if (config.enableSandboxMode) {
                  // In sandbox mode, use direct URL for location instructions
                  message = {
                    type: 'image',
                    output: config.pgrUseCase.locationInstructionsUrl
                  };
                } else {
                  // In production, use filestore ID
                  message = {
                    type: 'image',
                    output: config.pgrUseCase.informationImageFilestoreId
                  };
                }
                dialog.sendMessage(context, message);
              }),
              always: 'geoLocation'
            },
            geoLocation: {
              id: 'geoLocation',
              initial: 'question',
              states : {
                question: {
                  onEntry: assign( (context, event) => {
                    let message = dialog.get_message(messages.fileComplaint.geoLocation.question, context.user.locale)
                    dialog.sendMessage(context, message);
                  }),
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  invoke: {
                    id: 'getCityAndLocality',
                    src: (context, event) => {
                      // Add null checks for event and event.message
                      if(event && event.message && event.message.type === 'location') {
                        context.slots.pgr.geocode = event.message.input;
                        return pgrService.getCityAndLocalityForGeocode(event.message.input, context.extraInfo.tenantId);
                      }
                      if(event && event.message) {
                        context.message = event.message.input;
                      } else {
                        context.message = '1'; // Default to skip location sharing
                      }
                      return Promise.resolve();
                    },
                    onDone: [
                      {
                        target: '#confirmLocation',
                        cond: (context, event) => event.data,
                        actions: assign((context, event) => {
                          context.pgr.detectedLocation = event.data;
                        })
                      },
                      {
                        // In sandbox mode, if location was provided but city not detected, still proceed to locality selection
                        target: '#locality',
                        cond: (context, event) => !event.data && context.slots.pgr.geocode && config.enableSandboxMode,
                        actions: assign((context, event) => {
                          // Set city to organization code (tenant)
                          context.slots.pgr.city = context.extraInfo.tenantId;
                          // Location coordinates are already saved in context.slots.pgr.geocode
                        })
                      },
                      {
                        // In sandbox mode, skip city selection but go to locality selection
                        target: '#locality',
                        cond: (context, event) => !event.data && context.message ==='1' && config.enableSandboxMode,
                        actions: assign((context, event) => {
                          // Set city to organization code (tenant)
                          context.slots.pgr.city = context.extraInfo.tenantId;
                          // Don't set locality yet - let user select it
                        })
                      },
                      {
                        target: '#city',
                        cond: (context, event) => !event.data && context.message ==='1' && !config.pgrUseCase.geoSearch && !config.enableSandboxMode
                        
                      },
                      {
                        target: '#nlpCitySearch',
                        cond: (context, event) => !event.data && context.message ==='1' && config.pgrUseCase.geoSearch && !config.enableSandboxMode
                      },
                      {
                        target: '#geoLocation',
                        cond: (context, event) => !event.data && context.message !='1' && !context.slots.pgr.geocode,
                        actions: assign((context, event) => {
                          let message = dialog.get_message(dialog.global_messages.error.retry, context.user.locale);
                          dialog.sendMessage(context, message,false);
                        })
                      }
                    ],
                    onError: [
                      {
                        // In sandbox mode, go to locality selection
                        target: '#locality',
                        cond: (context, event) => config.enableSandboxMode,
                        actions: assign((context, event) => {
                          // Set city to organization code (tenant)
                          context.slots.pgr.city = context.extraInfo.tenantId;
                          // Don't set locality yet - let user select it
                        })
                      },
                      {
                        target: '#city',
                        cond: (context, event) => !config.pgrUseCase.geoSearch && !config.enableSandboxMode,

                      },
                      {
                        target: '#nlpCitySearch',
                        cond: (context, event) => config.pgrUseCase.geoSearch && !config.enableSandboxMode,
                      }

                    ],
                  },
                }
              }
            },
            confirmLocation: {
              id: 'confirmLocation',
              initial: 'question',
              states: {
                question: {
                  onEntry: assign((context, event) => {
                    let message;
                    if(context.pgr.detectedLocation.locality) {
                      let localityName = dialog.get_message(context.pgr.detectedLocation.matchedLocalityMessageBundle, context.user.locale);
                      message = dialog.get_message(messages.fileComplaint.confirmLocation.confirmCityAndLocality, context.user.locale);
                      message = message.replace('{{locality}}', localityName);
                    } else {
                      message = dialog.get_message(messages.fileComplaint.confirmLocation.confirmCity, context.user.locale);                      
                    }
                    let cityName = dialog.get_message(context.pgr.detectedLocation.matchedCityMessageBundle, context.user.locale);
                    message = message.replace('{{city}}', cityName);
                    dialog.sendMessage(context, message);
                  }),
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  onEntry: assign((context, event) => {
                    // TODO: Generalised "disagree" intention
                    if(event.message.input.trim().toLowerCase() === '1') {
                      context.slots.pgr["locationConfirmed"] = false;
                      context.message = {
                        isValid: true
                      };
                    } 
                    else if(event.message.input.trim().toLowerCase() === '2'){
                      context.slots.pgr["locationConfirmed"] = true;
                      context.slots.pgr.city = context.pgr.detectedLocation.city;
                      if(context.pgr.detectedLocation.locality) {
                        context.slots.pgr.locality = context.pgr.detectedLocation.locality;
                      }

                      context.message = {
                        isValid: true
                      };
                    }

                    else {
                      context.message = {
                        isValid: false
                      };
                    }
                  }),
                  always: [
                    {
                      target: '#persistComplaint',
                      cond: (context, event) => context.message.isValid && context.slots.pgr["locationConfirmed"]  && context.slots.pgr["locality"]
                    },
                    {
                      // In sandbox mode, go to locality selection if location not confirmed
                      target: '#locality',
                      cond: (context, event) => context.message.isValid && config.enableSandboxMode && !context.slots.pgr["locationConfirmed"],
                      actions: assign((context, event) => {
                        // Set city to organization code (tenant)
                        context.slots.pgr.city = context.extraInfo.tenantId;
                        // Don't set locality yet - let user select it
                      })
                    },
                    {
                      target: '#locality',
                      cond: (context, event) => context.message.isValid && !config.pgrUseCase.geoSearch && context.slots.pgr["locationConfirmed"] && !config.enableSandboxMode
                    },
                    {
                      target: '#nlpLocalitySearch',
                      cond: (context, event) => context.message.isValid && config.pgrUseCase.geoSearch && context.slots.pgr["locationConfirmed"] && !config.enableSandboxMode
                    },
                    {
                      target: '#city',
                      cond: (context, event) => context.message.isValid && !config.pgrUseCase.geoSearch && !config.enableSandboxMode,

                    },
                    {
                      target: '#nlpCitySearch',
                      cond: (context, event) => context.message.isValid && config.pgrUseCase.geoSearch && !config.enableSandboxMode,
                    },
                    {
                      target: 'process',
                      cond: (context, event) => {return !context.message.isValid;}                    
                    }
                  ]
                }
              }
            },
            nlpCitySearch: {
              id: 'nlpCitySearch',
              initial: 'question',
              states: {
                question: {
                  onEntry: assign((context, event) => {
                    let message = dialog.get_message(messages.fileComplaint.cityFuzzySearch.question, context.user.locale)
                    dialog.sendMessage(context, message);
                  }),
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  invoke: {
                    id: 'cityFuzzySearch',
                    src: (context, event) => {
                      try {
                        // Add null checking for event structure
                        if (event && event.message && event.message.input) {
                          return pgrService.getCity(event.message.input, context.user.locale, context.extraInfo.tenantId);
                        } else {
                          // Handle case where event.message is undefined
                          return Promise.resolve(null);
                        }
                      } catch (error) {
                        return Promise.resolve(null);
                      }
                    },
                    onDone: {
                      target: 'route',
                      cond: (context, event) => event.data,
                      actions: assign((context, event) => {
                        let {predictedCityCode, predictedCity, isCityDataMatch} = event.data;
                        context.slots.pgr["predictedCityCode"] = predictedCityCode;
                        context.slots.pgr["predictedCity"] = predictedCity;
                        context.slots.pgr["isCityDataMatch"] = isCityDataMatch;
                        context.slots.pgr["city"] = predictedCityCode;
                      })
                    }, 
                    onError: {
                      target: '#system_error'
                    }

                  },
                },
                route:{
                  onEntry: assign((context, event) => {
                  }),
                  always: [
                    {
                      target: '#nlpLocalitySearch',
                      cond: (context) => context.slots.pgr["isCityDataMatch"] && context.slots.pgr["predictedCity"] != null && context.slots.pgr["predictedCityCode"] != null
                    },
                    {
                      target: '#confirmationFuzzyCitySearch',
                      cond: (context) => !context.slots.pgr["isCityDataMatch"] && context.slots.pgr["predictedCity"] != null && context.slots.pgr["predictedCityCode"] != null
                    },
                    {
                      target: '#nlpCitySearch',
                      cond: (context) => !context.slots.pgr["isCityDataMatch"] && context.slots.pgr["predictedCity"] == null && context.slots.pgr["predictedCityCode"] == null,
                      actions: assign((context, event) => {
                        let message = dialog.get_message(messages.fileComplaint.cityFuzzySearch.noRecord, context.user.locale)
                        dialog.sendMessage(context, message);
                      })

                    }
                  ]

                },
                confirmationFuzzyCitySearch:{
                  id: 'confirmationFuzzyCitySearch',
                  initial: 'question',
                  states:{
                    question: {
                      onEntry: assign((context, event) => {
                        let message = dialog.get_message(messages.fileComplaint.cityFuzzySearch.confirmation, context.user.locale);
                        message = message.replace('{{city}}',context.slots.pgr["predictedCity"]);
                        dialog.sendMessage(context, message);
                      }),
                      on: {
                        USER_MESSAGE: 'process'
                      }
                    },
                    process: {
                      onEntry: assign((context, event) => {
                        if(dialog.validateInputType(event, 'text'))
                          context.intention = dialog.get_intention(grammer.confirmation.choice, event, true);
                        else
                          context.intention = dialog.INTENTION_UNKOWN;
                      }),
                      always: [
                        {
                          target: '#nlpLocalitySearch',
                          cond: (context) => context.intention == 'Yes'
                        },
                        {
                          target: '#nlpCitySearch',
                          cond: (context) => context.intention == 'No',
                        },
                        {
                          target: 'error',
                        }
                      ]
                    },
                    error: {
                      onEntry: assign((context, event) => {
                        let message = dialog.get_message(dialog.global_messages.error.retry, context.user.locale);
                        dialog.sendMessage(context, message, false);
                      }),
                      always: 'question'
                    }

                  }

                }
              }  
            },
            nlpLocalitySearch: {
              id: 'nlpLocalitySearch',
              initial: 'question',
              states: {
                question: {
                  onEntry: assign((context, event) => {
                    let message = dialog.get_message(messages.fileComplaint.localityFuzzySearch.question, context.user.locale)
                    dialog.sendMessage(context, message);
                  }),
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  invoke: {
                    id: 'localityFuzzySearch',
                    src: (context, event) => {
                      try {
                        // Add null checking for event structure
                        if (event && event.message && event.message.input) {
                          return pgrService.getLocality(event.message.input, context.slots.pgr["city"], context.user.locale, context.extraInfo.tenantId, context.user);
                        } else {
                          // Handle case where event.message is undefined
                          return Promise.resolve(null);
                        }
                      } catch (error) {
                        return Promise.resolve(null);
                      }
                    },
                    onDone: {
                      target: 'route',
                      cond: (context, event) => event.data,
                      actions: assign((context, event) => {
                        let {predictedLocalityCode, predictedLocality, isLocalityDataMatch} = event.data;
                        context.slots.pgr["predictedLocalityCode"] = predictedLocalityCode;
                        context.slots.pgr["predictedLocality"] = predictedLocality;
                        context.slots.pgr["isLocalityDataMatch"] = isLocalityDataMatch;
                        context.slots.pgr["locality"] = predictedLocalityCode;
                      })
                    }, 
                    onError: {
                      target: '#system_error'
                    }
                  },
                },
                route:{
                  onEntry: assign((context, event) => {
                  }),
                  always: [
                    {
                      target: '#persistComplaint',
                      cond: (context) => context.slots.pgr["isLocalityDataMatch"] && context.slots.pgr["predictedLocality"] != null && context.slots.pgr["predictedLocalityCode"] != null
                    },
                    {
                      target: '#confirmationFuzzyLocalitySearch',
                      cond: (context) => !context.slots.pgr["isLocalityDataMatch"] && context.slots.pgr["predictedLocality"] != null && context.slots.pgr["predictedLocalityCode"] != null
                    },
                    {
                      target: '#nlpLocalitySearch',
                      cond: (context) => !context.slots.pgr["isLocalityDataMatch"] && context.slots.pgr["predictedLocality"] == null && context.slots.pgr["predictedLocalityCode"] == null,
                      actions: assign((context, event) => {
                        let message = dialog.get_message(messages.fileComplaint.localityFuzzySearch.noRecord, context.user.locale)
                        dialog.sendMessage(context, message);
                      })

                    }
                  ]

                },
                confirmationFuzzyLocalitySearch:{
                  id: 'confirmationFuzzyLocalitySearch',
                  initial: 'question',
                  states:{
                    question: {
                      onEntry: assign((context, event) => {
                        let message = dialog.get_message(messages.fileComplaint.localityFuzzySearch.confirmation, context.user.locale);
                        message = message.replace('{{locality}}',context.slots.pgr["predictedLocality"]);
                        dialog.sendMessage(context, message);
                      }),
                      on: {
                        USER_MESSAGE: 'process'
                      }
                    },
                    process: {
                      onEntry: assign((context, event) => {
                        if(dialog.validateInputType(event, 'text'))
                          context.intention = dialog.get_intention(grammer.confirmation.choice, event, true);
                        else
                          context.intention = dialog.INTENTION_UNKOWN;
                      }),
                      always: [
                        {
                          target: '#persistComplaint',
                          cond: (context) => context.intention == 'Yes'
                        },
                        {
                          target: '#nlpLocalitySearch',
                          cond: (context) => context.intention == 'No',
                        },
                        {
                          target: 'error',
                        }
                      ]
                    },
                    error: {
                      onEntry: assign((context, event) => {
                        let message = dialog.get_message(dialog.global_messages.error.retry, context.user.locale);
                        dialog.sendMessage(context, message, false);
                      }),
                      always: 'question'
                    }

                  }

                }
              }
            },
            city: {
              id: 'city',
              onEntry: assign((context, event) => {
              }),
              initial: 'question',
              states: {
                question: {
                  invoke: {
                    id: 'pgrFetchCities',
                    src: (context, event) => pgrService.fetchCitiesAndWebpageLink(context.extraInfo.tenantId,context.extraInfo.whatsAppBusinessNumber),
                    onDone: {
                      actions: assign((context, event) => {
                        let { cities, messageBundle } = event.data;
                        let preamble = dialog.get_message(messages.fileComplaint.city.question.preamble, context.user.locale);
                        let {prompt, grammer} = dialog.constructListPromptAndGrammer(cities, messageBundle, context.user.locale);
                        context.grammer = grammer;
                        dialog.sendMessage(context, `${preamble}${prompt}`);
                      })
                    },
                    onError: {
                      target: '#system_error'
                    }
                  },
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  onEntry:  assign((context, event) => {
                    context.intention = dialog.get_intention(context.grammer, event) 
                  }),
                  always : [
                    {
                      target: '#locality',
                      cond: (context) => context.intention != dialog.INTENTION_UNKOWN,
                      actions: assign((context, event) => context.slots.pgr["city"] = context.intention)    
                    },
                    {
                      target: 'error',
                    }, 
                  ]
                },
                error: {
                  onEntry: assign( (context, event) => {
                    dialog.sendMessage(context, dialog.get_message(dialog.global_messages.error.retry, context.user.locale), false);
                  }),
                  always:  'question',
                }
              }
            },
            locality: {
              id: 'locality',
              initial: 'question',
              states: {
                question: {
                  invoke: {
                    id: 'pgrFetchLocalities',
                    src: (context) => pgrService.fetchLocalitiesAndWebpageLink(context.slots.pgr.city, context.extraInfo.whatsAppBusinessNumber, context.user),
                    onDone: {
                      actions: assign((context, event) => {
                        let { localities, messageBundle } = event.data;
                        let preamble = dialog.get_message(messages.fileComplaint.locality.question.preamble, context.user.locale);
                        let {prompt, grammer} = dialog.constructListPromptAndGrammer(localities, messageBundle, context.user.locale);
                        context.grammer = grammer;
                        dialog.sendMessage(context, `${preamble}${prompt}`);
                      })
                    },
                    onError: {
                      target: '#system_error'
                    }
                  },
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  onEntry:  assign((context, event) => {
                    context.intention = dialog.get_intention(context.grammer, event) 
                  }),
                  always : [
                    {
                      target: '#persistComplaint',
                      cond: (context) => context.intention != dialog.INTENTION_UNKOWN,
                      actions: assign((context, event) => context.slots.pgr["locality"] = context.intention)
                    },
                    {
                      target: 'error',
                    }, 
                  ]
                },
                error: {
                  onEntry: assign( (context, event) => {
                    dialog.sendMessage(context, dialog.get_message(dialog.global_messages.error.retry, context.user.locale), false);
                  }),
                  always:  'question',
                }
              }
            },
            landmark: {
              // come here when user 1) did not provide geolocation or 2) did not confirm geolocation - either because google maps got it wrong or if there was a google api error 

            }
          }
        },
        other: {
          // get other info
          id: 'other',
          initial: 'description',
          states: {
            description: {
              id: 'description',
              initial: 'question',
              states: {
                question: {
                  onEntry: assign((context, event) => {
                    let message = dialog.get_message(messages.fileComplaint.description.question, context.user.locale)
                      .replace('{{minLength}}', config.descriptionMinLength);
                    dialog.sendMessage(context, message);
                  }),
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  onEntry: assign((context, event) => {
                    if (!dialog.validateInputType(event, 'text')) {
                      context.message = { isValid: false, isText: false };
                      return;
                    }
                    let description = String(event.message.input).trim();
                    context.message = {
                      isValid: description.length >= config.descriptionMinLength,
                      isText: true
                    };
                    if (context.message.isValid) {
                      context.slots.pgr.description = description;
                    }
                  }),
                  always: [
                    {
                      target: 'error',
                      cond: (context) => !context.message.isValid
                    },
                    {
                      target: '#imageUpload',
                      cond: (context) => context.message.isValid
                    }
                  ]
                },
                error: {
                  onEntry: assign((context) => {
                    let message = context.message.isText
                      ? dialog.get_message(messages.fileComplaint.description.tooShort, context.user.locale)
                          .replace('{{minLength}}', config.descriptionMinLength)
                      : dialog.get_message(dialog.global_messages.error.retry, context.user.locale);
                    dialog.sendMessage(context, message, false);
                  }),
                  always: 'question'
                }
              }
            },
            imageUpload: {
              id: 'imageUpload',
              initial: 'question',
              states: {
                question: {
                  onEntry: assign((context, event) => {
                    let message = dialog.get_message(messages.fileComplaint.imageUpload.question, context.user.locale);
                    dialog.sendMessage(context, message);
                  }),
                  on: {
                    USER_MESSAGE: 'process'
                  }
                },
                process: {
                  onEntry: assign((context, event) => {
                    if(dialog.validateInputType(event, ['image', 'document'])) {
                      context.slots.pgr.image = event.message.input;
                      context.message = {
                        isValid: true
                      };
                    }
                    else{
                      let parsed = event.message.input;
                      let isValid = (parsed === "1");
                      context.message = {
                        isValid: isValid,
                        messageContent: event.message.input
                      };
                    }
                  }),
                  always:[
                    {
                      target: 'error',
                      cond: (context, event) => {
                        return ! context.message.isValid;
                      }
                    },
                    {
                      target: '#location',
                      cond: (context, event) => {
                        return context.message.isValid;
                      }
                    }
                  ] 
                },
                error: {
                  onEntry: assign( (context, event) => {
                    let message = dialog.get_message(dialog.global_messages.error.retry, context.user.locale);
                    dialog.sendMessage(context, message, false);
                  }),
                  always : 'question'
                }
              }
            }
          }
        },
        persistComplaint: {
          id: 'persistComplaint',
          invoke: {
            id: 'persistComplaint',
            src: (context) => pgrService.persistComplaint(context.user,context.slots.pgr,context.extraInfo),
            onDone: {
              target: '#endstate',
              actions: assign((context, event) => {
                let templateList;
                let complaintDetails = event.data;
                let message = dialog.get_message(messages.fileComplaint.persistComplaint, context.user.locale);
                
                // Add null checks for complaintDetails
                if (complaintDetails && complaintDetails.complaintNumber) {
                  message = message.replace('{{complaintNumber}}', complaintDetails.complaintNumber);
                } else {
                  message = message.replace('{{complaintNumber}}', 'N/A');
                }
                
                if (complaintDetails && complaintDetails.complaintLink) {
                  message = message.replace('{{complaintLink}}', complaintDetails.complaintLink);
                } else {
                  message = message.replace('{{complaintLink}}', '#');
                }
                
                let closingStatement = dialog.get_message(messages.fileComplaint.closingStatement, context.user.locale);
                message = message + closingStatement;
                dialog.sendMessage(context, message);
              //  let localeList = config.supportedLocales.split(',');
               // let localeIndex = localeList.indexOf(context.user.locale);
               // templateList =  config.valueFirstWhatsAppProvider.valuefirstNotificationLodgeCompliantTemplateid.split(',');
                
               // if(templateList[localeIndex])
                //  context.extraInfo.templateId = templateList[localeIndex];
               // else
                //  context.extraInfo.templateId = templateList[0];

                //let params=[];
                //params.push(complaintDetails.complaintNumber);

                //let urlComponemt = complaintDetails.complaintLink.split('/');
                //let bttnUrlComponent = urlComponemt[urlComponemt.length -1];

               // var templateContent = {
                //  output: context.extraInfo.templateId,
                 // type: "template",
                 // params: params,
                 // bttnUrlComponent: bttnUrlComponent
               // };

               // dialog.sendMessage(context, templateContent, true);
              })
            }
          }
        },
      }, // fileComplaint.states
    },  // fileComplaint
    trackComplaint: {
      id: 'trackComplaint',
      invoke: {
        id: 'fetchOpenComplaints',
        src: (context) => pgrService.fetchOpenComplaints(context.user, context.extraInfo),
        onDone: [
          {
            target: '#endstate',
            cond: (context, event) => Array.isArray(event.data) && event.data.length > 0,
            actions: assign((context, event) => {
              let message = dialog.get_message(messages.trackComplaint.results.preamble, context.user.locale);
              const complaints = event.data;
              for (const complaint of complaints) {
                let complaintMessage = dialog.get_message(
                  messages.trackComplaint.results.complaintTemplate,
                  context.user.locale
                );
                complaintMessage = complaintMessage
                  .replace('{{complaintType}}', complaint.complaintType || 'Complaint')
                  .replace('{{complaintNumber}}', complaint.complaintNumber || 'N/A')
                  .replace('{{filedDate}}', complaint.filedDate || 'N/A')
                  .replace('{{complaintStatus}}', complaint.complaintStatus || 'N/A');
                message += `\n\n${complaintMessage}`;
              }
              message += dialog.get_message(messages.trackComplaint.results.closingStatement, context.user.locale);
              dialog.sendMessage(context, message);
            })
          },
          {
            target: '#endstate',
            actions: assign((context, event) => {
              const message = dialog.get_message(messages.trackComplaint.noRecords, context.user.locale);
              dialog.sendMessage(context, message);
            })
          }
        ],
        onError: {
          target: '#system_error'
        }
      }
    }
  } // pgr.states
}; // pgr

let messages = {
  menu: {
    question: {
      en_IN: 'Please type and send the number for your option 👇\n\n*1.* File a new complaint\n*2.* Track existing complaints\n\n👉 To go back to the main menu, type and send *egov*.',
      hi_IN: 'कृपया अपने विकल्प के लिए नंबर टाइप करें और भेजें 👇\n\n*1.* नई शिकायत दर्ज करें\n*2.* पुरानी शिकायतों की स्थिति देखें\n\n👉 मुख्य मेनू पर वापस जाने के लिए, टाइप करें और भेजें *egov*।'
    }
  },
  fileComplaint: {
    complaintType2Step: {
      level: {
        question: {
          preamble: {
            en_IN : 'Please type and send the number to select a {{level}} from the list below 👇\n',
            hi_IN : 'नीचे दी गई सूची से {{level}} चुनने के लिए विकल्प संख्या टाइप करें और भेजें 👇'
          }
        }
      },
    }, // complaintType2Step
    boundary: {
      question: {
        preamble: {
          en_IN: 'Please type and send the number to select the {{level}} for your grievance 👇\n',
          hi_IN: 'कृपया अपनी शिकायत के लिए {{level}} का विकल्प संख्या टाइप करें और भेजें 👇\n'
        }
      }
    },
    geoLocation: {
      question: {
        en_IN :'Please share your location if you are at the grievance site.\n\n👉  Refer the image below to understand steps for sharing the location.\n\n👉  To continue without sharing the location, type and send  *1*.',
        hi_IN : 'यदि आप शिकायत स्थल पर हैं तो कृपया अपना स्थान साझा करें।\n\n👉 स्थान साझा करने के चरणों को समझने के लिए नीचे दी गई छवि देखें।\n\n👉 स्थान साझा किए बिना जारी रखने के लिए, टाइप करें और 1 भेजें।',
        pa_IN : 'ਜੇ ਤੁਸੀਂ ਸ਼ਿਕਾਇਤ ਵਾਲੀ ਥਾਂ ਤੇ ਹੋ ਤਾਂ ਕਿਰਪਾ ਕਰਕੇ ਆਪਣਾ ਸਥਾਨ ਸਾਂਝਾ ਕਰੋ.\n\n👉 ਸਥਾਨ ਨੂੰ ਸਾਂਝਾ ਕਰਨ ਦੇ ਕਦਮਾਂ ਨੂੰ ਸਮਝਣ ਲਈ ਹੇਠ ਦਿੱਤੇ ਚਿੱਤਰ ਨੂੰ ਵੇਖੋ.\n\n👉 ਨਿਰਧਾਰਤ ਸਥਾਨ ਸਾਂਝਾ ਕੀਤੇ ਬਗੈਰ ਜਾਰੀ ਰੱਖਣ ਲਈ, 1 ਲਿਖੋ ਅਤੇ ਭੇਜੋ.'
      }
    }, // geoLocation 
    confirmLocation: {
      confirmCityAndLocality: {
        en_IN: 'Is this the correct location of the complaint?\nCity: {{city}}\nLocality: {{locality}}\n\nType and send *1* if it is incorrect\nElse, type and send *2* to confirm and proceed',
        hi_IN: 'क्या यह शिकायत का सही स्थान है?\शहर: {{city}}\स्थान: {{locality}}\n\nटाइप करें और 1 भेजें यदि यह गलत है\nअन्यथा, पुष्टि करने और आगे बढ़ने के लिए 2 टाइप करें और भेजें',
        pa_IN: 'ਕੀ ਇਹ ਸ਼ਿਕਾਇਤ ਦਾ ਸਹੀ ਸਥਾਨ ਹੈ?\ਸ਼ਹਿਰ: {{city}}\ਸਥਾਨ: {{locality}}\n\nਟਾਈਪ ਕਰੋ ਅਤੇ 1 ਭੇਜੋ ਜੇ ਇਹ ਗਲਤ ਹੈ\nਹੋਰ, ਪੁਸ਼ਟੀ ਕਰਨ ਅਤੇ ਅੱਗੇ ਵਧਣ ਲਈ ਟਾਈਪ ਕਰੋ ਅਤੇ 2 ਭੇਜੋ'
      },
      confirmCity: {
        en_IN: 'Is this the correct location of the complaint?\nCity: {{city}}\n\nType and send *1* if it is incorrect\nElse, type and send *2* to confirm and proceed',
        hi_IN: 'क्या यह शिकायत का सही स्थान है? \nशहर: {{city}}\n अगर यह गलत है तो कृपया "No" भेजें।\nअन्यथा किसी भी चरित्र को टाइप करें और आगे बढ़ने के लिए भेजें।'
      }
    },
    city: {
      question: {
        preamble: {
          en_IN: 'Please type and send the number to select your city from the list below 👇\n',
          hi_IN: 'नीचे दी गई सूची से अपने शहर का चयन करने के लिए विकल्प संख्या टाइप करें और भेजें 👇\n'
        }
      }
    }, // city
    locality: {
      question: {
        preamble: {
          en_IN: 'Please type and send the number to select your locality from the list below 👇\n',
          hi_IN: 'नीचे दी गई सूची से अपने इलाके का चयन करने के लिए विकल्प संख्या टाइप करें और भेजें 👇\n'
        }
      }
    }, // locality
    description: {
      question: {
        en_IN: 'Please describe your grievance in one message, using at least {{minLength}} characters.',
        hi_IN: 'कृपया अपनी शिकायत एक संदेश में लिखें, कम से कम {{minLength}} अक्षरों का प्रयोग करें।'
      },
      tooShort: {
        en_IN: 'That description is too short. Please describe your grievance in at least {{minLength}} characters, in a single message.',
        hi_IN: 'यह विवरण बहुत छोटा है। कृपया एक ही संदेश में कम से कम {{minLength}} अक्षरों में अपनी शिकायत लिखें।'
      }
    },
    imageUpload: {
      question: {
        en_IN: 'If possible, attach a photo or document of your grievance.\n\nTo continue without attaching, type and send *1*',
        hi_IN: 'यदि संभव हो तो अपनी शिकायत का फोटो संलग्न करें।\n\nफोटो के बिना जारी रखने के लिए, टाइप करें और 1 भेजें',
        pa_IN: ' ਨਾਮ ਦੀ ਪੁਸ਼ਟੀ ਕਰਨ ਲਈ 1 ਟਾਈਪ ਕਰੋ ਅਤੇ ਭੇਜੋ'
      },
      error:{
        en_IN : 'Sorry, I didn\'t understand',
        hi_IN: 'क्षमा करें, मुझे समझ नहीं आया ।',
      }
    },
    persistComplaint: {
      en_IN: 'Thank You 😃 Your complaint is registered successfully with eGov.\n\nThe Complaint No is : *{{complaintNumber}}*\n\nClick on the link below to view and track your complaint:\n{{complaintLink}}\n',
      hi_IN: 'धन्यवाद 😃 आपकी शिकायत eGov के साथ सफलतापूर्वक दर्ज हो गई है।\nशिकायत संख्या है: {{complaintNumber}}\n अपनी शिकायत देखने और ट्रैक करने के लिए नीचे दिए गए लिंक पर क्लिक करें:\n {{complaintLink}}\n',
      pa_IN: 'ਧੰਨਵਾਦ 😃 ਤੁਹਾਡੀ ਸ਼ਿਕਾਇਤ eGov ਨਾਲ ਸਫਲਤਾਪੂਰਵਕ ਰਜਿਸਟਰ ਹੋਈ ਹੈ.\nਸ਼ਿਕਾਇਤ ਨੰਬਰ ਹੈ: {{complaintNumber}}\n ਆਪਣੀ ਸ਼ਿਕਾਇਤ ਨੂੰ ਵੇਖਣ ਅਤੇ ਟਰੈਕ ਕਰਨ ਲਈ ਹੇਠਾਂ ਦਿੱਤੇ ਲਿੰਕ ਤੇ ਕਲਿੱਕ ਕਰੋ:\n {{complaintLink}}\n'
    },
    closingStatement: {
      en_IN: '\nIn case of any help please type and send "egov"',
      hi_IN: '\nकिसी भी मदद के मामले में कृपया "egov" टाइप करें और भेजें',
      pa_IN: '\nਕਿਸੇ ਵੀ ਮਦਦ ਦੀ ਸਥਿਤੀ ਵਿੱਚ, ਕਿਰਪਾ ਕਰਕੇ ਟਾਈਪ ਕਰੋ ਅਤੇ ਭੇਜੋ'
    },
    cityFuzzySearch: {
      question: {
        en_IN: "Enter the name of your city.\n\n(For example - CityA)",
        hi_IN: "अपने शहर का नाम दर्ज करें। (उदाहरण के लिए - CityA)",
        pa_IN: "ਆਪਣੇ ਸ਼ਹਿਰ ਦਾ ਨਾਮ ਦਰਜ ਕਰੋ. (ਉਦਾਹਰਣ ਵਜੋਂ - CityA)"
      },
      confirmation: {
        en_IN: "Did you mean *“{{city}}”* ?\n\n👉  Type and send *1* to confirm.\n\n👉  Type and send *2* to write again.",
        hi_IN: "क्या आपका मतलब *“{{city}}”* से था ?\n\n👉 टाइप करें और पुष्टि करने के लिए 1 भेजें।\n\n👉 टाइप करें और फिर से लिखने के लिए 2 भेजें।",
        pa_IN: "ਕੀ ਤੁਹਾਡਾ ਮਤਲਬ *“{{city}}”* ਹੈ ?\n\n👉 ਪੁਸ਼ਟੀ ਕਰਨ ਲਈ 1 ਲਿਖੋ ਅਤੇ ਭੇਜੋ.\n\n👉 ਟਾਈਪ ਕਰੋ ਅਤੇ ਦੁਬਾਰਾ ਲਿਖਣ ਲਈ 2 ਭੇਜੋ."
      },
      noRecord:{
        en_IN: 'Provided city is miss-spelled or not present in our system record.\nPlease enter the details again.',
        hi_IN: 'आपके द्वारा दर्ज किया गया शहर गलत वर्तनी वाला है या हमारे सिस्टम रिकॉर्ड में मौजूद नहीं है।\nकृपया फिर से विवरण दर्ज करें।'
      }
    },
    localityFuzzySearch: {
      question: {
        en_IN: "Enter the name of your locality.\n\n(For example - Evergreen Park)",
        hi_IN: "अपने इलाके का नाम दर्ज करें। (उदाहरण के लिए - Evergreen Park)",
        pa_IN: "ਆਪਣੇ ਸਥਾਨ ਦਾ ਨਾਮ ਦਰਜ ਕਰੋ. (ਉਦਾਹਰਣ ਵਜੋਂ - Evergreen Park)"
      },
      confirmation: {
        en_IN: "Did you mean *“{{locality}}”* ?\n\n👉  Type and send *1* to confirm.\n\n👉  Type and send *2* to write again.",
        hi_IN: "क्या आपका मतलब *“{{locality}}”* से था ?\n\n👉 टाइप करें और पुष्टि करने के लिए 1 भेजें।\n\n👉 टाइप करें और फिर से लिखने के लिए 2 भेजें।",
        pa_IN: "ਕੀ ਤੁਹਾਡਾ ਮਤਲਬ *“{{locality}}”* ਹੈ ?\n\n👉 ਪੁਸ਼ਟੀ ਕਰਨ ਲਈ 1 ਲਿਖੋ ਅਤੇ ਭੇਜੋ.\n\n👉 ਟਾਈਪ ਕਰੋ ਅਤੇ ਦੁਬਾਰਾ ਲਿਖਣ ਲਈ 2 ਭੇਜੋ."      
      },
      noRecord:{
        en_IN: 'Provided locality is miss-spelled or not present in our system record.\nPlease enter the details again.',
        hi_IN: 'आपके द्वारा दर्ज किया गया स्थान गलत वर्तनी वाला है या हमारे सिस्टम रिकॉर्ड में मौजूद नहीं है।\nकृपया फिर से विवरण दर्ज करें।'
      }
    }
  },
  trackComplaint: {
    results: {
      preamble: {
        en_IN: 'Here are your recent complaints 👇',
        hi_IN: 'यहां आपकी हाल की शिकायतें हैं 👇'
      },
      complaintTemplate: {
        en_IN: '*{{complaintType}}*\n\nComplaint No: {{complaintNumber}}\nFiled Date: {{filedDate}}\nStatus: *{{complaintStatus}}*',
        hi_IN: '*{{complaintType}}*\n\nशिकायत संख्या: {{complaintNumber}}\nदायर तिथि: {{filedDate}}\nस्थिति: *{{complaintStatus}}*'
      },
      closingStatement: {
        en_IN: '\n\n👉 To go back to the main menu, type and send *egov*.',
        hi_IN: '\n\n👉 मुख्य मेनू पर वापस जाने के लिए, टाइप करें और भेजें *egov*।'
      }
    },
    noRecords: {
      en_IN: 'No complaint records were found for your account.\n\n👉 To go back to the main menu, type and send *egov*.',
      hi_IN: 'आपके खाते के लिए कोई शिकायत रिकॉर्ड नहीं मिला।\n\n👉 मुख्य मेनू पर वापस जाने के लिए, टाइप करें और भेजें *egov*।'
    }
  }
}; // messages

let grammer = {
  menu: {
    choice: [
      { intention: 'fileComplaint', recognize: ['1'] },
      { intention: 'trackComplaint', recognize: ['2'] }
    ]
  },
  confirmation: {
    choice: [
      {intention: 'Yes', recognize: ['1',]},
      {intention: 'No', recognize: ['2']}
    ]
  }
};
module.exports = pgr;

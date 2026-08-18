const INTENTION_UNKOWN = 'INTENTION_UKNOWN';
const INTENTION_MORE = 'more';
const INTENTION_GOBACK = 'goback';

function get_input(event, scrub = true) {
  const input = event?.message?.input;

  if (typeof input !== 'string') {
      throw new TypeError('Invalid input: event.message.input must be a string.');
    return '';
  }

  return scrub ? input.trim().toLowerCase() : input;
}
function get_message(bundle, locale = 'en_IN') {
  return (bundle[locale] === undefined)? bundle['en_IN'] : bundle[locale];
}
function get_intention(g, event, strict = false) {
  let utterance = get_input(event);
  function exact(e) {
    return e.recognize.includes(utterance)
  }
  function contains(e) {
    return e.recognize.find(r=>utterance.includes(r))
  }
  let index = strict? g.findIndex(exact) : g.findIndex(e=>contains(e));
  return (index == -1) ? INTENTION_UNKOWN : g[index].intention;
}
function constructListPromptAndGrammer(keys, message_bundle, locale, more = false, goback = false) {
  var prompt = '';
  var grammer = [];
  if (more) {
    keys = keys.concat([INTENTION_MORE])
    message_bundle = Object.assign({}, message_bundle, {[INTENTION_MORE]: global_messages.more})
  }
  if (goback) {
    keys = keys.concat([INTENTION_GOBACK])
    message_bundle = Object.assign({}, message_bundle, {[INTENTION_GOBACK]: global_messages.goback})
  }
  
  keys.forEach((element, index) => {
    let value = undefined;
    if(message_bundle[element] !== undefined) {
      value = get_message(message_bundle[element], locale);
    }
    if (value === undefined) {
      value = element;
    }
    var numberAsString = (index+1).toString();
    if(numberAsString.length ===1)
      prompt+= `\n*${index+1}.*  ` + value;
    else
      prompt+= `\n*${index+1}.* ` + value;

    grammer.push({intention: element, recognize: [(index+1).toString()]});
  });
  return {prompt, grammer};
}

function constructLiteralGrammer(keys, message_bundle, locale) {
  var grammer = [];
  keys.forEach((element) => {
    let value = undefined;
    if (message_bundle[element] !== undefined) {
      value = get_message(message_bundle[element], locale);
    } 
    if(value === undefined) {
      value = element;
    }
    grammer.push({intention: element, recognize: [value.toLowerCase()]});
  });
  return grammer;
}

function validateInputType(event, type) {
  let inputType = event.message.type;
  return Array.isArray(type) ? type.includes(inputType) : inputType === type;
}

function sendMessage(context, message, immediate = true) {
  if(!context.output) {
    context.output = [];
  }
  context.output.push(message);
  if(immediate) {
    context.chatInterface.toUser(context.user, context.output, context.extraInfo);
    context.output = [];
  }
}

let global_messages = {
  error: {
    retry: {
      en_IN: 'Selected option seems to be invalid 😐\n\nPlease select the valid option to proceed further.',
      hi_IN: 'चयनित विकल्प अमान्य प्रतीत होता है 😐\n\n कृपया आगे बढ़ने के लिए वैध विकल्प का चयन करें।'
    },
    proceeding: {
      en_IN: 'I am sorry, I didn\'t understand. But proceeding nonetheless',
      hi_IN: 'मुझे क्षमा करें, मुझे समझ नहीं आया। फिर भी आगे बढ़ें।'
    }
  },
  image_error: {
    retry: {
      en_IN: 'Sent Image Does Not Contain Location 😐\n\nPlease attach the valid Image to proceed further.',
      hi_IN: 'भेजी गई छवि में स्थान की जानकारी नहीं है 😐\n\n कृपया आगे बढ़ने के लिए एक मान्य छवि संलग्न करें।'
    },
  },
  system_error: {
    en_IN: 'I am sorry, our system has a problem and I cannot fulfill your request right now. Could you try again in a few minutes please?',
    hi_IN: 'हमारे सिस्टम में एक समस्या है। मैं अभी तुम्हारी मदद नहीं कर सकता, क्या आप कुछ मिनटों में फिर से कोशिश कर सकते हैं?'
  },
  [INTENTION_MORE]: {
    en_IN : "See more ...",
    hi_IN : "और देखें ..."
  },
  [INTENTION_GOBACK]: {
    en_IN : 'Go Back',
    hi_IN : 'पीछे जाना'
  },
}

module.exports = { get_input, get_message, get_intention, INTENTION_UNKOWN, INTENTION_MORE, INTENTION_GOBACK, global_messages, constructListPromptAndGrammer, constructLiteralGrammer, validateInputType, sendMessage };

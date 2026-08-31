const dialog = require("./dialog.js");

const GREETING_WORDS = ['hi', 'hello', 'hey', 'start', 'help', 'egov'];
const MESSAGE_TYPES = ['text', 'image', 'document', 'location'];
const RESET_GRAMMAR = [
  {
    intention: "reset",
    recognize: ["Hello", "hello", "Hi", "hi", "egov", "start", "Start", "help", "Help"],
  },
];

class InboundMessage {
  constructor(message) {
    this.input = message.input;
    this.type = message.type;
  }

  static create(message) {
    if (!MESSAGE_TYPES.includes(message.type)) {
      throw new Error("InboundMessageHandler: invalid message type");
    }
    return new InboundMessage(message);
  }

  isUserMessage() {
    return !!this.input && this.input.trim().length > 0;
  }

  isGreeting() {
    return GREETING_WORDS.includes(this.input.trim().toLowerCase());
  }

  isReset() {
    return dialog.get_intention(RESET_GRAMMAR, { message: { input: this.input } }, true) === 'reset';
  }

  getInputMessage() {
    return this.input?.trim();
  }
}

module.exports = InboundMessage;

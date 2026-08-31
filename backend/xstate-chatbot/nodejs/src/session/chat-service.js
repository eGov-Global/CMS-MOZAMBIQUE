const stateMachine = require("../machine/state-machine");
const { State, interpret } = require("xstate");
const chatStateRepository = require("./repo");
const ChatState = require("./chat-state");
const telemetry = require("./telemetry");
const uuid = require("uuid");
const config = require("../env-variables");

class ChatService {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  // Use user.userId (KeyCloak UUID) as the session storage key in both sandbox
  // and normal mode. This matches the legacy normal flow and keeps onTransition's
  // updateState (which keys by state.context.user.userId) in sync with insertNewState.
  async dispatch(session, inboundRequestModel) {
    const sessionUserId = session.userId;

    await chatStateRepository.updateSessionId(sessionUserId, config.avgSessionTime);
    telemetry.log(sessionUserId, "from_user", inboundRequestModel);

    const chatState = await this.getOrCreateChatState(sessionUserId, session.user);
    const stateMachineService = this.getStateMachineServiceFor(chatState, inboundRequestModel);

    const event = inboundRequestModel.getMessage().isReset() ? "USER_RESET" : "USER_MESSAGE";
    stateMachineService.send(event, inboundRequestModel);
  }

  /**
   * Retrieves the active chat state for the given user. If no active state exists,
   * a new chat state is created, persisted, and returned.
   */
  async getOrCreateChatState(sessionUserId, user) {
    const existingState = await chatStateRepository.getActiveStateForUserId(sessionUserId);
    if (existingState) {
      return existingState;
    }

    // come here if virgin dialog, old dialog was inactive, or reset case
    const chatState = this.createChatStateFor(user);
    const sessionId = uuid.v4();
    await chatStateRepository.insertNewState(
      sessionUserId,
      true,
      chatState.toPersistableState().state,
      sessionId,
      new Date().getTime()
    );
    return chatState;
  }

  /**
   * Retrieves the state machine service for the given chat state and reformatted message.
   */
  getStateMachineServiceFor(chatState, reformattedMessage) {
    const context = this.refreshContext(chatState.context, reformattedMessage);
    const locale = context.user.locale;
    const resolvedState = this.resolvePersistedState(chatState, context);

    const stateMachineService = this.startService(resolvedState, context);
    this.addTransitionPersistanceHandler(stateMachineService, reformattedMessage, locale);

    return stateMachineService;
  }

  startService(resolvedState, context) {
    return interpret(stateMachine).start(resolvedState)
  }

  // On every state change, persist the sanitized state and log the transition.
  // Fire-and-forget: the caller already has the stateMachineService and must not block on this.
  addTransitionPersistanceHandler(stateMachineService, reformattedMessage, locale) {
    stateMachineService.onTransition((state) => {
      if (!state.changed) return;

      const userId = state.context.user.userId;
      const stateStrings = state.toStrings();
      const sourceStrings = state.history.toStrings();
      const active = !state.done && !state.forcedClose;
      const persistableState = ChatState.create(state).toPersistableState();
      const timeStamp = new Date().getTime();

      (async () => {
        await chatStateRepository.updateState(
          userId,
          active,
          persistableState.state,
          timeStamp
        );
        const sessionId = await chatStateRepository.getSessionId(userId);
        
        telemetry.log(userId, "transition", {
          input: reformattedMessage.message.input,
          source: sourceStrings[sourceStrings.length - 1],
          destination: stateStrings[stateStrings.length - 1],
          locale: locale,
          sessionId: sessionId,
          timestamp: timeStamp,
          extraInfo: reformattedMessage.extraInfo,
        });
      })();
    });
  }

  // Merges the inbound message's user/extraInfo into a persisted context,
  // preserving locale and falling back to the saved mobileNumber if the new
  // message didn't carry one.
  refreshContext(context, reformattedMessage) {
    
    const savedMobileNumber = context.user.mobileNumber;
    const savedLocale = context.user.locale;
    
    context.chatInterface = this.sessionManager;
    context.user = reformattedMessage.user;
    context.user.locale = reformattedMessage.user.locale || savedLocale;

    if (!context.user.mobileNumber && savedMobileNumber)
      context.user.mobileNumber = savedMobileNumber;
    
    context.extraInfo = reformattedMessage.extraInfo;

    return context;
  }


  // A persisted state.value naming a state the machine no longer has makes
  // resolveState throw, and it throws BEFORE service.send — so not even
  // USER_RESET can recover the session and the row stays active forever.
  // Discard the position (and the stale scratch context that described it)
  // and start over at `start`, which routes the incoming message to #welcome.
  resolvePersistedState(chatState, context) {
    try {
      return stateMachine
        .withContext(context)
        .resolveState(State.create(chatState.raw));
    } catch (error) {
      console.error(
        `Discarding unresolvable chat state for user ${context.user.userId}: ${error.message}`
      );
      return stateMachine.withContext({
        chatInterface: this.sessionManager,
        user: context.user,
        extraInfo: context.extraInfo,
        slots: { pgr: {} },
      }).initialState;
    }
  }

  createChatStateFor(user) {
    let stateMachineService = interpret(
      stateMachine.withContext({
        chatInterface: this.sessionManager,
        user: user,
        slots: { pgr: {} },
      })
    );
    stateMachineService.start();
    return ChatState.create(stateMachineService.state);
  }
}

module.exports = ChatService;

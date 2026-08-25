# The xstate-chatbot module, top to bottom

A guide for someone who has never opened this code. It starts at the outermost
boundary — a WhatsApp message arriving over HTTP — and works inward to the
individual guard conditions that decide where a conversation goes next. Read it
in order; each part assumes the one before it. Budget 30–40 minutes.

Paths are relative to `backend/xstate-chatbot/nodejs/`.

---

## Part 1 — What this module is

This is a conversational front end for filing citizen grievances. A citizen sends
WhatsApp messages; the bot replies with numbered menus; at the end a complaint row
exists in the PGR backend exactly as if it had been filed through the web portal.
It is one service among many in a DIGIT deployment, and it owns no data of its own
beyond where each conversation has got to.

Everything the bot knows comes from other services. Complaint categories come from
MDMS, geographic areas from the boundary service, translated text from the
localisation service, the citizen's identity from the user service, attachments
from filestore, and the finished complaint goes to `pgr-services`. The bot is
orchestration and dialogue; it is emphatically not a system of record.

The module is a small Express application. `src/app.js` builds the server, mounts
one router, and listens on `SERVICE_PORT` (default `8082`) under `CONTEXT_PATH`
(default `/xstate-chatbot`). It also installs a catch-all proxy to the DIGIT
gateway, which matters mainly because it means unmatched paths do not 404 the way
you would expect them to.

```js
// src/app.js - the entire server; one router, one proxy
const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true, parameterLimit: 50000 }));
app.use(envVariables.contextPath, require('./channel/routes'));   // /xstate-chatbot/*
app.use(createProxyMiddleware('/', { target: envVariables.egovServices.egovServicesHost }));
app.listen(port);
```

There is no build step and no TypeScript. It is plain CommonJS JavaScript on Node,
with `require` and `module.exports`. Dependencies are few: Express, `xstate`
4.38.3, Axios, `moment-timezone`, `uuid`, and a Postgres driver. No framework layer
sits between you and the code, and nothing is generated at build time. What you
read is what runs.

The single most important thing to understand before opening any file: **the bot
holds no conversation in memory between messages.** Each inbound WhatsApp message
is a separate HTTP request, possibly served by a different process. Where the
citizen "is" in the conversation is data, loaded and saved every turn. Almost
everything else in this document follows from that one fact.

---

## Part 2 — The path of a single message

A citizen types "1" and presses send. WhatsApp delivers it to Twilio, Twilio POSTs
a form-encoded body to a public URL, and that URL routes to
`src/channel/routes/index.js`, `POST /message`. This is the module's only real
entry point for conversation, and every feature described here is ultimately
triggered from it. Everything after that route is internal and unaware HTTP exists.

The route does three things. It asks `resolveUploadTenantId` which tenant an
attachment should be stored against, builds an `InboundRequestParser` around the
request and the active channel adapter, and awaits `parseMessage()`. If that yields a
message it hands it to `sessionManager.authenticateAndDispatch` and returns
immediately, without awaiting the result. That is the whole route: about a dozen
lines.

```js
// src/channel/routes/index.js - the entire conversation entry point
router.post("/message", async (req, res) => {
  try {
    const tenantId = resolveUploadTenantId(req, config);   // sandbox only; null otherwise
    const inboundRequestParser = InboundRequestParser.create(req, channelProvider, tenantId);
    const inboundRequestModel = await inboundRequestParser.parseMessage();

    if (inboundRequestModel) {                             // null = not a user message
      sessionManager
        .authenticateAndDispatch(inboundRequestModel)      // deliberately NOT awaited
        .catch((error) => console.error("authenticateAndDispatch failed:", error));
    }
  } catch (e) {
    console.log(e);
  } finally {
    res.end();                                             // always answer the webhook
  }
});
```

Not awaiting is deliberate. The webhook provider retries when a response is slow,
and a retry would deliver the citizen's message twice. So the route answers at once
and attaches a `.catch` so a failure is logged rather than becoming a silent
unhandled rejection. `res.end()` sits in a `finally`, so the provider always gets
an answer even if the handler throws.

The parser's job is narrow: hand the request to the channel adapter and return what
comes back. It has no imports at all — the adapter and the upload tenant are both
passed in — so parsing knows nothing about session state, user identity or
configuration. A `null` result is a normal outcome meaning "this was not a user
message", such as a delivery receipt.

What the adapter returns is the *reformatted message*, the neutral shape everything
downstream speaks. It carries `user` (mobile number, later a userId and locale),
`message` (`{ type, input }` where type is `text`, `image`, `document`, `location`
or `button`), and `extraInfo` (the tenant, the business number the citizen wrote to,
and similar envelope data).

`sessionManager.authenticateAndDispatch` in `src/session/session-manager.js` runs
the turn. It wraps the raw payload in an `InboundRequestModel`, picks a login flow
based on whether sandbox mode is on, and asks that flow to resolve a session. If the
flow returns nothing it has already replied to the citizen itself, and the turn ends
there.

With a session in hand it calls `chatService.dispatch`. That rotates the session id
if the citizen has been idle, logs telemetry, loads or creates the stored
conversation state, builds a running machine from it, and sends exactly one event —
`USER_RESET` if the message was a greeting, otherwise `USER_MESSAGE`. Sending that
event is the whole turn.

Outbound text travels the reverse path. Machine code calls
`dialog.sendMessage(context, text)`, which appends to `context.output` and, when told
to flush, calls `context.chatInterface.toUser(...)`. `chatInterface` is the session
manager itself, placed into context when the conversation starts — that is how
machine code reaches the outside world without importing anything, and why the
context is not pure data.

Note the batching. `sendMessage(context, text, false)` accumulates without sending,
and the next flushing send delivers everything queued. This is how a retry notice
and the re-asked question arrive as one WhatsApp delivery instead of two, which
matters because two deliveries can arrive out of order. When you see `false` as the
third argument, that is what it means.

```js
// src/machine/util/dialog.js - the third argument is the flush flag
dialog.sendMessage(context, retryText, false);   // queue only, nothing goes out
dialog.sendMessage(context, questionText);       // immediate: flushes BOTH as one delivery
```

---

## Part 3 — Why a state machine

Consider filing a complaint: pick a category, pick a sub-category, name the
institution, describe the problem, optionally attach a photo, pick a city, pick a
ward, accept two consent statements, choose confidentiality. Nine questions, each
with retries, each with a "go back", each needing its answer remembered until the
end when the complaint is finally assembled and posted.

Written as ordinary code this becomes a tangle of flags. Where are we? What did they
already answer? Is this "2" a menu choice or a rejection? And because each message
is a fresh HTTP request, you cannot use a call stack or a loop — the function that
asked the question returned long before the answer arrived.

A state machine solves exactly this. The conversation position is one value. The
rules for what each input means are attached to that position rather than scattered
across conditionals. Serialising the position is trivial, which is what makes the
stateless-request problem disappear. And the set of reachable positions is
enumerable, so the whole dialogue can be reasoned about.

The library is XState, and it is worth being blunt about the version: this is XState
**4**, and the XState 5 documentation you will find by searching does not apply.
There are no `@xstate/*` companion packages, no `setup()`, no actors. The idioms
here are v4 idioms and some look dated. They are correct for 4.38.3.

```js
// package.json pins v4; there are no @xstate/* companions
"xstate": "4.38.3"

// and this is the only Machine() call in the module:
//   src/machine/seva.js  ->  const sevaMachine = Machine(sevaConfig);
```

---

## Part 4 — XState v4, from zero

A **machine** is a description of states and the transitions between them. It is
inert data — creating one runs no logic. `Machine({ id, initial, states })` returns
that description. In this codebase there is exactly one machine, assembled in
`src/machine/seva.js`, and everything else is a fragment merged into it before it is
constructed.

A **state node** is one entry in `states`. A node with no children is a leaf, and
the machine rests in leaves. A node with a `states` object of its own is *compound*:
entering it means entering its `initial` child. Compound states give the
conversation its structure — "we are in the filing journey, in the location group,
at the question".

```js
// atomic: the machine can rest here
endstate: { id: 'endstate', always: [{ target: '#start' }] }

// compound: entering it means entering its `initial` child
institution: {
  id: 'institution',
  initial: 'question',
  states: { question: {...}, process: {...}, error: {...} }
}
```

An **event** is something that happens to the machine. This codebase uses two:
`USER_MESSAGE` and `USER_RESET`. That is the entire alphabet. Every branch in the
dialogue is decided not by different event types but by inspecting the text that
arrived with the event, which is why most interesting logic lives in guards rather
than in event names.

A **transition** says: on this event, in this state, go there. Written as
`on: { USER_MESSAGE: 'process' }`. A transition may name a sibling by bare name, or
any state anywhere by `#id` if that state declared `id: 'something'`. The `#id` form
is how the machine jumps between distant parts of the tree, and you will see it
throughout the generated output.

**Context** is the machine's memory: one plain object carried alongside the state
value. Here it holds the citizen's identity, the tenant, the answers gathered so
far, and some scratch data. Unlike the state value, context is unstructured — it is
whatever the code puts there, which is both convenient and the source of several
historical bugs.

An **action** is a side effect attached to entering a state or taking a transition.
`onEntry` runs on entry. In v4, actions that change context must be wrapped in
**`assign`**. This codebase uses `assign` for everything, including sending
messages — technically an impurity, but it is consistent and changing it would be a
separate refactor.

```js
// v4 requires assign() for anything that touches context.
// Note the braces: a bare arrow returning an object would REPLACE the context.
onEntry: assign((context, event) => {
  context.intention = dialog.get_intention(grammer, event, true);
})
```

A **guard** — written `cond` — is a predicate deciding whether a transition may be
taken. When several transitions are listed for the same event, XState tries them in
order and takes the first whose `cond` passes. **Order is therefore semantic, not
cosmetic.** Reordering a guard array can change behaviour, and in the tree walks it
definitely does.

```js
// tried in order; the FIRST passing cond wins, so this order is behaviour
always: [
  { target: 'fetch',    cond: (c) => c.intention === dialog.INTENTION_GOBACK },  // must be first
  { target: '#consent', cond: (c) => c[step.stepSlot].isLeafLevel },             // leaf before descend
  { target: 'fetch',    cond: (c) => c.intention !== dialog.INTENTION_UNKOWN },
  { target: 'error' }                                                           // the safety net
]
```

An **eventless transition** — written `always` — fires as soon as the machine enters
the state, without waiting for input. This is how the bot chains automatic steps: a
state sends a message on entry, then `always` moves straight on. A guarded `always`
array is a fork. A state whose `always` has no unconditional last entry can get
stuck forever.

**`invoke`** starts an asynchronous job on entry, usually a promise. Its `onDone`
transition fires when the promise resolves, with the resolved value on `event.data`;
`onError` fires when it rejects. Every backend call made during a conversation goes
through `invoke`. A state with `invoke` and no `onError` wedges if the call fails.

```js
invoke: {
  id: 'fetchBoundaryStep',
  src: (context) => step.fetch(context, context.slots.pgr[step.pathSlot] || []),
  onDone: { target: 'evaluate', actions: assign((c, e) => { c[step.stepSlot] = e.data; }) },
  onError: { target: '#system_error' }   // omit this and a failure wedges the conversation
}
```

An **interpreter** — created by `interpret(machine)` and started with `.start()` —
is a running instance, called a *service*. The machine is the recipe; the service is
the meal. `service.send(event)` drives it. `service.state` is the current snapshot,
exposing `.value`, `.context`, `.done`, and `.matches(...)`. Here a service lives
for exactly one HTTP request.

Finally, **serialisation**. `service.state` can be JSON-stringified and later revived
with `State.create(json)` and `machine.resolveState(state)`. That pair is what lets
a conversation survive between requests, and its failure modes are the subject of
Part 17. Note what does *not* come back: entry actions do not re-run, and invoked
promises do not restart.

One more v4 detail that has already caused a real bug here. Eventless transitions
are resolved under the *null event*, so inside an `always` transition's action
`event.data` is `undefined` — the payload that triggered the transition is not
visible. Only **entry** actions see the real event. Part 9 explains where that
matters.

```js
// WRONG: inside an `always` action the null event is in scope, so data is undefined
always: { target: '#welcome', actions: assign((c, event) => report(event.data)) }

// RIGHT: an entry action sees the real error.platform event
onEntry: assign((c, event) => report(event.data))
```

---

## Part 5 — Four layers: states, transitions, layout, generator

The conversation is not written as XState. It is written as two tables per journey:
**states** say what each step *is*, and **transitions** say where each step *goes*.
A **generator** turns the joined result into state nodes. A **layout** says where
each step sits in the tree. Only the generator knows XState exists.

This split exists because the concerns change at different rates and for different
reasons. The graph changes when the product changes: a new question, a different
order. What a question asks changes when the copy or the validation changes. The tree
changes almost never, and when it does it moves persisted conversation positions and
telemetry strings. Separating them means editing one cannot disturb the others.

So a state says what it *is* and nothing about where it leads. Read one entry and you
know what the citizen sees, what counts as a valid answer, and which slot the answer
lands in. Here is the institution question in full; note that it names no destination
anywhere, not even a fallback:

```js
// src/machine/flow/pgr-states.js
{ key: 'institution', kind: 'ask', accept: 'text',
  prompt: messages.fileComplaint.institution.question,
  fill: { maxLength: config.instituteNameMaxLength },
  validate: (name) => name.length ? (name.length <= 300 ? true : m.institution.tooLong) : false,
  slot: 'instituteName' }
```

The graph lives in the companion file, and it reads like a table of contents. Every
exit form the generator already accepted survives: a bare string is unconditional, an
array of `[target, guard]` pairs is tried in order with the last entry unguarded, and
an object keyed by option or outcome name routes a branch each. Guards live here,
because a guard is a condition on an edge.

```js
// src/machine/flow/pgr-transitions.js - the whole filing graph
exits: {
  menu:            { fileComplaint: 'fileComplaint', trackComplaint: 'trackComplaint' },
  institution:     'description',                 // unconditional
  description:     'imageUpload',
  consent:         { Yes: 'confidentiality', No: 'consentDeclined' },  // by option
  boundary:        { onLeaf: 'consent', onEmpty: 'consent' },          // by walk outcome
  trackComplaint:  { hasRecords: 'endstate', noRecords: 'endstate' }   // by call outcome
}
```

A pure function called `join` folds the two tables together before the generator sees
them, producing exactly the step objects the emitters already read. That boundary
matters: the *authoring* contract is two files, the *generator* contract is one joined
step. It is also what lets the generator's own tests construct a step inline, without
inventing a transitions table for each case.

```js
// src/machine/pgr.js - the two tables become the steps generate() has always taken
const flow = join(buildStates({ messages, pgrService, localisationService, config }),
                  transitions, layout.pgr);
pgr.initial = flow.layout.initial[layout.pgr.root];   // 'menu', declared in the graph
mergeStates(pgr.states, generate(flow.steps, flow.layout));
```

A state never mentions `path`, `#id`, `onEntry`, `always`, `cond`, `assign`, or a
transition, and neither does the graph. Where a step sits lives in
`src/machine/flow/layout.js`: the journey's root name, a table of group nodes with
the ids others target them by, and a map from step key to the group path it belongs
in. Nothing else.

Message text is not written in either table. A state points at a *bundle* — an object
of locale-keyed strings — and the bundles live in `flow/messages-seva.js` for
onboarding and near the bottom of `pgr.js` for filing. So adding a question touches
the states file, the transitions file and the copy — unless it belongs inside a group,
in which case `layout.place` needs a line too.

Two files hold code that is unreachable but kept deliberately:
`flow/legacy-location.js` (the old GPS and fuzzy-search location flow) and
`flow/legacy-organization.js` (onboarding by organisation code). Both still compile
and are still merged into the machine, so their internal `#id` references resolve,
but nothing routes into them. Part 22 explains why they stay.

---

## Part 6 — The machine from the top

`src/machine/seva.js` is 43 lines and assembles the one machine, id `mseva`. Read it
in full first — it is short. It declares a root config with `initial: 'start'`, a
root-level `USER_RESET` handler, and a `states` map containing exactly one
hand-written entry: `pgr`. Everything else is merged in below it, which is why the
file reads as assembly rather than as a machine.

That root `USER_RESET` rule is worth pausing on. Because it sits at the root it
applies from anywhere, which is what makes typing "egov" work at any point in any
conversation. It is the single most useful escape hatch in the product, and it is
one line. `chat-service` converts greeting words into that event before sending.

Below the config, three statements do the assembly. `mergeStates` grafts the
generated onboarding and chassis states onto the root; `Object.assign` adds the legacy
organisation states; `assertTargets` validates the finished tree. Only then is
`Machine(...)` called. The order matters — the check needs the complete tree — and
Part 23 explains what it would otherwise miss.

```js
// src/machine/seva.js - the whole assembly, verbatim
const flow = join(                         // states + graph -> the steps generate() takes
  buildStates({ messages, userProfileService, offeredLocales }),
  transitions,
  layout.seva
);
mergeStates(                               // graft the generated states onto the root
  sevaConfig.states,
  generate(flow.steps, flow.layout)
);
Object.assign(                             // add the unreachable legacy flow
  sevaConfig.states.onboarding.states,
  legacyOrganizationStates({ emailTenantService })
);

assertTargets(sevaConfig);                 // fail at require time, not mid-conversation

const sevaMachine = Machine(sevaConfig);   // only now is the machine built
```

The states themselves come from `flow/seva-states.js`. `start` waits for the first
message and forks: a citizen who already has a locale goes to `#welcome`, everyone
else to `#onboarding`. It sends nothing at all, which is unusual enough to need its
own kind. `endstate` marks a finished conversation and loops straight back to
`start`.

`onboarding` establishes identity: language, then name, with confirmation. It ends by
calling the user service to save the profile, then hands control to `#pgr`. A
returning citizen skips it entirely. `welcome` greets the citizen and routes into
`#pgr`, but only after re-checking that a locale exists — otherwise it diverts to
onboarding.

`system_error` is the failure backstop. Every `invoke` that can fail targets it, it
apologises to the citizen in their language, reports the error to the session layer,
and returns to `#welcome`. Without it a backend outage would leave the conversation
silently frozen, which from the citizen's side is indistinguishable from the bot
being switched off.

---

## Part 7 — The filing journey

`pgr` is the product: the grievance menu, filing, and complaint tracking. It lives in
`src/machine/pgr.js`, which like `seva.js` is now mostly assembly plus message
bundles. Its root has an `onEntry` that clears the answer bag, so starting a new
complaint never inherits a previous one's data — a small guarantee that removes a
whole class of confusing bug reports.

`menu` offers two options: file a complaint, or track existing ones. Choosing to
file enters `fileComplaint`, a compound state with three groups plus the closing
steps. Read them in the order the citizen meets them rather than the order they
appear in the source — the source order is historical and the retained dead code
sits in the middle of it.

```js
// pgr-transitions.js - the filing journey IS this table, verbatim and complete.
// Read the keys top to bottom and you have read the conversation.
exits: {
  menu:               { fileComplaint: 'fileComplaint', trackComplaint: 'trackComplaint' },
  complaintType2Step: { onLeaf: 'other' },       // the MDMS category walk
  institution:        'description',
  description:        'imageUpload',
  imageUpload:        'location',
  boundary:           { onLeaf: 'consent', onEmpty: 'consent' },   // the boundary walk
  consent:            { Yes: 'confidentiality', No: 'consentDeclined' },
  consentDeclined:    'endstate',
  confidentiality:    { Yes: 'persistComplaint', No: 'persistComplaint' },
  persistComplaint:   { filed: 'endstate' },
  trackComplaint:     { hasRecords: 'endstate', noRecords: 'endstate' }
}
```

First `type`, containing `complaintType2Step`: a walk down the complaint category
tree from MDMS. It may be two levels deep or five; the code does not know and does
not care, because the depth is a property of the deployment's data rather than of
the dialogue. It ends at a level marked as a leaf, storing the chosen code.

Then `other`, containing three plain questions: which institution the grievance
concerns, a free-text description with a configured minimum length, and an optional
attachment. The attachment step accepts images and documents, or the literal "1" to
skip — a deliberately blunt convention that needs no translation. These are the
simplest states in the machine and the best place to start reading.

Then `location`, containing `boundary`: the same kind of walk, this time down the
administrative boundary tree from the boundary service. It ends by recording the
city and the locality, which together tell the backend where the problem is. This
group also holds the retained dead GPS flow as unreachable siblings.

Then the closing sequence. `consent` presents two statements and requires
acceptance — declining sends a notice and ends the session without filing anything.
`confidentiality` asks whether to flag the complaint as confidential. Finally
`persistComplaint` calls the backend and sends a receipt carrying a category, a
reference number and a date. That receipt is the citizen's proof.

`trackComplaint` is the other branch from the menu and is much simpler: one backend
call, then either a formatted list of the citizen's complaints or a "nothing found"
message. Either way it ends the session. It is a good second file to read because it
shows a `call` step with two outcome branches and nothing else.

---

## Part 8 — The triplet: the core idiom

Most questions in this bot are three states, and once you see the pattern the
machine becomes easy to read. The three are `question`, `process`, and `error`, and
they are children of a compound state named after the question itself — you will see
`institution`, `consent`, `boundary` in state paths, each with those three inside.

```js
// generate.js - node() is what makes a question compound. Every `ask` and
// `choose` step goes through it, which is why they all have the same shape.
function node(step, states) {
  return { id: step.id || step.key, initial: 'question', states };
}

// ...and the ask emitter fills in the three children:
ask: (step) => node(step, {
  question: questionState(step),                                  // Part 8, para 2
  process:  { onEntry: readInput(step), always: [...] },           // Part 8, para 3
  error:    errorState(step, (c) => c.message && c.message.retry)  // Part 8, para 4
})
```

`question` renders the prompt on entry and then waits: `on: { USER_MESSAGE: 'process' }`.
It is the only one of the three that blocks. Anything the citizen needs to see is
sent here, which is why re-entering `question` re-asks the question — a property the
retry path uses deliberately rather than by accident.

```js
// generate.js - `question` is the only one of the three with an `on` handler
function questionState(step, prepare) {
  return {
    onEntry: assign((context, event) => {
      if (prepare) prepare(context);      // used only by a runtime option list
      sendPrompts(step, context, event);  // renders the bundle and sends it
    }),
    on: { USER_MESSAGE: 'process' }       // <- the only place the machine waits
  };
}
```

`process` interprets the reply on entry, writes what it concluded into context, and
then decides with a guarded `always` array where to go. It never sends anything and
never waits for input. Understanding this machine is mostly a matter of reading
`process` blocks and their guard arrays in order, because that is where every
branching decision actually lives.

```js
// generate.js - readInput is `process`'s entry action for an `ask` step.
// It writes context.message, which the guard array below it then reads.
function readInput(step) {
  const media = Array.isArray(step.accept);
  return assign((context, event) => {
    if (!dialog.validateInputType(event, step.accept)) {          // invariant: type first
      context.message = { isValid: !!(step.optional && String(event.message?.input ?? '') === '1') };
      return;
    }
    const input = media ? event.message.input : String(event.message.input).trim();
    const verdict = step.validate ? step.validate(input) : true;
    context.message = { isValid: verdict === true,
                        retry: verdict === true ? undefined : verdict || undefined };
    if (context.message.isValid) {
      if (step.slot) context.slots.pgr[step.slot] = input;        // the answer is stored here
      if (step.set) step.set(context, input);
    }
  });
}
```

`error` sends a retry message and immediately returns to `question` via `always`.
Because it uses the non-flushing form of `sendMessage`, the retry and the re-asked
question arrive together as one delivery rather than two. Every rejected input in the
product ends up here, whatever the reason it was rejected, so there is exactly one
retry behaviour to reason about.

```js
// generate.js - note `false`: queue the retry, do not flush. The re-entered
// `question` then flushes both as a single WhatsApp delivery.
function errorState(step, pick) {
  return {
    onEntry: assign((context) => {
      const bundle = pick(context)                    // a validate() verdict bundle...
        || step.retry                                 // ...or this step's own retry...
        || dialog.global_messages.error.retry;        // ...or the generic one
      emit(context, render(bundle, step.fill, context), false);
    }),
    always: 'question'
  };
}
```

The critical detail is the last entry of `process`'s guard array. If every entry has
a `cond` and none matches, the machine stays in `process` — which has no `on`
handler — and no future message can move it. The citizen is stuck permanently. Two
onboarding states once had exactly that shape, both reachable in normal use. The
generator now always emits an unconditional final `{ target: 'error' }`.

```js
// what the generator emits for every `ask` step - the triplet
{
  id: 'institution',
  initial: 'question',
  states: {
    question: { onEntry: <send the prompt>, on: { USER_MESSAGE: 'process' } },
    process:  { onEntry: <read the reply>,
                always: [ { target: '#description', cond: isValid },
                          { target: 'error' } ] },     // <- unconditional: cannot wedge
    error:    { onEntry: <send the retry>, always: 'question' }
  }
}
```

---

## Part 9 — The seven kinds

A step is a plain object with a `key` (which becomes its state name and its id), a
`kind`, and whatever that kind needs. Seven kinds cover every state in the live
conversation. Learn these and you can read or write any part of the dialogue,
because the exceptions are few and all of them are commented where they live.

**`say`** sends a message and moves on. One state, no waiting, no `on` handler. Use
it for anything the citizen reads but does not answer: the welcome, the thank-you,
the consent-declined notice. If you find yourself wanting to send a message from a
transition action, you almost certainly want a `say` step instead.

```js
// pgr-states.js - the notice sent when a citizen declines consent
{
  key: 'consentDeclined',         // one state, no waiting, no `on` handler
  kind: 'say',
  prompt: messages.fileComplaint.consent.declined
}
// pgr-transitions.js
consentDeclined: 'endstate'
```

**`ask`** captures free text or media. It declares what it will `accept`, an optional
`validate` predicate, and where to store the answer. Its retry message can be
specific — "that name is too long" — falling back to the generic one. The
institution, description, attachment and name questions are all `ask`.

```js
// pgr-states.js - validate returns true, false, or a bundle to reject WITH
{
  key: 'institution',
  kind: 'ask',
  accept: 'text',
  prompt: messages.fileComplaint.institution.question,
  fill: { maxLength: config.instituteNameMaxLength },   // fills {{maxLength}} in prompt AND retry
  slot: 'instituteName',
  validate: (name) =>
    name.length === 0
      ? false                                          // generic retry
      : name.length > config.instituteNameMaxLength
        ? messages.fileComplaint.institution.tooLong    // this specific retry
        : true
}
```

**`choose`** presents a set of options and branches on which was picked. It declares
`options` and a `next` telling each option where to go. The grammar that recognises
replies is derived from the options, so the numbering and the recognition can never
drift apart. Menus and yes/no confirmations are `choose`.

```js
// pgr-states.js - `value` transforms the picked option before it is stored
{
  key: 'confidentiality',
  kind: 'choose',
  options: ['Yes', 'No'],                              // the grammar is derived from this
  prompt: messages.fileComplaint.confidentiality.question,
  fill: { label: ..., hint: ... },
  slot: 'isConfidential',
  value: (intention) => intention === 'Yes'            // store a boolean, not "Yes"
}
// pgr-transitions.js - one entry per option, checked against `options` at boot
confidentiality: { Yes: 'persistComplaint', No: 'persistComplaint' }
```

**`walk`** handles a tree of unknown depth fetched from a backend. It declares how to
fetch a level, which slot holds the path so far, and where to go on reaching a leaf.
It is the most complex kind and the only one whose meaning is not obvious from its
name — read Part 15 before changing one.

```js
// pgr-states.js - the administrative boundary descent
{
  key: 'boundary',
  kind: 'walk',
  pathSlot: 'boundaryPath',        // the codes chosen so far, as an array
  stepSlot: 'boundaryStep',        // the level most recently fetched
  invokeId: 'fetchBoundaryStep',
  fetch: (context, boundaryPath) =>
    pgrService.fetchBoundaryStep(context.extraInfo.tenantId, boundaryPath),
  preamble: messages.fileComplaint.boundary.question.preamble,
  onLeaf:  { slot: 'locality', set: recordCity },     // the slot write stays with the state
  onEmpty: { slot: 'locality', set: recordCity }
}
// pgr-transitions.js - only the destination moves out
boundary: { onLeaf: 'consent', onEmpty: 'consent' }
```

**`call`** performs a backend operation and branches on the result. It declares the
promise to run and a list of outcome branches, each optionally with a condition, a
message and a data write. Filing the complaint, listing complaints and saving the
user profile are all `call`. Each gets a failure destination automatically.

```js
// pgr-states.js - outcomes are NAMED, so the graph can pair with them by name
{
  key: 'trackComplaint',
  kind: 'call',
  invokeId: 'fetchOpenComplaints',
  src: (context) => pgrService.fetchOpenComplaints(context.user, context.extraInfo),
  onDone: {
    hasRecords: { when: (c, e) => Array.isArray(e.data) && e.data.length > 0,
                  message: complaintList },            // a function: builds the list
    noRecords:  { message: messages.trackComplaint.noRecords }   // must be last, unguarded
  }
}
// pgr-transitions.js - onError defaults to '#system_error'; name it only to override
trackComplaint: { hasRecords: 'endstate', noRecords: 'endstate' }
```

**`gate`** waits for a message, sends nothing, and branches on guards. It is the only
kind that blocks without asking anything, and the machine's entry state `start` is
its only user. It stays deliberately atomic: `reminders-service` compares
`state.value` to the bare string `'start'`, so making it compound would silently
break the reminder skip.

```js
// seva-states.js - the machine's entry state; emits an atomic node, on purpose
{ key: 'start', kind: 'gate' }       // it asks nothing, so it declares nothing

// seva-transitions.js - the fork is entirely graph, so it lives entirely here
start: [
  ['welcome', isOnboarded],
  ['onboarding']                     // unconditional last entry
]
```

**`goto`** branches immediately with no message at all. `endstate` and the locale
check at the front of `welcome` use it. A `say` with an empty prompt would behave the
same, but `{ kind: 'goto' }` states the intent and avoids emitting a pointless entry
action, which matters when the whole point is readability.

```js
// seva-states.js - no prompt, no entry action at all
{ key: 'endstate', kind: 'goto' }
// seva-transitions.js
endstate: 'start'
```

Anywhere a destination appears it may be a bare step key, a `[target, guard]` pair, or
an object with `to` plus extras: `when` for a condition, `set` for a write. One
grammar, reused in unconditional exits, ordered arrays, option maps, call outcomes and
`onUnknown`, rather than five separate mechanisms to learn.

Three names deserve early mention because they exist for specific, documented
reasons. `effect` runs a side effect on *entry* rather than on the transition, the
only way to see the triggering event's payload. `onUnknown` replaces the retry path
when a step should silently default instead of re-asking. `onAny` sends every
recognised option to one place, which is the only form available when the option list
is built at runtime.

```js
// effect: runs on ENTRY, so it can see the error.platform payload
{ key: 'system_error', kind: 'say',
  prompt: dialog.global_messages.system_error,
  effect: (context, event) => context.chatInterface.system_error(event.data) }
// seva-transitions.js
system_error: 'welcome'

// onUnknown: replaces the retry loop; this step silently defaults instead of re-asking
{ key: 'onboardingLocale', kind: 'choose',
  options: () => offeredLocales(),                       // built at ENTRY, not at generate time
  recognize: (o) => [o.label.toLowerCase(), stripDiacritics(o.label)],
  // the fallback branch gets NO step-level write, so it must record the locale itself
  onUnknown: { set: (c) => { c.user.locale = 'en_IN'; c.onboarding.locale = 'en_IN'; } } }

// seva-transitions.js - runtime options have no names to key on, hence onAny
onboardingLocale: { onAny: 'onboardingWelcome', onUnknown: 'onboardingWelcome' }
```

The language menu is the only user of the last two, and for the same reason both
times: its options come from the deployment's data rather than from the source, so
there is no `Yes` or `No` to write a branch for. Every other step has a fixed option
list and routes by name, which is why `onAny` reads as a documented exception rather
than as the normal case.

Placeholders in prompts are filled from a `fill` map whose values may be literals,
bundles, or functions of `(context, event)`. A function is how a step computes
something: the consent statements joined into a bullet list, the complaint reference
from the backend response, today's date. Anything longer than a lookup belongs in a
named helper beside the table.

---

## Part 10 — Targets, keys and layout

Every step's `key` becomes its emitted `id`, so `next: 'description'` is resolved by
the generator into the `#description` that XState needs. Keys and targets are one
vocabulary rather than two, and a step author never types a `#`. The one exception
is `menu`, whose emitted id is `pgrMenu` because the id genuinely differs from the
state name.

Resolution happens through a table built once per `generate` call from three
sources: every step's key, every group name in the layout, and an `external` list of
names declared outside the generator. Anything not in that table throws at require
time with the offending step and the bad name, phrased in the author's vocabulary
rather than as an XState error.

`layout.js` has four parts per journey, and none is a transition. `root` names the
journey's own node, so the graph can say where it starts. `wrappers` describes the
group nodes and the `id` others target them by. `place` maps a step key to the group
it sits in; a step with no entry sits at the top level. `external` lists names the
generator does not own.

```js
// src/machine/flow/layout.js - the only file that knows the machine's shape
pgr: {
  root: 'pgr',                                   // so the graph can name the journey's own start
  wrappers: {                                    // the group nodes, and the id others target
    'fileComplaint.type':     { id: 'pgrType' },
    'fileComplaint.location': { id: 'location' },
    'fileComplaint.other':    { id: 'other' }
  },
  place: {                                       // step key -> the group it sits in
    complaintType2Step: ['fileComplaint', 'type'],
    institution:        ['fileComplaint', 'other'],
    consent:            ['fileComplaint']
    // ... a step with no entry here sits at the top level
  },
  external: ['fileComplaint', 'endstate', 'system_error']   // declared outside the generator
}
```

Where each group *starts* is deliberately not here, because entering a group is a
transition like any other. It lives in the graph file's `entry` map, so every "what
runs next" fact is in one place. Four authored targets land on a group rather than a
step, so their real destination is decided by `entry` — `imageUpload` goes to
`location`, and `location` starts at `boundary`.

```js
// pgr-transitions.js - the other half of the graph
entry: {
  pgr:                      'menu',              // layout.root names this key
  fileComplaint:            'type',              // a group may start at a nested group
  'fileComplaint.type':     'complaintType2Step',
  'fileComplaint.location': 'boundary',          // where imageUpload -> 'location' lands
  'fileComplaint.other':    'institution'
}
```

That `external` list is short and shrinking. For the onboarding journey it is now just
`pgr`, the subtree spliced in from the other file. Everything else — `start`,
`welcome`, `endstate`, `system_error`, `onboarding` — resolves from the step list or
the wrappers table, because those states are now steps or groups rather than
hand-written nodes.

The point of the separation is that editing the flow cannot move a state. Emitted
paths feed two things that outlive a deploy: the `state.value` persisted per citizen,
and the `source`/`destination` strings telemetry derives from `state.toStrings()`.
Because layout is declared once and preserved, reordering or renaming steps in the
flow leaves both untouched.

It also gives a clean exit. If the persisted paths and telemetry dimensions ever stop
mattering, deleting `layout.js` flattens the whole machine in one change and the step
tables do not change at all. The indirection is therefore reversible, which is a
better property for an abstraction to have than merely being small or clever.

---

## Part 11 — The generator

`src/machine/flow/generate.js` is about 500 lines and exports three functions.
`generate(steps, layout)` turns a step table into a states object.
`mergeStates(target, source)` grafts that into an existing tree.
`assertTargets(config)` checks the assembled result. Everything else in the file is
private to it, which is why the surface is small enough to hold in your head.

Internally it is one emitter per kind over a set of shared helpers, and no function
is long. `questionState`, `errorState`, `readInput` and `readChoice` are shared by
`ask` and `choose`; `render` and `emit` handle text; `transitions` and `fallbackOf`
build guard arrays. To learn what a step becomes, find its emitter and read downward
from there.

```js
// generate.js - the `ask` emitter in full. Note the two invariants it bakes in:
// every declared branch is gated on validity, and the array always ends unconditionally.
ask: (step) => node(step, {
  question: questionState(step),
  process: {
    onEntry: readInput(step),
    always: transitions(step.next, null, step.key)
      .map((transition) => ({
        ...transition,
        cond: transition.cond
          ? (c, e) => c.message.isValid && transition.cond(c, e)
          : (c) => c.message.isValid
      }))
      .concat([{ target: 'error' }])            // <- the wedge-proof fallback
  },
  error: errorState(step, (c) => c.message && c.message.retry)
})
```

`generate` walks the table and places each step where the layout says, creating group
nodes as needed, taking their `id` from `wrappers` and their `initial` from the `entry`
map that `join` folded in. Side effects
stay inside `assign`, matching the idiom in `dialog.js`, and every `assign` body is
block-bodied — an accidental object return would silently replace the whole context.

`mergeStates` is what makes incremental change safe. When a generated node and an
existing hand-written node occupy the same key and both are compound, it recurses
into their children rather than overwriting. A plain assignment would have replaced
an entire subtree, which during the conversion would have silently deleted dozens of
states.

`join` is the piece that keeps the emitters ignorant of the split. It folds each
state's exits back into the fields they already read — `next`, `onLeaf.to`, `onDone[]`
— and enforces four rules at require time: every exit names a real state, every state
needing an exit has one, every entry names a real group, and a call's last outcome is
unguarded. Those checks are the design, not polish.

Four invariants are emitted unconditionally, and each closes a defect that existed
when states were written by hand. Input type is validated before the reply is
interpreted. Every guard array ends unconditionally. Walk guard order is fixed by the
emitter rather than by the author. And there is exactly one retry implementation
instead of seven near-identical copies.

The first invariant deserves explanation. `dialog.get_input` throws a `TypeError`
when the message payload is not a string, which happens for a shared location pin.
Six hand-written states called the interpreter without checking first, so a location
pin at the consent prompt threw out of `service.send`. The check is now not something
a step can forget.

The generator also refuses malformed tables at load time rather than producing a
broken machine. A `choose` that offers an option with no destination throws
immediately, naming the step and the option — because the alternative is a citizen
who picks a listed option and is told forever that it is invalid.

Two step fields exist purely to express things the plain kinds could not. `options`
may be a *function*, in which case the option list and its grammar are built on entry
and stored in context; this is mandatory for the language menu, because the
localisation service populates its locale list asynchronously and the list is empty
when `generate` runs. `recognize` supplies extra accepted spellings per option.

---

## Part 12 — Slots: the answer bag

Answers accumulate in `context.slots.pgr`, a flat object: `complaint`,
`instituteName`, `description`, `image`, `city`, `locality`, `isConfidential`, plus
`hierarchyPath` and `boundaryPath`, which are the walks' working state rather than
answers as such. This bag is what becomes a complaint at the end, and it is cleared
whenever the citizen re-enters the grievance menu, so a new complaint never inherits
an old one.

A step writes to it by naming a `slot`. The generator does the assignment, so step
data never touches `context` directly for the common case. A `choose` step can also
transform the value on the way in: the confidentiality question stores a real boolean
rather than the string "Yes", which is what the backend expects and what the receipt
logic reads.

```js
// as written in pgr-states.js / seva-states.js
slot: 'instituteName'                            // -> context.slots.pgr.instituteName

slot: 'isConfidential',                          // with a transform on the way in
value: (intention) => intention === 'Yes'

set: (context, locale) => {                      // anywhere OUTSIDE the pgr bag
  context.user.locale = locale;
  context.onboarding.locale = locale;
}
```

For anything outside that bag — the citizen's locale, the onboarding name — a step
supplies a `set` function instead, receiving the context and the captured value. Two
mechanisms rather than one, but both are trivial and neither needs a path resolver.
Prefer `slot` whenever it fits, and reach for `set` only when the destination really
lives elsewhere.

The consumer is `persistComplaint` in `src/machine/service/egov-pgr.js`. It reads the
bag and builds the PGR request body, including an `extendedAttributes` object
carrying the institution name, the confidentiality flag and a deployment-level case
category. If you add a slot, that function is where it must be read — writing a slot
nobody reads is the easiest silent mistake here.

```js
// generate.js - where a `choose` step's answer is written
function choiceWrite(step) {
  if (!step.slot && !step.set) return null;
  return (context) => {
    const value = step.value ? step.value(context.intention) : context.intention;
    if (step.slot) context.slots.pgr[step.slot] = value;   // -> the answer bag
    if (step.set) step.set(context, value);                // -> anywhere else
  };
}

// egov-pgr.js persistComplaint - the other end of the contract
requestBody.service.description = slots.description ?? '';
requestBody.service.extendedAttributes = {
  caseRelatedTo:  config.caseRelatedTo,
  instituteName:  slots.instituteName,
  isConfidential: slots.isConfidential === true
};
```

There is no schema. Nothing stops a typo in a slot name from producing a complaint
with a missing field. The mitigation is a test asserting the exact set of slot keys
after a happy path, so a rename fails on the same commit that introduces it. Treat
that test as the contract, because it is the only one there is.

---

## Part 13 — Text and translation

All outbound text lives in message bundles: objects keyed by locale — `en_IN`,
`pt_PT` — with an optional `code`. Onboarding and chassis copy sits in
`flow/messages-seva.js`; filing copy sits near the bottom of `pgr.js`. They are
ordinary data and safe to edit, kept next to the flow they serve rather than in a
separate translation tree.

`dialog.get_message(bundle, locale)` resolves one. If the bundle has a `code` it
first asks the localisation service for a live translation of that code; if that
yields nothing usable it falls back to the bundle's own text for the locale, and
failing that to `en_IN`. So translations can change in DIGIT without a deploy, while
the code still runs standalone.

```js
// pgr.js (filing) and flow/messages-seva.js (onboarding) hold these.
// A bundle: a localisation code plus per-locale fallback literals.
institution: {
  question: {
    code: 'chatbot.pgr.institution.question',    // asked of the platform FIRST
    en_IN: 'Which institution is your grievance about?',
    pt_PT: 'A que instituicao se refere a sua reclamacao?'
  }
}

// resolution order, from dialog.get_message:
//   1. live translation for `code` in the citizen's locale
//   2. this bundle's entry for that locale
//   3. this bundle's en_IN
```

`src/machine/util/localisation-service.js` fetches those translations once at module
load and caches them. It queries two tenants — the state root and the deployment
tenant — because the localisation search API returns rows from the first tenant in
the chain that matches and then stops rather than merging. That detail has cost real
debugging time.

Which languages the menu offers is decided in `flow/offered-locales.js`. A locale is
offered only if the platform declares it *and* every bundle in the journey has a
fallback literal for it. The platform side is weaker than it looks: the service's
coverage check proves only that a locale has some row at that tenant, not that the
chatbot has translations.

Placeholders use double braces: `{{maxLength}}`, `{{statements}}`, `{{name}}`,
`{{options}}`, and positional `{{1}}` `{{2}}` `{{3}}` in the filing receipt. The
generator substitutes them from the step's `fill` map, and a `choose` step gets
`{{options}}` for free. A placeholder with no matching entry is left in the text —
visible, which is the point.

```js
// generate.js - substitution. Two behaviours worth noting, both deliberate.
function render(bundle, fill, context, event) {
  let text = dialog.get_message(bundle, context.user.locale);
  for (const token of Object.keys(fill || {})) {
    const marker = `{{${token}}}`;
    if (!text.includes(marker)) continue;                        // absent -> never evaluated
    text = text.split(marker).join(String(resolve(fill[token], context, event) ?? ''));
  }                                                              // nullish -> empty string
  return text;
}

// and a `choose` step gets {{options}} for free:
const fill = step.options ? { options: () => renderOptions(optionsOf(step)), ...step.fill } : step.fill;
```

Two rules about substitution, both learned the hard way. A `fill` value resolving to
nothing renders as an empty string, not the word "undefined" and not a stray comma.
And a `fill` entry whose placeholder does not appear in the text is never evaluated,
so a function that would throw on missing data does not get the chance.

Reused platform keys are worth knowing. The consent statements and the
confidentiality label point at the same localisation codes the web portal uses, so
the bot and the portal cannot drift apart in wording. When you add citizen-facing
text, check whether the portal already has a key for it before inventing one.

---

## Part 14 — Understanding what the citizen typed

The bot recognises replies by *grammar*: a list of `{ intention, recognize }` pairs,
where `recognize` is an array of accepted strings and `intention` is the symbol the
machine reasons about. `dialog.get_intention(grammar, event, true)` returns the
matching intention or a sentinel meaning "not understood". The third argument selects
exact matching, and every live call uses it.

```js
// what choiceGrammer builds from options: ['Yes', 'No']
[
  { intention: 'Yes', recognize: ['1', 'yes'] },
  { intention: 'No',  recognize: ['2', 'no'] }
]

// get_intention lowercases and trims the input, then matches exactly (strict = true)
context.intention = dialog.get_intention(grammer, event, true);   // or INTENTION_UNKOWN
```

The product is deliberately numbers-first. A menu of three options accepts "1", "2",
"3". This is not laziness: it works on every handset, needs no translation, and
avoids the ambiguity of free text in a language the bot may not have been tested in.
Confirmations additionally accept the word forms, so "yes" works as well as "1".

For a `choose` step the grammar is derived from the step's `options`, so the prompt's
numbering and the recognition come from the same list and cannot disagree. This
matters more than it sounds: two hand-written confirmation grammars had once drifted,
so "yes" was accepted at the name confirmation and rejected at the consent question
for no reason anybody intended.

A step may extend the accepted spellings with `recognize`. The language menu uses it
to accept the option's label as well as its number, including a diacritic-stripped
form — so a citizen typing `portugues` selects `PORTUGUÊS`. Without that, generating
that step from its options alone would have accepted only the number and the locale
code.

There is an important asymmetry in where grammars live. A static option set is a
compile-time constant held in the emitter's closure. A runtime list — the language
menu, or a fetched tree level — must survive to the next HTTP request, so it is
stored in `context.grammer`. Storing a constant there would add a way to fail for no
benefit.

```js
// generate.js - one reader, two sources of grammar
process: { onEntry: readChoice(step, dynamic
            ? (context) => context.grammer   // runtime list: must survive to next request
            : () => fixed) }                 // static list: closed over, never persisted

function readChoice(step, grammerOf) {
  return assign((context, event) => {
    const grammer = grammerOf(context);
    if (!grammer || !dialog.validateInputType(event, step.accept || REPLY_TYPES)) {
      context.intention = dialog.INTENTION_UNKOWN;   // no throw, just "not understood"
      return;
    }
    context.intention = dialog.get_intention(grammer, event, true);
  });
}
```

`validateInputType(event, accepted)` is the separate question of *kind*: was this
text, an image, a document, a location, or a button reply? Text questions accept text
and interactive button replies. The attachment question accepts images and documents.
This check always runs before interpretation, which is one of the generator's four
invariants and closes a crash described in Part 11.

---

## Part 15 — The tree walks

Two questions in the product are not really questions but descents through a tree of
unknown shape: the complaint category and the administrative area. Both are driven
entirely by backend data. Neither the depth nor the labels appear in the code, which
is why a deployment can restructure its categories without anyone touching this
module.

A walk is five states. `fetch` invokes the backend for the current level. `evaluate`
looks at what came back and decides whether there is anything to ask. `question`
renders the numbered list and waits. `process` interprets the choice. `error`
retries. The cycle repeats one level per pass until a level announces itself as the
last.

The path so far lives in a slot — `hierarchyPath` or `boundaryPath` — as an array of
codes. Descending pushes the chosen code; going back pops it. The fetch function
receives that array and returns the level below it, along with the labels to display
and a flag saying whether this level is a leaf.

`process`'s guard order is the subtlety, and the generator fixes it for good reason.
Go-back is tested first, because "Go Back" is a real grammar entry and would
otherwise satisfy the later guards — choosing it at a leaf level would have filed a
complaint whose category was literally "goback". Leaf is tested before descend, or
the leaf's own code gets pushed and the next fetch runs against nothing.

```js
// generate.js walkTransitions - the order is fixed by the emitter, not the author
[
  { target: 'fetch',            cond: (c) => !c[step.stepSlot] },              // 0: resumed with no level -> refetch
  { target: 'fetch',            cond: (c) => c.intention === INTENTION_GOBACK, // 1: pop the path
                                actions: <pop> },
  { target: step.onLeaf.to,     cond: (c) => recognised(c) && c[step.stepSlot].isLeafLevel,
                                actions: <push, write the slot> },             // 2: leaf BEFORE descend
  { target: 'fetch',            cond: (c) => recognised(c), actions: <push> }, // 3: descend
  { target: 'error' }                                                          // 4: retry
]
```

Ahead of all of those sits a guard for missing fetched data. A conversation resumed
mid-walk has the path but not the fetched level, because entry actions do not re-run
on resume. Without the guard, reading the leaf flag off `undefined` throws. With it,
the walk simply fetches again and re-asks, costing the citizen one prompt.

`evaluate` exists for the case of a level with no options. For the boundary walk that
means the citizen has descended as far as the data goes, so it records what it has
and moves on. The category walk has no such escape, deliberately: there is no sound
complaint to file without a category.

The backend side lives in `src/machine/service/egov-pgr.js`.
`fetchComplaintHierarchyStep` reads the MDMS category definition and rows, orders any
"Other" option last, and returns exactly one level. `fetchBoundaryStep` does the
equivalent against the boundary hierarchy. Both return the same shape — options,
labels, a level name and a leaf flag — which is precisely why one emitter can serve
both walks.

---

## Part 16 — The session layer

`src/session/` turns HTTP into conversation. It is deliberately several small files
rather than one: `session-manager.js` orchestrates, two login flows resolve identity,
`chat-service.js` owns the machine, `chat-state.js` wraps the persisted blob,
`session.js` names the resolved citizen, and `inbound-message-parser.js` plus
`upload-tenant.js` handle the inbound request. Each one is readable in a sitting.

`session-manager.js` is 110 lines and does four things in `authenticateAndDispatch`:
wrap the payload in a model, choose a login flow, resolve a session, dispatch. It
also exposes `toUser` — the outbound path machine code reaches through
`context.chatInterface` — and holds the sandbox tracker plus a housekeeping timer
that expires stale entries.

```js
// src/session/session-manager.js - the whole turn, four steps
async authenticateAndDispatch(rawRequestModel) {
  const inboundRequestModel = InboundRequestModel.create(rawRequestModel);

  const loginFlow = config.isSandboxMode
    ? new SandboxLoginFlow(inboundRequestModel, sandboxOrgTracker, getAuthenticatedSandboxUser)
    : new StandardLoginFlow(inboundRequestModel);

  const session = await loginFlow.resolveSession();
  if (!session) return;              // the flow already replied to the citizen

  await this.chatService.dispatch(session, inboundRequestModel);
}
```

There are two login flows behind one contract, `resolveSession()`.
`StandardLoginFlow` resolves the mobile number to a DIGIT user, creating one if
needed, and returns a session. `SandboxLoginFlow` handles the multi-organisation
email flow used by sandbox deployments. Either may return `null`, meaning it has
already replied to the citizen and the turn is over.

`chat-service.js` is where the machine lives. `dispatch` rotates the session id if
the citizen has been idle, logs telemetry, loads or creates the stored state, builds
a running service, and sends one event. `getStateMachineServiceFor` is the
interesting half: it rehydrates, attaches the persistence listener, and handles the
case where rehydration fails.

```js
// src/session/chat-service.js - one turn, start to finish
async dispatch(session, inboundRequestModel) {
  const sessionUserId = session.userId;

  await chatStateRepository.updateSessionId(sessionUserId, config.avgSessionTime);  // idle -> new session id
  telemetry.log(sessionUserId, "from_user", inboundRequestModel);

  const chatState = await this.getOrCreateChatState(sessionUserId, session.user);
  const stateMachineService = this.getStateMachineServiceFor(chatState, inboundRequestModel);

  const event = inboundRequestModel.getMessage().isReset() ? "USER_RESET" : "USER_MESSAGE";
  stateMachineService.send(event, inboundRequestModel);      // the whole turn is this line
}
```

`chat-state.js` is a small value wrapper around the serialised blob. It names the
parts the rest of the layer needs — `context`, `value`, `isDone()` — and offers
`toPersistableState()`, which deep-clones and then strips the user object down to
locale, userId and mobile number. Callers that need the un-stripped state must clone
first, which the method name says.

`inbound-message-parser.js` has no imports at all: the channel adapter and the upload
tenant are both passed in. That is deliberate, so parsing carries no session or
identity dependency. The tenant decision lives in `upload-tenant.js`, which is the
one place that knows an attachment in sandbox mode belongs to the citizen's
registered tenant.

The neutral payload gets two thin model classes in `src/machine/util/`.
`InboundRequestModel` names `user`, `message` and `extraInfo`; `InboundMessage` names
`input` and `type` and answers questions about them, notably `isReset()`, which is how
a greeting becomes `USER_RESET`. Both are transport shapes rather than machine
concepts, which is why they carry no dialogue logic.

One caveat about `InboundMessage.create`: it validates the message type against a
fixed list. Types the channel adapters can genuinely produce — `button`,
`unsupported`, `unknown` — are absent from that list at the time of writing, so those
payloads throw and the citizen gets silence instead of a retry. Worth checking
whether that has been fixed before trusting it.

---

## Part 17 — Saving and resuming a conversation

After every transition the persistence listener serialises the state, strips the user
object down to locale, userId and mobile number, and writes it to the
`eg_chat_state_v2` table against the citizen's id, along with telemetry describing
the move. The write is fired without being awaited, so two transitions in one turn
race and ordering is not guaranteed.

```js
// src/session/chat-service.js - attached to every service it builds
stateMachineService.onTransition((state) => {
  if (!state.changed) return;

  const active = !state.done && !state.forcedClose;
  const persistableState = ChatState.create(state).toPersistableState();  // clone + strip user

  (async () => {                                       // deliberately not awaited
    await chatStateRepository.updateState(state.context.user.userId, active,
                                          persistableState.state, Date.now());
    telemetry.log(..., "transition", {
      source:      sourceStrings[sourceStrings.length - 1],   // from state.history.toStrings()
      destination: stateStrings[stateStrings.length - 1]      // from state.toStrings()
    });
  })();
});
```

Which repository is used depends on `REPO_PROVIDER`. The default is `InMemory`, so a
restart forgets every conversation — fine for local work, useless in production.
`postgres-repo.js` is the real one. The distinction catches people out when a local
session survives nothing and they go hunting for a bug that is a default value doing
its job.

On the next message the stored JSON is revived: `State.create` rebuilds a state
object, `machine.resolveState` reattaches it to the machine, and
`interpret(machine).start(resolved)` resumes there. The citizen's identity and tenant
are refreshed from the incoming message first, since the stored copy was deliberately
trimmed down to a locale, a userId and a mobile number.

Three things do **not** come back, and each has bitten this codebase. Entry actions
do not re-run, so anything a state wrote on entry must have been persisted. Invoked
promises do not restart, so a conversation saved while waiting on a backend call
cannot advance on its own. And the "changed" flag is absent, which incidentally
prevents a crash in the transition logger.

The dangerous failure is a stored position naming a state the machine no longer has —
the inevitable result of renaming a state and deploying. `resolveState` throws, and it
throws *before* the event is sent, so the reset keyword cannot save the citizen
either. The row stays active and every future message repeats the same throw. That is
a permanent brick.

The fix is small and important: rehydration is wrapped, and on failure the error is
logged and a fresh conversation starts, carrying forward only the citizen and the
tenant. The stale answer bag and grammar are deliberately discarded, because they
describe a position that no longer exists. The citizen sees the welcome message and
carries on.

```js
// src/session/chat-service.js
resolvePersistedState(chatState, context) {
  try {
    return sevaStateMachine.withContext(context).resolveState(State.create(chatState.raw));
  } catch (error) {
    console.error(`Discarding unresolvable chat state for user ${context.user.userId}: ${error.message}`);
    return null;                     // caller starts fresh, carrying only user + tenant
  }
}
```

One consequence worth knowing: conversations are never marked complete in practice,
because the end state loops back to `start` rather than being declared final. So the
active flag stays true and old state is always revived. The resume fallback is what
makes that arrangement safe rather than fragile, which is why it is not optional.

---

## Part 18 — Channels

`src/channel/index.js` picks one adapter at startup from `WHATSAPP_PROVIDER`:
`Twilio`, `ValueFirst`, `Kaleyra`, or the console fallback. Every adapter implements
the same two functions — `processMessageFromUser` inbound and `sendMessageToUser`
outbound — and nothing else in the codebase knows or cares which one is active. The
choice is made once, at require time.

```js
// src/channel/index.js - one decision, made once at require time
if (config.whatsAppProvider == 'ValueFirst')   module.exports = valueFirstWhatsAppProvider;
else if (config.whatsAppProvider == 'Kaleyra') module.exports = require('./kaleyra');
else if (config.whatsAppProvider == 'Twilio')  module.exports = require('./twilio');
else                                           module.exports = consoleProvider;
```

The console adapter is how you develop. It reads from and writes to the terminal,
needs no external account or public URL, and exercises the identical machine. If you
are changing dialogue, use it: the loop is seconds rather than minutes and you can
read the whole transcript at once, which is the only practical way to judge wording.

The Twilio adapter handles form-encoded webhooks: `From`, `To`, `Body`, `MediaUrl0`,
`MediaContentType0`. Outbound numbers must be built as
`whatsapp:+<country><national>`, and getting that wrong produces a Twilio error code
rather than a delivered message — which from the outside looks exactly like the bot
ignoring the citizen. The country prefix comes from configuration.

Media handling is where adapters do real work, and it is not a pure parse. An inbound
image arrives as a URL; the adapter downloads it with account credentials and uploads
it to filestore, returning the file id as the message input. So calling
`processMessageFromUser` twice per request would upload twice and orphan the first
file.

Interactive button replies arrive with a distinct type but a plain string payload.
Text questions accept them for that reason: a citizen tapping a quick-reply button is
answering the question, and rejecting that would be a bug waiting for the day rich
templates are switched on. No outbound template currently uses buttons.

---

## Part 19 — The backend services

`src/machine/service/service-loader.js` is a thin indirection exporting the service
objects. It exists so tests can replace them wholesale. Anything that talks to the
network should be reachable through it, and code that captures a service at module
load time defeats that — a mistake worth avoiding when you add a new module here.

```js
// src/machine/service/service-loader.js - the whole file
console.log("Using eGov Services");
console.log('Using PGR v2');
module.exports.pgrService = require('./egov-pgr');

if (config.kafka.kafkaConsumerEnabled) {
  module.exports.pgrStatusUpdateEvents = require('./pgr-status-update-events');
}

// pgr-states.js receives it as an argument rather than importing it, so a test
// can replace it: buildStates({ messages, pgrService, localisationService, config })
```

`egov-pgr.js` is the large one. Besides the two walk functions it holds
`persistComplaint`, which assembles and posts the complaint; `fetchOpenComplaints`,
which lists the citizen's existing ones; `fetchMdmsData`, the generic MDMS query
everything else is built on; and the filestore upload and download helpers used by
the attachment step. Most backend contact is here.

`egov-user-profile.js` saves the citizen's name and language during onboarding.
`user-service.js` in the session layer resolves a mobile number to a DIGIT user,
creating one if needed. Its number normalisation is country-configurable, which
matters because the same digits mean different things in different deployments and
the tracker is keyed by the normalised form.

Requests to DIGIT need an authenticated envelope, and MDMS in particular is sensitive
to the tenant in the query. When a lookup returns nothing, suspect the tenant before
suspecting the data — Part 21 explains why that is the usual cause. An empty options
list is the symptom, and because that is not an error it surfaces as an odd-looking
prompt.

Failures are surfaced rather than swallowed. Every `invoke` that can reject routes to
`#system_error`, which apologises to the citizen and reports the payload. One caveat
worth knowing: a *synchronous* throw inside an `invoke` source — a typo'd method
name, for instance — escapes `onError` entirely and takes the process down rather
than reaching that state.

---

## Part 20 — Retained dead code

Two subtrees are unreachable but present. The location flow that asked for a GPS pin
and did fuzzy matching on city and locality names was replaced by the boundary walk.
Onboarding by organisation code, for deployments where a citizen belongs to one of
several organisations, was replaced by a simpler single-tenant flow.

They were kept rather than deleted because the behaviour may be wanted again and
reconstructing it from a commit history is harder than reading it in place. They live
in `flow/legacy-location.js` and `flow/legacy-organization.js`, moved with only their
indentation changed, and are merged into the machine so their internal `#id`
references still resolve at boot.

```js
// src/machine/pgr.js - the dead geo flow is merged in as siblings of the live walk
mergeStates(
  pgr.states.fileComplaint.states.location.states,
  legacyLocationStates({ messages, grammer, pgrService, config })
);

// nothing targets them, which you can confirm with:
//   grep -rn "#geoLocation\|#nlpCitySearch\|#confirmLocation" src/
```

Each also owns the message copy only it reads, so the dead flow is self-contained and
deleting it later is a single-file change. That copy is the giveaway when you are
reading: it carries `hi_IN` and `pa_IN` locales and no `code`, unlike the live
bundles, which carry `en_IN`, `pt_PT` and a localisation code.

Reviving either means restoring an entry point — a transition that targets its first
state — and then testing it. Nothing currently routes in, which you can verify by
searching for `#` references to their state ids. That search is also the quickest way
to confirm whether a state you are reading is live at all.

---

## Part 21 — Tenants

DIGIT tenancy is hierarchical: a state root such as `mz` with cities beneath it such
as `mz.ige`. The distinction is not cosmetic, and getting it wrong produces empty
lists rather than errors, which is why it is worth learning before your first
debugging session. Most "the bot shows no categories" reports trace back to a tenant
mismatch.

`ROOT_TENANTID` tells the bot which tenant to work in, and it drives four things at
once: which tenant complaints are filed against, where citizens are looked up and
created, which MDMS category data is read, and which localisation rows are fetched.
One variable, four consequences, which is why changing it is never a small change.

```text
// the same variable, reached from four different places
standard-login-flow.js:14  userService.getUserForMobileNumber(mobile, config.rootTenantId)
pgr-states.js              pgrService.fetchBoundaryStep(context.extraInfo.tenantId, path)
egov-pgr.js:943            tenantId = ... : config.rootTenantId          // where a complaint is filed
localisation-service.js:18 const stateTenantId = String(config.rootTenantId).split('.')[0];
```

In this deployment complaints are filed at the city tenant, because that is where the
real category tree and the real boundaries live. The state root holds only
demonstration data and no boundaries at all, which would dead-end the location walk
on its first level. The workflow definition resolves at the state root regardless.

Localisation cuts the other way: translated strings live at the state root, not the
city. That asymmetry is exactly why the localisation service queries both tenants and
merges the results itself rather than trusting one query. Seed translations against
the wrong tenant and they load without error and simply never appear in a message.

---

## Part 22 — Configuration

`src/env-variables.js` is the single place environment variables are read, and every
one has a default. There is no `.env` loading — the process expects real environment
variables, so local runs use a shell script that exports them before starting. Read
the file once; it is short and it is the whole contract with the environment.

Four groups matter. Identity and routing: port, context path, channel provider,
repository provider, business number. Tenancy: root tenant and supported locales.
Country: dialling code and national number length, plus the mobile format rules.
Product limits: minimum description length, maximum institution name length, and the
case category recorded on every complaint.

```js
// src/env-variables.js - every value has a default, so nothing is required
rootTenantId:          process.env.ROOT_TENANTID           || 'pg',
supportedLocales:      process.env.SUPPORTED_LOCALES       || 'en_IN',

// Phone identity is per-country CONFIG, not code.
countryCode:           process.env.COUNTRY_CODE            || '91',
mobileNumberLength:    parseInt(process.env.MOBILE_NUMBER_LENGTH || '10', 10),

descriptionMinLength:  parseInt(process.env.DESCRIPTION_MIN_LENGTH || '20', 10),
instituteNameMaxLength:parseInt(process.env.INSTITUTE_NAME_MAX_LENGTH || '300', 10),
isSandboxMode:         process.env.ENABLE_SANDBOX_MODE === 'true',
```

The country group exists because the code once assumed India in several places.
Numbers are normalised, validated and formatted from configuration now. If you find a
literal country code in the source it is a bug rather than a shortcut — at the time
of writing one such leftover survives in the Twilio adapter's phone-number
extraction.

Product limits are read through configuration for the same reason: the minimum
description length appears both in the validation and in the prompt text, via a
placeholder. Change the variable and both move together. Hardcoding it in either
place guarantees they will eventually disagree, which is an unpleasant bug to receive.

---

## Part 23 — What fails at boot, and why that is good

`assertTargets` runs in `seva.js` after everything is merged and before `Machine(...)`
is called. It walks the assembled config and raises on three things: a target that
resolves to no state, a duplicate state id, and a compound state with no `initial`
child. All three would otherwise be silent in different ways.

```js
// generate.js - three checks, all of them cheap, all of them fatal
function assertTargets(config, allowed = []) {
  const out = scan(config, { ids: [], targets: [], headless: [] });   // whole config, not just states

  const duplicate = out.ids.find((id, i) => out.ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`flow: duplicate state id '#${duplicate}'`);

  const known = new Set(out.ids.concat(allowed));
  const missing = out.targets.find((t) => !known.has(t.slice(1)));
  if (missing) throw new Error(`flow: unknown transition target '${missing}'`);

  if (out.headless.length)
    throw new Error(`flow: compound state '${out.headless[0]}' has no initial state`);
  return config;
}
```

Each is silent for its own reason. XState v4 does not detect duplicate ids at all. An
unknown target throws only when the machine is first interpreted — inside a swallowed
catch — so it surfaces as one wedged citizen at a time. And a compound state with no
`initial` merely logs a warning nobody reads.

`join` adds four more, checked before the generator runs at all. They exist because
splitting the graph into its own file doubles the number of places a step's name
appears, so renaming it in one file and forgetting the other is now the likeliest
mistake anyone will make. Each message names the offender, in the author's vocabulary
rather than XState's, so the fix is usually obvious from the line alone.

```text
flow: transitions declare an exit for 'instituion', which is not a state
flow: state 'severity' (choose) has no exit in transitions
flow: entry declares a start for 'fileComplaint.typo', which is not a group in the layout
flow: 'fileComplaint' starts at 'instituion', which is not a state or a group
flow: state 'trackComplaint' declares outcome 'hasRecords' last, but it carries a
      guard - the final outcome must be unconditional
```

The last one replaces a guarantee the syntax used to give for free. When `onDone` was
an ordered array, "the fallback is last" was visible on the page. Named outcomes rely
on object key order instead, which is a language detail rather than an author's
intent, so the rule is now enforced rather than trusted.

```text
flow: step 'description' points at 'imageUploadd', which is not a step, a group
      or a declared external state
flow: duplicate state id '#institution'
flow: unknown transition target '#welcomee'
flow: compound state 'outer' has no initial state
flow: step 'menu' offers option(s) somethingElse with no next target
```

Note it validates the whole *config*, not just the states map. That matters because
the root's own `on` handlers are transitions too, and `USER_RESET → #welcome` is the
product's universal escape hatch. Scanning only the states left that single
transition unchecked, so breaking the one thing every citizen relies on used to be
completely silent.

Turning these into a startup failure is the point. A deployment that will not boot is
obvious, fixed in minutes, and affects nobody mid-conversation. The same defect
discovered as "some citizens stop getting replies" is a support ticket, a log hunt,
and — because the state is persisted — citizens who stay broken until someone
intervenes.

---

## Part 24 — Tests

Five files, each testing something different. `test/flow-generate.test.js` is the
largest and verifies the generator itself against synthetic steps with fixture text.
It contains no product copy at all, deliberately: rewording a prompt must never break
it. If you change the generator, coverage belongs here, and it is the fastest file to
run.

`test/flow-join.test.js` covers the join in isolation: each exit form, that payload
stays with the state while only the destination moves, that call outcomes pair by name
rather than by position, and each of the four require-time checks. Because `join` is a
pure function over synthetic tables, these tests need no machine, no stubs and no
copy.

`test/pgr-flow.test.js` drives the real filing machine and is table-driven. Each test
is a list of turns, and each turn says what to send and what must then be true — the
last message matches a pattern, the machine is in a given state, certain slots hold
certain values, the conversation has finished. Adding coverage means adding rows.

```js
// test/pgr-flow.test.js - each test is a table; each row is one turn
await runRows(createHarness({ serviceStub: createHappyPathServiceStub() }), [
  { expect: /type and send the number for your option/ },
  { send: '1', expect: /select a Category/ },
  { send: '1', expect: /select a Sub-Type/, saw: /Street lights/ },
  { send: '1', expect: /Which institution/, slots: { complaint: 'StreetLightNotWorking' } },
  { send: '  Ministry of Water  ', slots: { instituteName: 'Ministry of Water' } },
  // ...
  { send: '1', expect: /registered successfully/, slots: { isConfidential: true }, done: true },
]);
```

It works by replacing modules in Node's cache before requiring the machine, so no
network call happens and backend responses are whatever the test says. One trap: only
the machine file is re-required per test, so any module that captures a service at
load time will hold a stale stub. Inject dependencies instead of importing them.

`test/session-resume.test.js` covers the save-and-resume layer with the repository,
channel and telemetry stubbed out. Its important test asserts the *precondition*
first — that the bad state really does throw — before asserting the fallback catches
it. A test that passes whether or not the code is broken is worse than no test.

`test/offered-locales.test.js` covers which languages the menu offers, including the
case the old implementation got wrong: a locale present in one bundle but missing from
another must not be offered. It stubs both the bundles and the platform locale list,
so it tests the rule rather than whatever the current deployment data happens to be.

Exactly one assertion in the suite checks a nested state path rather than behaviour,
and it is load-bearing. It proves the generated category walk sits where the
hand-written one did, which is what keeps saved conversations resumable. Leave it
alone; if it ever fails, a rename has happened and persisted sessions are about to be
discarded.

Five tests are skipped, each labelled with its cause: four drive the unreachable
location flow and one asserts a menu option that no longer exists. Skipped rather
than deleted, matching the decision to keep the code they describe. A skipped test
with a stated reason is a note to the next reader; a deleted one is a gap nobody
knows about.

Beyond the suite, two techniques are worth knowing. A *probe* is a throwaway script
that drives one part of the machine through many inputs and dumps the transcript,
state and slots as JSON. Capture it before a change, capture it after, diff the two.
It catches differences nobody thought to write an assertion for.

The second is stronger and suits refactors that must not change behaviour at all.
Dump the entire assembled config — every node, with functions collapsed to a marker
so guard and action *presence* is compared — and diff it against the same dump taken
from a `git worktree` at the previous commit. The states-and-transitions split was
gated on that diff being byte-identical across 1,359 lines.

---

## Part 25 — Recipes

**To add a question**, append a state to `pgr-states.js` or `seva-states.js`, wire it
into the matching `-transitions.js`, and add its copy to the bundle file. Pick the kind
by what the citizen does: reads (`say`), types (`ask`), picks from a list (`choose`),
descends a tree (`walk`), waits on a backend (`call`). If it belongs inside a group,
`layout.place` needs a line too.

```js
// 1. pgr-states.js - the new state says nothing about where it goes
{ key: 'severity', kind: 'choose',
  options: ['Low', 'High'],
  prompt: messages.fileComplaint.severity.question,
  slot: 'severity' },

// 2. pgr-transitions.js - splice it into the chain
description: 'severity',                        // was 'imageUpload'
severity:    { Low: 'imageUpload', High: 'imageUpload' },

// 3. layout.js place - or it sits at the top level instead of inside fileComplaint.other
severity: ['fileComplaint', 'other'],

// 4. pgr.js messages - the copy
severity: { question: { code: 'chatbot.pgr.severity.question',
                        en_IN: '...', pt_PT: '...' } }

// 5. egov-pgr.js persistComplaint - read the new slot, or it goes nowhere
```

You do not need to touch `layout.js` unless the step belongs in a *new* group. A step
with no `place` entry sits at the top level of its journey, which is correct for most
additions. If you do name a group that the layout does not define, the generator
throws at require time rather than quietly misplacing the state.

**To change wording**, edit the bundle. If it has a `code` and the deployment has a
translation for that code, the live translation wins — so check there too, or your
edit will appear to do nothing. Adding a locale means adding a key to *every* bundle,
because the language menu only offers locales with complete coverage.

**To store a new answer**, add a `slot` to the step and read it in `persistComplaint`.
Update the slot-contract test to include the new key. Do not write to `context`
directly from a step; that is what `slot` and `set` are for, and the indirection is
what keeps the data flow findable later.

**To add a validation rule**, give the `ask` step a `validate` function. Return `true`
to accept, a message bundle to reject with a specific complaint, or `false` to reject
with the generic retry. Read the bound from configuration rather than writing a
number, and show it in the prompt with a placeholder.

**To call a new backend**, add the method to the appropriate service module, then a
`call` step whose `src` invokes it. Give every failure path a destination — in
practice `#system_error`, which the generator supplies by default. Make the method
`async` even when it could throw synchronously, because a synchronous throw inside an
invoke escapes `onError`.

**To rename a state**, understand that saved conversations reference it by name. The
resume fallback means the citizen gets a fresh session rather than a permanent brick,
but they do lose their place, and telemetry strings change shape at the same time. It
is a deliberate act with a cost rather than a tidy-up.

**When something is stuck**, check three things in order. Does the guard array of the
`process` state have an unconditional last entry? Does every target in that region
resolve? Does every `invoke` have an `onError`? Those three account for essentially
every wedged conversation this codebase has produced, and all three are now generated
or checked.

**Before you commit**, run the suite and walk the flow on the console channel in both
locales. The suite catches structure and regressions; the walk catches wording,
ordering, and the class of problem that only looks wrong when you read a transcript
the way a citizen would. Neither substitutes for the other.

---

## Part 26 — Gotchas worth knowing in advance

Guard order is behaviour. In a walk it decides whether "Go Back" is treated as a
category. In a triplet it decides whether an unrecognised reply retries or wedges.
When you read an `always` array, read it as a sequence of attempts and ask what
happens when none of them match — that last entry is the whole safety net.

```js
// the same shape, read twice. The last entry is the whole difference.
always: [ { target: 'a', cond: f }, { target: 'b', cond: g } ]          // can wedge
always: [ { target: 'a', cond: f }, { target: 'b', cond: g },
          { target: 'error' } ]                                        // cannot
```

`assign` bodies must not accidentally return an object. In v4 a returned object
*replaces* the context wholesale. Writing `assign((c) => c.x = 1)` happens to be
harmless because the result is a primitive, but the same shape with an object literal
would silently wipe the entire conversation. Always use braces, and the generator's
own emitters do exactly that.

Anything a state computes on entry and reads on the *next* message must be stored in
context, because entry actions do not re-run on resume. Anything it computes and uses
within the same turn need not be. Confusing the two produces bugs that appear only
across a deploy or a restart, which is the worst time to find them.

Inside an `always` transition's action, the triggering event is not visible —
`event.data` is `undefined`. If you need the payload of the thing that got you here,
use an entry action. That is what the `effect` field on `say` exists for, and it is
why error payloads reaching `system_error` were silently discarded for a long time.

The reset keyword is the citizen's only universal escape, and it works because of one
rule at the root of the machine rather than anything in the individual states. If you
find yourself adding per-state handling for "hi" or "egov", you are reimplementing it
and will get it subtly wrong somewhere.

`InMemory` is the default repository, so conversations not surviving a restart is
expected rather than broken. Similarly, a script that requires this module without the
deployment's environment variables will silently fall back to defaults — a different
tenant, an unreachable host — and produce answers that look entirely real. Check the
environment before believing a local probe.

Finally: the number "1" means different things in different states, and that is by
design. It is the first menu option, the skip token at the attachment question, and
acceptance at both confirmations. What it means is decided by the grammar of the state
you are in — which is precisely why the position has to be stored, and why this is a
state machine.

---

## Appendix — Map of files

| Path | What it is |
|---|---|
| `src/app.js` | Express server, port, context path |
| `src/env-variables.js` | Every environment variable, with defaults |
| `src/channel/index.js` | Picks the channel adapter at startup |
| `src/channel/routes/index.js` | The webhook endpoints |
| `src/channel/{twilio,console,value-first,kaleyra}.js` | Provider adapters |
| `src/session/session-manager.js` | Orchestrates a turn; the outbound path |
| `src/session/{standard,sandbox}-login-flow.js` | Identity, behind one contract |
| `src/session/chat-service.js` | Builds and drives the machine; persistence |
| `src/session/chat-state.js` | Value wrapper for the persisted blob |
| `src/session/inbound-message-parser.js` | Request to neutral payload; no imports |
| `src/session/upload-tenant.js` | Which tenant an attachment belongs to |
| `src/session/repo/` | In-memory and Postgres state storage |
| `src/session/user-service.js` | Mobile number to DIGIT user |
| `src/machine/seva.js` | Assembles the one machine — read this first |
| `src/machine/pgr.js` | Filing shell, filing copy, merges |
| `src/machine/flow/{pgr,seva}-states.js` | What each step asks, as data |
| `src/machine/flow/{pgr,seva}-transitions.js` | The graph: every exit, every group start |
| `src/machine/flow/join.js` | Folds the two tables into one step list |
| `src/machine/flow/layout.js` | Where each step sits in the tree |
| `src/machine/flow/messages-seva.js` | Onboarding and chassis copy |
| `src/machine/flow/generate.js` | Steps to XState nodes; the boot check |
| `src/machine/flow/offered-locales.js` | Which languages the menu offers |
| `src/machine/flow/legacy-*.js` | Unreachable, retained deliberately |
| `src/machine/util/dialog.js` | Prompt, grammar and send primitives |
| `src/machine/util/inbound-*.js` | Transport models for the payload |
| `src/machine/util/localisation-service.js` | Live translations and locales |
| `src/machine/service/egov-pgr.js` | MDMS, boundary, filestore, complaints |
| `test/flow-generate.test.js` | The generator, no product copy |
| `test/flow-join.test.js` | The join, and its four boot checks |
| `test/pgr-flow.test.js` | The filing flow, table-driven |
| `test/session-resume.test.js` | Save and resume, including the brick case |
| `test/offered-locales.test.js` | Which languages are offered |

**Read in this order on your first day:** `seva.js` for the assembly, then
`seva-transitions.js` for the shape of a conversation in one screen, then
`seva-states.js` for what each step asks, then `generate.js` to see what a step
actually becomes, and `dialog.js` for the primitives underneath all of it. That is
roughly an hour of reading and it covers the entire live flow.
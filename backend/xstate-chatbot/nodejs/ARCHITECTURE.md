# The xstate-chatbot module, top to bottom

A guide for someone who has never opened this code. It starts at the outermost
boundary — a WhatsApp message arriving over HTTP — and works inward to the
individual guard conditions that decide where a conversation goes next. Read it
in order; each part assumes the one before it. Budget 30–40 minutes.

Paths are relative to `backend/xstate-chatbot/nodejs/`.

---

## Part 1 — What this module is

This is a conversational front end for filing citizen grievances. A citizen
sends WhatsApp messages; the bot replies with numbered menus; at the end a
complaint row exists in the PGR backend exactly as if it had been filed through
the web portal. It is one service among many in a DIGIT deployment, and it owns
no data of its own beyond conversation position.

Everything the bot knows comes from other services. Complaint categories come
from MDMS, geographic areas from the boundary service, translated text from the
localisation service, the citizen's identity from the user service, attachments
from filestore, and the complaint itself goes to `pgr-services`. The bot is
orchestration and dialogue; it is not a system of record.

The module is a small Express application. `src/app.js` builds the server,
mounts one router, and listens on `SERVICE_PORT` (default `8082`) under
`CONTEXT_PATH` (default `/xstate-chatbot`). It also installs a catch-all proxy
to the DIGIT gateway, which matters mainly because it means unmatched paths do
not 404 the way you might expect.

There is no build step and no TypeScript. It is plain CommonJS JavaScript on
Node, with `require` and `module.exports`. Dependencies are few: Express,
`xstate` 4.38.3, Axios, `moment-timezone`, `uuid`, and a Postgres driver. There
is no framework layer between you and the code and no code generation at build
time. What you read is what runs, which makes the module unusually easy to reason
about once you know where to look.

The single most important thing to understand before reading any file: **the bot
holds no conversation in memory between messages.** Each inbound WhatsApp
message is a separate HTTP request, possibly served by a different process.
Where the citizen "is" in the conversation is data, loaded and saved on every
turn. Everything else in this document follows from that fact.

---

## Part 2 — The path of a single message

A citizen types "1" and presses send. WhatsApp delivers it to Twilio, Twilio
POSTs a form-encoded body to a public URL, and that URL routes to
`src/channel/routes/index.js`, `POST /message`. This is the module's only real
entry point for conversation, and every feature in this document is ultimately
triggered from it. Everything after that route is internal, synchronous within
the turn, and unaware that HTTP exists at all.

The route hands the raw request to the active channel adapter's
`processMessageFromUser`. The adapter's job is translation: take a
provider-specific payload and return one neutral shape, or `null` if the payload
is not a user message at all — a delivery receipt, for instance. Nothing
downstream knows Twilio exists, which is exactly why the same machine can be
driven from a terminal during development.

That neutral shape is called the *reformatted message* throughout the codebase.
It carries three things: `user` (mobile number, and after lookup a userId and
locale), `message` (`{ type, input }` where type is `text`, `image`, `document`,
`location` or `button`), and `extraInfo` (the tenant, the business number the
citizen wrote to, and similar envelope data).

The route then calls `sessionManager.fromUser(reformattedMessage)` and — this is
deliberate — does not await it. It replies to the webhook immediately. If it
waited for the whole backend round trip, the provider would time out and retry,
and the citizen would receive duplicate messages. A `.catch` is attached so a
failure is logged rather than becoming a silent unhandled rejection.

`fromUser` in `src/session/session-manager.js` is where the conversation
actually happens. It resolves the mobile number to a DIGIT user, decides whether
this message is a reset keyword ("hi", "egov", "start" and friends), loads any
active conversation state from the repository, and either resumes it or creates
a fresh one.

It then builds a running machine from that state and sends it one event, either
`USER_MESSAGE` or `USER_RESET`. Sending the event is the whole turn: the machine
moves through as many states as its rules allow, emits outbound messages along
the way, and comes to rest waiting for the next message. Then the process is
free to forget everything.

Outbound text travels the reverse path. Machine code calls
`dialog.sendMessage(context, text)`, which appends to `context.output` and, when
told to flush, calls `context.chatInterface.toUser(...)`. `chatInterface` is the
session manager itself, placed into context when the conversation starts, which
is how machine code reaches the outside world without importing it. The session
manager hands the batch to the channel adapter and logs each message to
telemetry.

Note the batching: `sendMessage(context, text, false)` accumulates without
sending. This is how a retry notice and the re-asked question arrive as one
WhatsApp delivery instead of two, which matters because two deliveries can
arrive out of order on a slow handset. When you see `false` as the third
argument, that is what it means — hold this, more is coming — and the next
flushing send delivers everything queued.

---

## Part 3 — Why a state machine

Consider filing a complaint: pick a category, pick a sub-category, name the
institution, describe the problem, optionally attach a photo, pick a city, pick
a ward, accept two consent statements, choose confidentiality. Nine questions,
each with retries, each with a "go back", each needing its answer remembered
until the very end when the complaint is finally assembled and posted to the
backend as a single request.

Written as ordinary code this becomes a tangle of flags. Where are we? What did
they already answer? Is this "2" a menu choice or a rejection? Because each
message is a fresh HTTP request, you cannot use a call stack or a loop — the
function that asked the question has already returned by the time the answer
arrives.

A state machine solves exactly this. The conversation position is one value. The
rules for what each input means are attached to that position, not scattered
across conditionals. Serialising the position is trivial, which is what makes
the stateless-request problem go away. And the set of reachable positions is
enumerable, so you can reason about the whole dialogue.

The library used is XState. It is worth being blunt about the version: this is
XState **4**, and the modern XState 5 documentation you will find by searching
does not apply. There are no `@xstate/*` companion packages, no `setup()`, no
`createMachine` with actors. The idioms here are v4 idioms and some of them look
dated. They are correct for 4.38.3.

---

## Part 4 — XState v4, from zero

A **machine** is a description of states and the transitions between them. It is
inert data — creating one runs no logic. `Machine({ id, initial, states })`
returns this description. In this codebase there is exactly one machine, built
in `src/machine/seva.js`, and everything else is a fragment merged into it.

A **state node** is one entry in `states`. A node with no children is a leaf,
and the machine rests in leaves. A node with a `states` object of its own is
*compound*: entering it means entering its `initial` child. Compound states are
how the conversation gets its structure — "we are in the filing journey, in the
location step, at the question".

An **event** is something that happens to the machine. This codebase uses two:
`USER_MESSAGE` and `USER_RESET`. That is the entire alphabet. Every branch in
the dialogue is decided not by different event types but by inspecting the text
that came with the event, which is why so much of the interesting logic lives in
guards rather than in the event names themselves. Keep that in mind when reading
transitions.

A **transition** says: on this event, in this state, go there. Written as
`on: { USER_MESSAGE: 'process' }`. A transition may name a sibling by bare name,
or any state anywhere by `#id` if that state declared `id: 'something'`. The
`#id` form is how this codebase jumps between distant parts of the tree.

**Context** is the machine's memory: one plain object, carried alongside the
state value. Here it holds the citizen's identity, the tenant, the answers
gathered so far, and scratch data. Unlike the state value, context is
unstructured — it is whatever the code puts there, which is both convenient and
the source of several historical bugs.

An **action** is a side effect attached to entering a state or taking a
transition. `onEntry` runs on entry. In v4, actions that change context must be
wrapped in **`assign`**. This codebase uses `assign` for everything, including
sending messages — technically an impurity, but it is the established pattern
and changing it is a separate refactor.

A **guard** — written `cond` — is a predicate that decides whether a transition
is allowed. When several transitions are listed for the same event, XState tries
them in order and takes the first whose `cond` passes. **Order is therefore
semantic, not cosmetic.** Reordering a guard array can change behaviour, and in
the tree walks it definitely does.

An **eventless transition** — written `always` — fires as soon as the machine
enters the state, without waiting for input. This is how the bot chains
automatic steps: a state sends a message on entry, then `always` moves straight
on. A guarded `always` array is a fork in the road. A state whose `always` has
no unconditional last entry can get stuck; more on that later.

**`invoke`** starts an asynchronous job on entry, typically a promise. Its
`onDone` transition fires when the promise resolves, with the resolved value on
`event.data`; `onError` fires when it rejects. Every backend call the bot makes
during a conversation goes through `invoke`. A state with `invoke` and no
`onError` will wedge if the call fails.

An **interpreter** — created by `interpret(machine)` and started with `.start()`
— is a running instance, called a *service*. The machine is the recipe; the
service is the meal. `service.send(event)` drives it. `service.state` is the
current snapshot, exposing `.value` (position), `.context` (memory), `.done`,
and `.matches(...)` for asking "am I here?". In this codebase a service lives
for exactly one HTTP request.

Finally, **serialisation**. `service.state` can be JSON-stringified and later
revived with `State.create(json)` and `machine.resolveState(state)`. That pair
is what lets the conversation survive between HTTP requests, and its failure
modes are the subject of Part 15. Note what does *not* survive: entry actions do
not re-run, and invoked promises do not restart.

---

## Part 5 — Two layers: hand-written machine, generated machine

Until recently the whole machine was hand-written: every question was three
state nodes typed out by hand, and the two files came to about 2,075 lines of
which roughly three quarters was repeated structure. The same behaviour — send a
retry, ask again — existed in seven slightly different spellings.

The module now has two layers. A **step table** describes the conversation as
ordered plain data, one entry per question. A **generator** turns each entry
into the XState nodes it needs. The generator is the only file that knows
XState's shape; the step tables mention no state names, no guards, and no
transitions.

The payoff is that the live conversation reads as roughly 320 lines of data
instead of 976 lines of nested state nodes, and that invariants are enforced in
one place rather than remembered nineteen times. The cost is one indirection:
to see the actual states, you read the generator, not the flow.

Some states remain hand-written, deliberately. The chassis — `start`,
`welcome`, `endstate`, `system_error` — is small, unusual, and is the error
backstop, so generating it would buy nothing. One onboarding question stays hand
written because its options are fetched at runtime and its prompt formatting
differs. Those exceptions are commented where they live.

Two files hold code that is unreachable but kept on purpose:
`src/machine/flow/legacy-location.js` (the old GPS and fuzzy-search location
flow) and `legacy-organization.js` (multi-tenant onboarding by organisation
code). They still compile and are still merged into the machine, so their `#id`
targets resolve and the boot-time consistency check passes, but nothing routes
into them. Part 20 explains the reasoning and how to revive them.

---

## Part 6 — The machine from the top

`src/machine/seva.js` builds the one machine, id `mseva`. Read the bottom of
that file first: it assembles a config object, merges generated onboarding
states into it, merges the legacy organisation states, runs a boot-time
consistency check, and only then calls `Machine(...)`. The order matters and Part
21 explains why.

At the root there is a global rule: `on: { USER_RESET: '#welcome' }`. Because it
sits at the root it applies from anywhere, which is what makes typing "egov"
work at any point in any conversation. It is the single most useful escape hatch
in the product, and it is one line.

`start` is where a brand-new conversation begins. It only waits, and on the
first message forks: if the citizen already has a locale, go to `#welcome`;
otherwise go to `#onboarding` to ask which language they want. It sends nothing
itself.

`onboarding` establishes identity: language, then name, with confirmation.
Roughly eight states. It ends by calling the user service to save the profile
and then hands control to `#pgr`. A returning citizen normally skips it
entirely.

`welcome` greets the citizen and routes into `#pgr`. `endstate` marks a finished
conversation and loops back to `start`. `system_error` is the failure backstop:
every `invoke` that can fail targets it, and it apologises to the citizen rather
than leaving silence.

`pgr` is the product: the grievance menu, filing, and complaint tracking. It
lives in its own file, `src/machine/pgr.js`, and is spliced in as a child of the
root. Its own root has an `onEntry` that clears the answer bag, so starting a
new complaint never inherits a previous one's data.

---

## Part 7 — The filing journey

Inside `pgr`, `menu` offers two options: file a complaint, or track existing
ones. Choosing to file enters `fileComplaint`, which is a compound state with
three groups plus the closing steps. Read them in the order the citizen meets
them, not the order they appear in the file — the source order is historical and
the retained dead code sits in the middle of it, which makes a top-to-bottom
read misleading.

First `type`, containing `complaintType2Step`: a walk down the complaint
category tree from MDMS. It may be two levels deep or five; the code does not
know and does not care, because the depth is a property of the deployment's data
rather than of the dialogue. It ends when it reaches a level marked as a leaf,
storing the chosen code as the complaint type.

Then `other`, containing three plain questions: which institution the grievance
concerns, a free-text description with a configured minimum length, and an
optional attachment. The attachment step accepts images and documents, or the
literal "1" to skip — a deliberately blunt convention that needs no translation
and works on any handset. These three are the simplest states in the machine and
the best place to start reading.

Then `location`, containing `boundary`: the same kind of walk, this time down
the administrative boundary tree from the boundary service. It ends by recording
the city and the locality, which together tell the backend where the problem is.
This group also contains the retained dead GPS flow as unreachable siblings, so
do not be alarmed by the volume of code sitting next to a fourteen-line step.

Then the closing sequence: `consent` presents two statements and requires
acceptance — declining sends a notice and ends the session without filing
anything — followed by `confidentiality`, which asks whether to flag the
complaint as confidential, and finally `persistComplaint`, which calls the
backend and sends the receipt with a category, a reference number and a date.
That receipt is the citizen's proof of filing.

`trackComplaint` is the other branch from the menu and is much simpler: one
backend call, then either a formatted list of the citizen's complaints or a
"nothing found" message. Either way it ends the session.

---

## Part 8 — The triplet: the core idiom

Almost every question in this bot is three states, and once you see the pattern
the machine becomes easy to read. The three are `question`, `process`, and
`error`, and they are children of a compound state named after the question
itself — `institution`, `consent`, `boundary`. Learn this shape and you can
navigate any part of the dialogue, because the exceptions are few and all of
them are commented.

`question` renders the prompt on entry and then waits:
`on: { USER_MESSAGE: 'process' }`. It is the only one of the three that blocks.
Anything the citizen needs to see is sent here, which is why re-entering
`question` re-asks the question — that property is used deliberately.

`process` interprets the reply on entry, writing what it concluded into context,
and then decides with a guarded `always` array where to go. It never sends
anything and never waits. Understanding a state machine in this codebase is
mostly reading `process` blocks.

`error` sends a retry message and immediately returns to `question` via
`always`. Because it uses the non-flushing form of `sendMessage`, the retry and
the re-asked question arrive together. Every failed input in the product ends up
here, whatever the reason.

The critical detail is the last entry of `process`'s guard array. If every entry
has a `cond` and none matches, the machine stays in `process` — which has no
`on` handler at all — and no future message can move it. The citizen is
permanently stuck. Two states in onboarding had exactly this shape and both were
reachable in normal use.

That is the class of defect the generator eliminates by construction: it always
emits a final unconditional `{ target: 'error' }`. Not because someone
remembered to on that particular day, but because there is one emitter and it is
written that way once. The same reasoning applies to the other invariants in
Part 10 — the value is not the individual fix but that the fix cannot be
forgotten.

---

## Part 9 — The step vocabulary

A step is a plain object. It has a `key` (which becomes its state name), an
optional `id` (emitted when something targets it with `#`), an optional `path`
saying where in the tree it belongs, and a `kind`. There are five kinds, and
between them they cover every question in the product.

**`say`** sends a message and moves on. One state, no waiting, no `on` handler.
Use it for anything the citizen reads but does not answer: the welcome, the
thank-you, the consent-declined notice. If you find yourself sending a message
from a transition action, it should probably be a `say` step instead.

**`ask`** captures free text or media. It declares what it will `accept`, an
optional `validate` predicate, and where to store the answer. Its retry message
can be specific — "that name is too long" — falling back to the generic one.
This is the institution, description, attachment and name questions.

**`choose`** presents a closed set of options and branches on which was picked.
It declares `options`, and a `next` map from option to destination. The grammar
that recognises replies is derived from the options, so the numbering and the
recognition can never drift apart. Menus and yes/no confirmations are all
`choose`.

**`walk`** handles a tree of unknown depth fetched from a backend. It declares
how to fetch a level, which slot holds the path so far, and where to go on
reaching a leaf. It is the most complex kind and the only one whose meaning is
not obvious from its name — read Part 14 before changing one.

**`call`** performs a backend operation and branches on the result. It declares
the promise to run and a list of outcome branches, each optionally with a
condition, a message and a data write. Filing the complaint, listing complaints,
and saving the user profile are all `call`. Every one of them gets a failure
destination automatically, which is what stops a backend outage from turning
into a silently frozen conversation.

Anywhere a destination appears, it may be a bare string or an object with `to`
plus extras: `when` for a condition, `set` for a write, `message` for outbound
text. This is one grammar reused in `next` strings, `next` arrays, `next` maps
and `onDone` lists, rather than four separate mechanisms to learn.

Message text is never written inline in a step. A step points at a *bundle* — an
object of locale-keyed strings with an optional localisation `code` — and the
generator resolves it at send time using the citizen's locale. Placeholders like
`{{maxLength}}` are filled from the step's `fill` map. This separation is what
lets a translator change wording without touching flow logic, and vice versa.

`fill` values may be literals, bundles, or functions of `(context, event)`.
A function is how a step computes something: the consent statements joined into
a bullet list, the complaint reference from the backend response, today's date.
Anything more than a lookup belongs in a small named function next to the table.

Two design rules keep the vocabulary from sprawling. No field is added for a
single step's benefit; if only one step needs it, that step stays hand-written
instead. And there is no expression language — conditions and derived values are
short arrow functions in the data, not strings to be parsed.

---

## Part 10 — The generator

`src/machine/flow/generate.js` is about 390 lines and exports three functions.
`generate(steps, wrappers)` turns a step table into a states object.
`mergeStates(target, source)` grafts that into an existing tree.
`assertTargets(states)` checks the assembled result. Everything else in the file
is private.

Internally it is one emitter per kind over a handful of shared helpers, and no
function is long. `questionState`, `errorState` and `readInput` are shared by
`ask` and `choose`; `render` and `emit` handle text; `transitions` builds guard
arrays. If you want to know what a step becomes, find its emitter and read
downward.

`generate` walks the table and places each step at its `path`, creating
intermediate wrapper nodes as needed and taking their `id` from the `wrappers`
table. A step marked `first` becomes its parent's `initial`. This is how the
step data avoids mentioning nesting while still producing the exact tree the
machine had before.

`mergeStates` is what makes incremental change safe. When a generated node and
an existing hand-written node occupy the same key and both are compound, it
recurses into their children rather than overwriting. A plain assignment would
have replaced a whole subtree — during the migration, that would have silently
deleted forty states.

Four invariants are emitted unconditionally, and each one closes a defect that
existed when the states were hand-written. Input type is always validated before
the reply is interpreted. Every guard array ends unconditionally. Walk guard
order is fixed by the emitter rather than by the author. And there is exactly one
retry implementation, replacing seven textual variations of the same three lines.

The first invariant deserves explanation. `dialog.get_input` throws a
`TypeError` when the message payload is not a string, which happens for a shared
location pin. Six hand-written states called the interpreter without checking
first, so a location pin at the consent prompt threw out of `service.send`. Now
the check is not something a step can forget.

The generator also refuses malformed step tables at load time rather than
producing a broken machine. A `choose` that offers an option with no
destination throws immediately, naming the step and the option — because the
alternative is a citizen who picks a listed option and is told it is invalid,
forever.

---

## Part 11 — Slots: the answer bag

Answers accumulate in `context.slots.pgr`, a flat object. `complaint`,
`instituteName`, `description`, `image`, `city`, `locality`, `isConfidential`,
plus `hierarchyPath` and `boundaryPath` which are the walks' working state rather
than answers as such. This bag is what gets turned into a complaint at the end,
and it is cleared whenever the citizen re-enters the grievance menu so a new
complaint never inherits an old one's data.

A step writes to it by naming a `slot`. The generator does the assignment, so the
step data never touches `context` directly for the common case. A `choose` step
can also transform the value on the way in: the confidentiality question stores a
real boolean rather than the string "Yes", which is what the backend expects and
what the receipt logic reads.

For anything outside that bag — the citizen's locale, the onboarding name — a
step supplies a `set` function instead, receiving the context and the captured
value. Two mechanisms rather than one, but both are trivial and neither requires
a path resolver or an expression language. Prefer `slot` whenever it fits, and
reach for `set` only when the destination genuinely lives elsewhere.

The consumer is `persistComplaint` in `src/machine/service/egov-pgr.js`. It reads
the bag and builds the PGR request body, including an `extendedAttributes` object
carrying the institution name, the confidentiality flag, and a deployment-level
case category. If you add a slot, that function is where it must be read —
writing a slot nobody reads is the easiest silent mistake to make here.

There is no schema. Nothing stops a typo in a slot name from silently producing
a complaint with a missing field. The mitigation is a test that asserts the exact
set of slot keys after a happy path, so a rename fails on the same commit that
introduces it. Treat that test as the contract.

---

## Part 12 — Text and translation

All outbound text lives in message bundles, which are objects keyed by locale —
`en_IN`, `pt_PT` — with an optional `code`. The bundles for the filing flow sit
in `src/machine/pgr.js` below the machine; onboarding's sit in `seva.js`. They
are ordinary data, safe to edit, and deliberately kept next to the flow they
serve rather than in a separate translation file.

`dialog.get_message(bundle, locale)` resolves one. If the bundle has a `code` it
first asks the localisation service for a live translation of that code; if that
yields nothing usable it falls back to the bundle's own text for the locale, and
failing that to `en_IN`. So translations can be updated in DIGIT without a
deploy, while the code still runs standalone.

`src/machine/util/localisation-service.js` fetches those translations once at
module load and caches them. It queries two tenants — the state root and the
deployment tenant — because the localisation search API returns rows from the
first tenant in the chain that matches and then stops, rather than merging. That
detail has cost real debugging time.

The service also supplies the list of offered languages via `getLocales()`,
derived from what is actually declared in the platform rather than hardcoded in
the source. The language menu is built from that list, which is why adding a
locale is a data change rather than a code change — though you still need the
bundle keys as a fallback for when the platform is unreachable.

Placeholders use double braces: `{{maxLength}}`, `{{statements}}`, `{{name}}`,
and positional `{{1}}` `{{2}}` `{{3}}` in the filing receipt. The generator
substitutes them from the step's `fill` map. A placeholder with no matching
`fill` entry is left in the text rather than blanked — visible in the transcript,
which is the point, because a silently missing value is far harder to notice.

Two rules about substitution, both learned the hard way. A `fill` value that
resolves to nothing renders as an empty string, not the word "undefined" and not
a stray comma. And a `fill` entry whose placeholder does not appear in the text
is never evaluated, so a function that would throw on missing data does not.

Reused platform keys are worth noting. The consent statements and the
confidentiality label point at the same localisation codes the web portal uses,
so the bot and the portal cannot drift apart in wording. When you add citizen-
facing text, check whether the portal already has a key for it.

---

## Part 13 — Understanding what the citizen typed

The bot recognises replies by *grammar*: a list of `{ intention, recognize }`
pairs, where `recognize` is an array of accepted strings and `intention` is the
symbol the machine reasons about. `dialog.get_intention(grammar, event, true)`
returns the matching intention, or a sentinel meaning "not understood". The
third argument selects exact matching rather than substring matching, and every
call in the live flow uses it.

The product is deliberately numbers-first. A menu of three options accepts "1",
"2", "3". This is not laziness: it works on every handset, needs no translation,
and avoids the ambiguity of free text in a language the bot may not have been
tested in. Confirmations additionally accept the word forms, so "yes" works as
well as "1" for anyone who types naturally.

For a `choose` step the grammar is derived from the step's `options` — the
prompt's numbering and the recognition come from the same list, so they cannot
disagree. This matters more than it sounds: previously two hand-written
confirmation grammars had drifted apart, so "yes" was accepted at the name
confirmation and rejected at the consent question, for no reason anybody
intended.

For a `walk` the option list is fetched from a backend, so the grammar is built
at render time by `dialog.constructListPromptAndGrammer`. That helper returns
the numbered prompt text and the matching grammar together, and appends a "Go
Back" option when the citizen is not at the top of the tree.

There is an important asymmetry between those two cases. A `choose` step's
grammar is a constant, so it is held in the emitter's closure. A `walk`'s
grammar is dynamic and must survive to the next HTTP request, so it is stored in
`context.grammer`. Storing a constant there would add a way to fail — see the
next part.

`validateInputType(event, accepted)` is the separate question of *kind*: was
this text, an image, a document, a location, a button reply? Text questions
accept text and interactive button replies. The attachment question accepts
images and documents. This check always runs before interpretation.

---

## Part 14 — The tree walks

Two questions in the product are not questions but descents through a tree of
unknown shape: the complaint category, and the administrative area. Both are
driven entirely by backend data. Neither the depth nor the labels are in the
code, which is why a new deployment can restructure its categories without a
code change.

A walk is five states. `fetch` invokes the backend for the current level.
`evaluate` looks at what came back and decides whether there is anything to ask.
`question` renders the numbered list and waits. `process` interprets the choice.
`error` retries. The cycle repeats, one level per pass, until a level announces
itself as the last one — so the same five states serve a tree of any depth.

The path so far lives in a slot — `hierarchyPath` or `boundaryPath` — as an
array of codes. Descending pushes the chosen code; going back pops it. The fetch
function receives that array and returns the level below it, along with the
labels to display and a flag saying whether this level is the last.

`process`'s guard order is the subtlety, and it is fixed by the generator for
good reason. Go-back is tested first, because the "Go Back" option is a real
grammar entry and would otherwise satisfy the later guards — choosing it at a
leaf level would have filed a complaint whose category was literally "goback".

Leaf is tested before descend. If descend won, the leaf's own code would be
pushed onto the path and the next fetch would run against a level that does not
exist. Both of these were correct in the hand-written code by careful typing;
now they are correct because there is one emitter.

Ahead of all of those sits a guard for missing fetched data. A conversation
resumed mid-walk has the path but not the fetched level, because entry actions do
not re-run on resume. Without the guard, reading the leaf flag off undefined
throws. With it, the walk simply fetches again and re-asks, costing the citizen
one prompt.

`evaluate` exists for the case of a level with no options. For the boundary walk
that means the citizen has descended as far as the data goes, so it records what
it has and moves on. The category walk has no such escape, deliberately: there
is no sound complaint to file without a category.

The backend side lives in `src/machine/service/egov-pgr.js`.
`fetchComplaintHierarchyStep` reads the MDMS category definition and the category
rows, orders any "Other" option last, and returns exactly one level.
`fetchBoundaryStep` does the equivalent against the boundary hierarchy. Both
return the same shape — options, labels, a level name and a leaf flag — which is
precisely why one emitter can serve both.

---

## Part 15 — Saving and resuming a conversation

After every transition the session manager serialises the state — position and
context — trims the user object down to locale, userId and mobile number, and
writes it to the `eg_chat_state_v2` table against the citizen's id, along with
telemetry describing the move. The write is fired without being awaited, so two
transitions in one turn race and ordering is not guaranteed.

Which repository is used depends on `REPO_PROVIDER`. The default is `InMemory`,
which means a restart forgets every conversation — fine for local work, useless
in production. `postgres-repo.js` is the real one. The distinction catches people
out when a local session survives nothing and they go looking for a bug that is
actually a default value doing its job.

On the next message the stored JSON is revived: `State.create(json)` rebuilds a
state object, `machine.resolveState(...)` reattaches it to the machine, and
`interpret(machine).start(resolvedState)` resumes there. The citizen's identity
and tenant are refreshed from the incoming message first, since the saved copy
may be stale: before writing, `removeUserDataFromState` reduces `context.user` to
just locale, userId and mobile number, and blanks the stored event.

Three things do **not** come back, and each has bitten this codebase. Entry
actions do not re-run, so anything a state wrote on entry must have been
persisted. Invoked promises do not restart, so a conversation saved while
waiting on a backend call cannot advance on its own. And the "changed" flag is
absent, which incidentally prevents a crash in the transition logger.

The dangerous failure is a stored position naming a state the machine no longer
has — the inevitable result of renaming a state and deploying. `resolveState`
throws, and it throws *before* the event is sent, so the reset keyword cannot
save the citizen either. The row stays active, and every future message repeats
the same throw. That is a permanent brick.

The fix is small and important: the rehydration is wrapped, and on failure the
error is logged and a fresh conversation is started, carrying forward only the
citizen and the tenant. The stale answer bag and grammar are deliberately thrown
away, because they describe a position that no longer exists. The citizen sees
the welcome message.

One consequence worth knowing: conversations are never marked complete in
practice, because the end state loops back to `start` rather than being declared
final. So the "active" flag stays true and old state is always revived on the
next message. The resume fallback described above is what makes that arrangement
safe rather than fragile, and it is why that fallback is not optional.

---

## Part 16 — Channels

`src/channel/index.js` picks one adapter at startup from `WHATSAPP_PROVIDER`:
`Twilio`, `ValueFirst`, `Kaleyra`, or the console fallback. Every adapter
implements the same two functions — `processMessageFromUser` inbound and
`sendMessageToUser` outbound — and nothing else in the codebase knows which is
active.

The console adapter is how you develop. It reads from and writes to the terminal,
needs no external account or public URL, and exercises the identical machine. If
you are changing dialogue, use it: the loop is seconds rather than minutes and
you can see the whole transcript at once, which is the only practical way to
judge whether wording and ordering read well.

The Twilio adapter handles form-encoded webhooks: `From`, `To`, `Body`,
`MediaUrl0`, `MediaContentType0`. Outbound numbers must be built as
`whatsapp:+<country><national>`, and getting that wrong produces a Twilio error
code rather than a delivered message — which looks exactly like the bot ignoring
the citizen. The country prefix comes from configuration, never from a literal in
the source.

Media handling is where adapters do real work. An inbound image arrives as a URL;
the adapter classifies it as `image` or `document` by content type, and the
machine later downloads it and pushes it to filestore. Allowed document formats
are a deployment concern and are configured on the filestore side too.

Interactive button replies arrive with a distinct type but a plain string
payload. Text questions accept them for that reason: a citizen tapping a
quick-reply button is answering the question, and rejecting that as "invalid"
would be a bug lying in wait for the day rich templates are switched on. No
outbound template currently uses buttons, so this is insurance rather than an
active code path.

Local development against a real WhatsApp number needs a public URL for the
webhook, which in practice means a tunnel to the machine and a sender configured
in the provider console. That is a deployment task rather than a code one, but it
is the only way to test the real adapter end to end — media handling in
particular cannot be exercised from the terminal.

---

## Part 17 — The backend services

`src/machine/service/service-loader.js` is a thin indirection that exports the
service objects. It exists so tests can replace them wholesale. Anything that
talks to the network should be reachable through it, and code that captures a
service at module load time defeats it — a mistake worth avoiding.

`egov-pgr.js` is the large one. Besides the two walk functions it holds
`persistComplaint`, which assembles and posts the complaint;
`fetchOpenComplaints`, which lists the citizen's existing ones; `fetchMdmsData`,
the generic MDMS query used by everything else; and the filestore upload and
download helpers.

`egov-user-profile.js` saves the citizen's name and language during onboarding.
`user-service.js` in the session layer resolves a mobile number to a DIGIT user,
creating one if needed. Its number normalisation is country-configurable, which
matters because the same digits mean different things in different deployments.

Requests to DIGIT need an authenticated envelope, and MDMS in particular is
sensitive to the tenant in the query. When a lookup returns nothing, suspect the
tenant before suspecting the data — Part 18 explains why that is the usual cause.
An empty options list is the symptom, and because an empty list is not an error,
it surfaces as an odd-looking prompt rather than a stack trace.

Failures are surfaced, not swallowed. Every `invoke` that can reject routes to
`#system_error`, which apologises to the citizen. This is better than it sounds:
before, a failing complaint submission left the conversation frozen with no
message at all, which from the citizen's side is indistinguishable from the bot
being switched off, and from the operator's side leaves nothing in the transcript
to investigate.

---

## Part 18 — Tenants

DIGIT tenancy is hierarchical: a state root such as `mz` with cities beneath it
such as `mz.ige`. The distinction is not cosmetic, and getting it wrong produces
empty lists rather than errors, which is why it is worth learning before your
first debugging session. Almost every "the bot shows no categories" report
traces back to a tenant mismatch rather than to missing data.

`ROOT_TENANTID` tells the bot which tenant to work in, and it drives four things
at once: which tenant complaints are filed against, where citizens are looked up
and created, which MDMS category data is read, and which localisation rows are
fetched. One variable, four consequences.

In this deployment complaints are filed at the city tenant, because that is where
the real category tree and the real boundaries live. The state root holds only
demonstration data and no boundaries at all, which would dead-end the location
walk on its very first level. The workflow definition resolves at the state root
regardless, which is why filing against the city still succeeds.

Localisation cuts the other way: translated strings live at the state root, not
at the city tenant. That asymmetry is exactly why the localisation service
queries both tenants and merges the results itself, rather than trusting one
query to return everything. If you seed translations against the wrong tenant
they will load without error and simply never appear in a message.

---

## Part 19 — Configuration

`src/env-variables.js` is the single place environment variables are read, and
every one has a default. There is no `.env` loading — the process expects real
environment variables, so local runs use a shell script that exports them before
starting the app.

Four groups matter. Identity and routing: port, context path, channel provider,
repository provider, business number. Tenancy: root tenant and supported locales.
Country: dialling code and national number length, plus the mobile format rules.
Product limits: minimum description length, maximum institution name length, and
the case category recorded on every complaint. Read the file once; it is short
and it is the whole contract with the environment.

The country group exists because the code used to assume India in several
places. Numbers are normalised, validated and formatted from configuration now.
If you find a literal country code anywhere in the source, it is a bug rather
than a shortcut — one such leftover is still open in the upload path.

Product limits are read through configuration for the same reason: the minimum
description length appears both in the validation and in the prompt text, via a
placeholder. Change the variable and both move together. Hardcoding it in either
place guarantees they will eventually disagree, and a prompt that asks for twenty
characters while the code demands thirty is a particularly annoying bug to be on
the receiving end of.

---

## Part 20 — The retained dead code

Two subtrees are unreachable but present. The location flow that asked for a GPS
pin and did fuzzy matching on city and locality names was replaced by the
boundary walk. Onboarding by organisation code, intended for multi-tenant
deployments where a citizen belongs to one of several organisations, was replaced
by a simpler single-tenant flow. Together they are around 750 lines.

They were kept rather than deleted because the behaviour may be wanted again and
reconstructing it from a commit history is harder than reading it in place. They
live in `flow/legacy-location.js` and `flow/legacy-organization.js`, moved
verbatim with only their indentation changed, and are merged into the machine so
their internal `#id` references still resolve at boot.

Reviving either means restoring an entry point — a transition that targets its
first state — and then testing it. Nothing currently routes in, which you can
verify by searching for `#` references to their state ids. That search is the
quickest way to confirm whether a state you are reading is live.

The tests that covered the old location flow are present but skipped, each with a
comment naming why. They are documentation of intended behaviour rather than
running assertions, and they will not silently start failing. If you revive the
flow, they are the specification you start from — which is a large part of why
deleting them would have been a false economy.

---

## Part 21 — What fails at boot, and why that is good

`assertTargets` runs in `seva.js` after everything is merged and before
`Machine(...)` is called. It walks the assembled tree and raises on three
things: a `#target` that resolves to no state, a duplicate state id, and a
compound state with no `initial` child. All three would otherwise be silent.

Each of those is silent for a different reason. XState v4 does not detect
duplicate ids at all. An unknown `#target` throws only when the machine is first
interpreted — inside a swallowed catch, so it surfaces as one wedged citizen at a
time. A compound state with no `initial` only logs a warning.

Turning those into a startup failure is the point. A deployment that will not
boot is obvious, is fixed in minutes, and affects nobody who is mid-conversation.
The same defect discovered as "some citizens stop getting replies" is a support
ticket, a log hunt, and a bad afternoon — and because the state is persisted, the
affected citizens stay broken until someone intervenes.

This is also why the machine config is assembled first and `Machine(...)` is
called last, which reads oddly if you are used to constructing a machine inline.
The check needs the complete tree — generated steps, legacy states and chassis
together — because a target may legitimately point from one into another.
Checking a fragment in isolation would produce false failures on every valid
cross-reference.

---

## Part 22 — Tests

Three files, and they test different things. `test/flow-generate.test.js`
verifies the generator itself against synthetic steps with fixture text. It
contains no product copy at all, which is deliberate: rewording a prompt must
never break it. If you change the generator, this is where coverage belongs, and
it is the fastest file in the suite to run.

`test/pgr-flow.test.js` drives the real filing machine. It is table-driven: each
test is a list of turns, each turn saying what to send and what must then be
true — the last message matches, the machine is in a given state, certain slots
hold certain values, the conversation is finished.

It works by replacing modules in Node's cache before requiring the machine, so
no network call happens and the backend responses are whatever the test says.
One trap: only the machine file is re-required per test, so any module that
captures a service at load time will hold a stale stub. Inject dependencies
instead.

`test/session-resume.test.js` covers the save-and-resume layer with the
repository, channel and telemetry stubbed out. Its important test asserts the
precondition first — that the bad state really does throw — before asserting the
fallback catches it. A test that passes whether or not the code is broken is
worse than none.

Exactly one assertion in the suite checks a nested state path rather than
observable behaviour, and it is load-bearing. It proves that the generated
category walk sits at the same path the hand-written one did, which is what keeps
saved conversations resumable across the change. Leave it alone; if it ever
fails, a rename has happened and persisted sessions are about to be discarded.

Five tests are skipped, each labelled with its cause: four drive the unreachable
location flow, and one asserts a menu option that no longer exists. They are
skipped rather than deleted, matching the decision to keep the code they
describe. A skipped test with a stated reason is a note to the next reader; a
deleted one is a gap nobody knows about.

Beyond the suite, the technique used throughout this refactor is worth knowing: a
*probe* script that drives one state through many inputs and dumps the
transcript, state value and slots as JSON. Capture it before a change, capture it
after, and diff the two. It catches differences nobody thought to write an
assertion for, which is exactly the risk when restructuring working code.

---

## Part 23 — Recipes

**To add a question**, add a step to `flow/steps-pgr.js`, add its message bundle
to `pgr.js`, and point the previous step's `next` at it. Pick the kind by what
the citizen does: reads (`say`), types (`ask`), picks from a list (`choose`),
descends a tree (`walk`), or waits on a backend (`call`). Then add a row to the
flow test covering both the accepting and the rejecting case.

**To change wording**, edit the bundle. If the bundle has a `code` and the
deployment has a translation for that code, the live translation wins — so
check there too, or your edit will appear to do nothing. Adding a new locale
means adding a key to every bundle plus seeding the platform.

**To store a new answer**, add a `slot` to the step and read it in
`persistComplaint`. Update the slot-contract test to include the new key. Do not
write to `context` directly from a step; that is what `slot` and `set` are for,
and the indirection is what keeps the data flow findable.

**To add a validation rule**, give the `ask` step a `validate` function. Return
`true` to accept, a message bundle to reject with a specific complaint, or
`false` to reject with the generic retry. Read the bound from configuration
rather than writing a number, and show it in the prompt with a placeholder so the
requirement and the enforcement can never drift apart.

**To call a new backend**, add the method to the appropriate service module, then
add a `call` step whose `src` invokes it. Give every failure path a destination —
in practice `#system_error`. The generator supplies that by default, so the only
way to get it wrong is to override it with nothing, which is precisely the shape
that used to freeze conversations.

**To rename a state**, understand that saved conversations reference it by name.
The resume fallback means the citizen gets a fresh session rather than a
permanent brick, but they do lose their place in the flow, and telemetry strings
change shape at the same time. It is a deliberate act with a cost, not a
tidy-up, so do it on purpose and mention it in the commit.

**When something is stuck**, check three things in order. Does the guard array of
the `process` state you are in have an unconditional last entry? Does every
`#target` in that region resolve to a real state? Does every `invoke` have an
`onError`? Those three account for essentially every wedged conversation this
codebase has produced, and all three are now checked or generated.

**Before you commit**, run the suite and walk the flow on the console channel in
both locales. The suite catches structure and regressions; the walk catches
wording, ordering, and the class of problem that only looks wrong when you read a
transcript the way a citizen would. Neither substitutes for the other, and the
walk takes about two minutes.

---

## Part 24 — Gotchas worth knowing in advance

Guard order is behaviour. In a walk it decides whether "Go Back" is treated as a
category. In a triplet it decides whether an unrecognised reply retries or
wedges. When you read an `always` array, read it as a sequence of attempts, and
check what happens when none of them match.

`assign` bodies must not accidentally return an object. In v4 a returned object
*replaces* the context. Writing `assign((c) => c.x = 1)` happens to be harmless
because the result is a primitive, but the same shape with an object literal
would silently wipe the conversation. Use braces.

Side effects live inside `assign` in this codebase, including sending messages.
That is not what XState intends — actions that mutate and actions that produce
output should be separate — but it is consistent throughout and it fixes the
ordering of sends relative to context writes. Moving them out is a legitimate
refactor and deliberately a separate one from the work described here.

Anything a state computes on entry and reads on the *next* message must be stored
in context, because entry actions do not re-run on resume. Anything a state
computes and uses immediately within the same turn need not be. Confusing the two
produces bugs that appear only across a deploy or a restart, which is the worst
possible time to discover them.

The reset keyword is the citizen's only universal escape, and it works because of
one rule at the root of the machine rather than anything in the individual
states. If you find yourself adding per-state handling for "hi" or "egov", you
are reimplementing it, and you will get it subtly wrong somewhere. Trust the root
rule.

`InMemory` is the default repository. If conversations are not surviving a
restart, that is why, and it is expected rather than broken.

Finally: the number "1" means different things in different states, and that is
by design. It is the first menu option, the skip token at the attachment
question, and acceptance at both confirmations. What it means is decided by the
grammar of the state you are in — which is precisely why the position has to be
stored, and why this is a state machine.

---

## Appendix — Map of files

| Path | What it is |
|---|---|
| `src/app.js` | Express server, port, context path |
| `src/env-variables.js` | Every environment variable, with defaults |
| `src/channel/index.js` | Picks the channel adapter at startup |
| `src/channel/routes/index.js` | The webhook endpoints |
| `src/channel/{twilio,console,value-first,kaleyra}.js` | Provider adapters |
| `src/session/session-manager.js` | Turn orchestration, save, resume |
| `src/session/repo/` | In-memory and Postgres state storage |
| `src/session/user-service.js` | Mobile number to DIGIT user |
| `src/machine/seva.js` | The one machine; chassis, onboarding, assembly |
| `src/machine/pgr.js` | Filing shell, message bundles, merges |
| `src/machine/flow/generate.js` | Steps to XState nodes; the boot check |
| `src/machine/flow/steps-pgr.js` | The filing and tracking step table |
| `src/machine/flow/steps-seva.js` | The onboarding step table |
| `src/machine/flow/legacy-*.js` | Unreachable, retained deliberately |
| `src/machine/util/dialog.js` | Prompt, grammar and send primitives |
| `src/machine/util/localisation-service.js` | Live translations and locales |
| `src/machine/service/egov-pgr.js` | MDMS, boundary, filestore, complaints |
| `test/flow-generate.test.js` | The generator, no product copy |
| `test/pgr-flow.test.js` | The filing flow, table-driven |
| `test/session-resume.test.js` | Save and resume, including the brick case |

**Read in this order on your first day:** `dialog.js` for the primitives every
other file uses, `steps-pgr.js` for the shape of the conversation as data,
`generate.js` for what a step actually becomes, then `seva.js` from the bottom
upward for how the whole machine is assembled and checked. That is roughly an
hour and it covers the live flow completely.
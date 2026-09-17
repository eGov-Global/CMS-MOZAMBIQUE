# XState-Chatbot Service

XState-Chatbot is a chatbot built on [XState](https://xstate.js.org/docs/), a JavaScript implementation of [State-Charts](https://statecharts.github.io).

The chatbot is a backend service: it receives messages incoming from the user, keeps one conversation state per user, and sends replies through a separate API call.

In this project, the `nodejs` directory contains the primary project. It contains all the files of the project that will get deployed on the server. `react-app` is provided only to ease the process of dialog development. It should be used only on a developer's local machine when developing any new chat flow. `nodejs` should be run as a backend service and tested once on the local machine using postman before deploying the build to the server.

For the full design — layers, state kinds, the generator, slots, sessions — read [`nodejs/ARCHITECTURE.md`](./nodejs/ARCHITECTURE.md). The sections below are the overview.

## Getting Started

The service needs Node 18 or newer — the test runner uses the built-in `node --test`. All commands below run inside `nodejs/`.

```
npm install
cp .env.example .env
npm start
```

The service listens on `SERVICE_PORT` (8082 by default) under `CONTEXT_PATH` (`/xstate-chatbot`). `npm start` runs with `--inspect` for debugging and loads the CA bundle in `certs/`.

`REPO_PROVIDER` chooses where conversation state lives: `InMemory` keeps sessions in process, so a local run needs no database but loses every conversation on restart; `Postgres` persists them using the `DB_*` settings.

### Configuration

Every tenant- and country-specific value is an environment variable, so the same build serves any deployment. `.env.example` lists all of them; these are the ones you will always set:

| Variable | What it controls |
|---|---|
| `ROOT_TENANTID` | tenant the chatbot files complaints under |
| `SUPPORTED_LOCALES` | locales offered in the language menu |
| `COUNTRY_CODE`, `MOBILE_NUMBER_LENGTH` | number parsing and validation |
| `BOUNDARY_HIERARCHY_TYPE` | which MDMS boundary hierarchy to walk |
| `WHATSAPP_PROVIDER` and the provider's credentials | outbound channel |
| `ALLOWED_MOBILE_NUMBERS` | whitelist gating the welcome step; empty allows all |
| `CANCEL_WORDS`, `RESET_WORDS` | words that cancel or restart a session |

The remaining variables point at the backend services the flow reads from — MDMS, localization, user and PGR. The chatbot is a client of those services; it holds no copy of their data.

### Running the tests

```
npm test
```

### Developing a dialogue

`react-app/` renders the conversation in a browser so you can click through a flow without WhatsApp. Run `npm install` in both `nodejs/` and `react-app/`, then `npm start` in `react-app/` and open `http://localhost:3000`. A few environment variables must be disabled first — see [LOCALSETUP.md](./LOCALSETUP.md).

## Flow machine

The dialogue used to be declared in step tables: a data structure describing each step, read by a generator that emitted an XState machine. That worked while the flow was shallow, but every new step kind meant another special case in the generator, and the tables could not express a step that needed its own behaviour.

The flow is now authored as classes. Each state kind (ask a question, show a menu, walk a tree, upload media, confirm) is a class with a known contract, composed into one machine. The onboarding and complaint-filing journeys were ported to these classes, `shell-machine` and `pgr-machine` were merged into a single machine, and the old generator path was removed. Adding a step kind now means adding a class, not editing a generator.

The session layer was split along the same lines: login flows are separate from the chat service that drives the machine.

## Localization and tenancy

Nothing in the dialogue assumes a country or a tenant. The default locale comes from configuration rather than a hardcoded `en_IN`, and the language menu is built from the tenant's own MDMS `StateInfo`, so a deployment offers exactly the languages it has declared. Mobile-number validation and the outbound sender number are derived from configured country settings, and India-specific naming (`seva`, `mseva`) was renamed to generic terms.

Adding a language is an MDMS and localization change; it needs no code edit.

## Complaint filing

Filing walks the complaint hierarchy straight from MDMS, at whatever depth the tenant has configured, showing the chosen path above each menu so the citizen can see where they are. The journey asks for consent before collecting anything, asks which institution the grievance concerns, then collects a description and walks the boundary hierarchy the same way. A review step shows the assembled complaint before submission.

Because both hierarchies come from MDMS, a tenant with three levels and a tenant with five use the same code. The older frequent-complaints shortcut was removed.

## Concurrency and failure handling

A conversation is single-threaded per user. Outbound sends are serialized so replies cannot arrive out of order, and the dispatch lock is held through the send plus a short cooldown. An inbound message that arrives while a previous one for the same user is still being processed is discarded rather than interleaved.

Media uploads time out instead of hanging the conversation, and oversized attachments are rejected with a retry prompt. Errors are typed exceptions handled in one place; on a system error the session is parked rather than silently restarted, so the citizen is not thrown back to the beginning.

## Access control

Inbound messages are filtered before any session work happens. A configurable mobile-number whitelist gates the welcome step, messages from numbers outside the configured country are dropped, and the reset path no longer bypasses the whitelist.

Citizen records are provisioned through a service account, so the chatbot files complaints without a citizen ever holding credentials.

## Remote Debugging

To support remote debugging, we recommend using [VSCode](https://code.visualstudio.com). The VSCode [launch](./.vscode/launch.json) script file is written which will be used to start the remote debugging session. 

Steps to start a remote debugging session:

1. Port forward to the the remote server (9229:9229)
2. In VSCode Run options, select "Attach to remote" 
3. Start Debugging

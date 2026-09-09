# Citizen Portal Adapter

Translates a citizen portal's REST calls into DIGIT PGR calls and back.

The portal sends the citizen's **phone number** and the complaint form. The adapter
authenticates as a **reception officer** with static credentials and files the
complaint on the citizen's behalf, exactly as the DIGIT employee desk already does.

## How filing on behalf of a citizen works

PGR decides who owns a complaint from the type of the **logged-in** user
(`EnrichmentService.java`):

```java
if (requestInfo.getUserInfo().getType().equalsIgnoreCase(USERTYPE_CITIZEN))
    serviceRequest.getService().setAccountId(requestInfo.getUserInfo().getUuid());
```

- A **CITIZEN** caller has `accountId` overwritten with their own uuid.
- An **EMPLOYEE** caller keeps whatever the request names.

So the adapter logs in as an employee and **omits `accountId` entirely**, sending
`service.citizen` instead. PGR then takes its `upsertUser` branch, looks the citizen
up by mobile number, and creates them if absent. The adapter never calls the user
service itself.

The result: `accountId` is the citizen, `auditDetails.createdBy` is the reception
officer — the same pair the employee UI uses to show "filed on behalf of".

## API documentation

Swagger UI is served by the adapter itself, so it points at whatever host it is
deployed to and needs no separate site:

| Path | What |
|---|---|
| `/docs` | Swagger UI — browse and call the API |
| `/docs/openapi.yaml` | The OpenAPI 3.0 spec, for client generation |

To try a call: open `/docs`, click **Authorize**, paste the `ADAPTER_API_KEY`, then
**Try it out** on any operation. The key is remembered across reloads.

Both paths are unauthenticated — they describe the contract, they expose no data, and
every documented operation still requires `X-Adapter-Key`.

The UI loads from a CDN. For an air-gapped deployment, host `swagger-ui-dist`
yourself and set `SWAGGER_UI_URL` to it.

## Endpoints

All calls require the header `X-Adapter-Key`.

### `POST /complaints`

```json
{
  "mobileNumber": "840000000",
  "serviceCode": "StreetLightNotWorking",
  "description": "Poste de iluminação avariado há duas semanas",
  "locality": "ADMIN_LOC_01",
  "instituteName": "Ministério da Água",
  "isConfidential": true
}
```

`mobileNumber`, `serviceCode`, `description` and `locality` are required. Responds
`201` with the filed complaint.

### `GET /complaints?mobileNumber=840000000`

Responds `200` with `{"complaints": [...]}` — raw PGR fields, no translation.

### `GET /master-data/departments`

```json
{ "departments": [ { "code": "DEPT_8", "name": "Célula de Reclamações" } ] }
```

### `GET /master-data/complaint-types?path=GRIEVANCE,WATER`

Complaint types are a tree of unknown depth, so the portal **walks** it one level at
a time. Call with no `path` for the first level; append each chosen code and call
again. Stop when `isLeaf` is `true` — the code chosen at that point is the
`serviceCode` to file with.

```json
{
  "level": "Categoria",
  "path": ["GRIEVANCE"],
  "isLeaf": false,
  "options": [ { "code": "WATER", "name": "Água" } ]
}
```

### `GET /master-data/localities?path=MAPUTO,KAMPFUMO`

The same walk over the administrative boundary tree. The code chosen at the leaf is
the `locality` to file with. This replaces the map, which this channel does not have.

### `GET /health`

No API key needed.

## Labels

Master data is all codes. Every list is labelled from the deployment's own
localisation masters, so the portal shows the same wording as the WhatsApp bot and
the employee UI. Pass `?locale=pt_PT` (the default) or `?locale=en_IN`. A code with
no translation comes back as itself rather than blank, so a missing label never
empties a dropdown.

## Running it

```bash
cp .env.example .env
```

Fill in `ADAPTER_API_KEY`, the reception officer credentials, and the two tenants.

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

```bash
.venv/bin/python run.py
```

Production:

```bash
gunicorn --bind 0.0.0.0:8090 --workers 2 run:app
```

## Configuration that must be right

| Setting | Why it matters |
|---|---|
| `ROOT_TENANT_ID` | Employee login happens at the **root** tenant (`mz`) |
| `CITY_TENANT_ID` | Complaints are filed at the **city** tenant (`mz.ige`) |
| `COMPLAINT_SOURCE` | Must appear in `allowed.source` in pgr-services, or the create is rejected |
| `DEFAULT_CITIZEN_NAME` | PGR rejects an employee-filed complaint whose citizen has no name |
| `TOKEN_TTL_SECONDS` | How often to re-authenticate; DIGIT has no refresh endpoint |
| `COUNTRY_CODE` / `MOBILE_NUMBER_LENGTH` | Phone identity. **Must match the chatbot's**, or the same citizen gets two user records |
| `SWAGGER_UI_URL` | Self-hosted Swagger UI, for air-gapped deployments |
| `LOCALISATION_MODULES` | Which bundles labels are read from |
| `DEFAULT_LOCALE` | Language used when the portal does not ask for one |

## Prerequisite

An employee account with the `CMS_RECEPTION_OFFICER` role (legacy equivalent: `CSR`)
that can log in with a password. This cannot be worked around in the adapter.

## Layout

```
app/
├── api/         # HTTP: routes, the shared-secret guard, error shape
├── domain/      # what a complaint is, and what can go wrong
├── pgr/         # the only code that knows DIGIT exists
│   ├── reception_officer.py   # static login, token cache
│   ├── payloads.py            # the two complaint request bodies
│   ├── client.py              # create and search
│   ├── master_data.py         # departments, and the two walks
│   └── labels.py              # code -> readable name, cached per locale
└── config.py    # every environment variable
```

Dependencies point inward: `api` knows `domain`, `pgr` knows `domain`, and `domain`
knows nothing. Swapping PGR for another backend means replacing `pgr/` only.

## Known limitation

Every complaint-type request re-reads both MDMS masters. That is two extra calls per
level walked — fine for a demo, wasteful under load. Master data changes rarely, so
the fix is to cache it the way `labels.py` already caches translations.

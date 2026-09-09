# Deploying the REST adapter

The adapter runs as a Docker container on the DIGIT host, joined to the DIGIT
compose network, and is published through Kong at `/adapter`.

Reference values below are UAT (`mzmpm02srv407`, stack in `/opt/digit`, public at
`https://uat.falacidadao.gov.mz`). Adjust host names and the network name for other
environments.

> **As of `enable_rest_adapter` landing in `local-setup/ansible`, the steps below
> are superseded for any tenant deployed via `playbook-deploy.yml`.** Set
> `enable_rest_adapter: true` plus `adapter_api_key` /
> `reception_officer_username` / `reception_officer_password` in that tenant's
> `inventory/host_vars/<tenant>.yml`, and the normal deploy run builds, configures,
> and starts the container as part of the managed stack — no separate
> `docker build`/`docker run`, no manual Kong edit. This document stays as the
> manual/reference procedure for anything deployed outside that flow.


---

## 1. New deployment

### 1.1 Get the code

```bash
git clone -b rest-adapter-citizen-portal https://github.com/eGov-Global/CMS-MOZAMBIQUE.git ~/CMS-MOZAMBIQUE
```

```bash
cd ~/CMS-MOZAMBIQUE/backend/rest-adapter
```

### 1.2 Create `.env`

`.env` is gitignored and never ships with the code.

```bash
cp .env.example .env
```

```bash
chmod 600 .env
```

Set at least:

| Setting | Value | Why |
|---|---|---|
| `ADAPTER_API_KEY` | a long random string | the only guard on the API — `openssl rand -hex 32` |
| `RECEPTION_OFFICER_USERNAME` / `_PASSWORD` | the employee account | must hold the `EMPLOYEE` base role, not just `CMS_RECEPTION_OFFICER` |
| `DIGIT_HOST` | `http://kong:8000/` | Kong's proxy port *inside* the network; `18000` is host-side only |
| `USER_SERVICE_HOST` | `http://kong:8000/` | same gateway |
| `ROOT_TENANT_ID` | `mz` | employee login happens at the state root |
| `CITY_TENANT_ID` | `mz` | where complaints are filed |
| `SEARCH_TENANT_ID` | `mz` | state root, so the tenant clause is a prefix match |
| `PROXY_HOPS` | `1` | honours `X-Forwarded-Prefix`, so Swagger advertises `/adapter` |
| `COMPLAINT_SOURCE` | `linhaverde` | must appear in pgr-services' `allowed.source` |

Routing every outbound call through Kong means the adapter needs no DNS entry for
the public hostname and no `--add-host`.

### 1.3 Build

Tag by commit so a rollback has something to go back to.

```bash
docker build -t rest-adapter:$(git rev-parse --short HEAD) .
```

```bash
docker tag rest-adapter:$(git rev-parse --short HEAD) rest-adapter:current
```

### 1.4 Run, on the DIGIT network

The container name must match the `url` in Kong's config — Kong resolves it through
Docker's embedded DNS, which only works on a shared network.

```bash
docker run -d --name rest-adapter --restart unless-stopped --env-file .env -p 8090:8090 --network digit_egov-network rest-adapter:current
```

```bash
curl -s localhost:8090/health
```

### 1.5 Publish through Kong

Kong is DB-less; its config is the declarative file the container mounts. On the
DIGIT host that is `/opt/digit/kong/kong.yml`, which Ansible syncs from
`local-setup/kong/` — **edit it in the repo, or the next deploy overwrites it.**

The entry is already in `local-setup/kong/kong.yml`:

```yaml
- name: rest-adapter
  url: http://rest-adapter:8090
  tags:
  - adapter
  routes:
  - name: adapter-route
    paths:
    - /adapter
    strip_path: true
  plugins:
  - name: request-transformer
    config:
      add:
        headers:
        - "X-Forwarded-Prefix:/adapter"
```

`strip_path: true` removes `/adapter` so the app sees its own root routes; the
header hands the prefix back so Swagger's `servers` block is correct.

Apply it:

```bash
cd /opt/digit
```

```bash
sudo docker compose -f docker-compose.egov-digit.yaml restart kong
```

`/opt/digit` has no `docker-compose.yml`, so the `-f` flag is required. `restart`
touches only Kong — it does not follow `depends_on` in either direction.

### 1.6 Verify

```bash
sudo docker exec kong-gateway getent hosts rest-adapter
```

```bash
curl -s https://uat.falacidadao.gov.mz/adapter/health
```

```bash
curl -s https://uat.falacidadao.gov.mz/adapter/docs/openapi.yaml | grep -A 1 '^servers:'
```

Must read `- url: /adapter`. `- url: /` means `PROXY_HOPS` is missing and Swagger's
Try-it-out will call the wrong paths.

```bash
curl -s -H "X-Adapter-Key: <key>" "https://uat.falacidadao.gov.mz/adapter/complaints?mobileNumber=<number>" | head -c 300
```

That last call exercises officer login, the token cache and the search workaround in
one go. Swagger UI is at `https://uat.falacidadao.gov.mz/adapter/docs`.

---

## 2. Updating the adapter

`docker restart` is not enough: `--env-file` is read when a container is *created*,
and a restart keeps the old image. Every update recreates the container.

### 2.1 Pull

```bash
cd ~/CMS-MOZAMBIQUE/backend/rest-adapter
```

```bash
git pull
```

### 2.2 Check `.env` for new settings

`.env` never updates itself; new settings land in `.env.example` only. This lists
keys the example has and yours does not:

```bash
comm -23 <(grep -oE '^[A-Z_]+=' .env.example | sort -u) <(grep -oE '^[A-Z_]+=' .env | sort -u)
```

Empty means nothing to do. Otherwise add each key — the comment above it in
`.env.example` explains it.

### 2.3 Rebuild

```bash
docker build -t rest-adapter:$(git rev-parse --short HEAD) .
```

```bash
docker tag rest-adapter:$(git rev-parse --short HEAD) rest-adapter:current
```

### 2.4 Recreate

```bash
docker rm -f rest-adapter
```

```bash
docker run -d --name rest-adapter --restart unless-stopped --env-file .env -p 8090:8090 --network digit_egov-network rest-adapter:current
```

`--network` is not optional: `docker network connect` does not survive `docker rm`,
and without it Kong fails with
`failed the initial dns/balancer resolve for 'rest-adapter'`.

### 2.5 Verify

```bash
curl -s localhost:8090/health
```

```bash
curl -s https://uat.falacidadao.gov.mz/adapter/health
```

Kong needs nothing on a code or `.env` change — the service still points at the same
name. Restart Kong only when the **route** changes (path, `strip_path`, the
`X-Forwarded-Prefix` plugin). Kong also caches DNS failures, so if the container was
missing for a while, restart Kong once after it is back.

### 2.6 Rollback

```bash
docker images rest-adapter
```

```bash
docker rm -f rest-adapter
```

```bash
docker run -d --name rest-adapter --restart unless-stopped --env-file .env -p 8090:8090 --network digit_egov-network rest-adapter:<previous-tag>
```

Extra `.env` keys are ignored by an older image, so `.env` needs no rollback.

---

## Still to confirm

- Log rotation to disk (`LOG_DIR`, `LOG_OUTPUT=file`) needs a mounted volume, or
  logs vanish when the container is recreated.
- Whether the adapter should be a service in `docker-compose.egov-digit.yaml`
  instead of a standalone `docker run`, so the stack manages it.

# Deploying to UAT

Two things happen on every deploy: the adapter runs as a Docker container, and
Kong's route to it gets (re)applied. The exact commands below are a best-effort
reconstruction from what's in this repo (`Dockerfile`, `local-setup/kong/kong.yml`) —
adjust anything that doesn't match how the UAT host/Kong instance is actually
managed (compose vs. bare `docker run`, declarative vs. Admin API Kong config,
whatever supervises restarts).

## 1. Build the image

```bash
docker build -t rest-adapter:<tag> backend/rest-adapter
```

## 2. Provide `.env`

Copy `backend/rest-adapter/.env.example`, fill in the UAT values (`DIGIT_HOST`,
`USER_SERVICE_HOST`, tenant IDs, reception officer credentials, `ADAPTER_API_KEY`,
etc.), and make it available to the container — e.g. `--env-file` or however
secrets are provisioned on that host. Do not commit a filled-in `.env`.

## 3. Run the container

```bash
docker run -d \
  --name rest-adapter \
  --env-file /path/to/uat.env \
  -p 8090:8090 \
  --restart unless-stopped \
  rest-adapter:<tag>
```

If DIGIT itself is reached through Kong on that host (as in local-setup), point
`DIGIT_HOST`/`USER_SERVICE_HOST` at Kong's address instead of the public one, and
set `PROXY_HOPS=1` so `X-Forwarded-Prefix` is honoured.

## 4. Update Kong

Kong needs a service + route (+ the prefix-forwarding plugin) pointing at the
adapter, matching the `rest-adapter` entry in `local-setup/kong/kong.yml`:

```yaml
- name: rest-adapter
  url: http://rest-adapter:8090   # adjust to how the container is reachable on UAT
  routes:
    - name: adapter-route
      paths:
        - /adapter
      strip_path: true
  plugins:
    # strip_path removes /adapter before forwarding, so the app sees its own root
    # routes. This header hands the prefix back, which is what makes Swagger UI
    # advertise /adapter in `servers` instead of /.
    - name: request-transformer
      config:
        add:
          headers:
            - "X-Forwarded-Prefix:/adapter"
```

Apply it however Kong config is managed on UAT (declarative config sync, `decK`,
or the Admin API directly) — this repo doesn't currently record which.

## 5. Verify

```bash
curl https://<uat-host>/adapter/health
```

Expect `{"status": "ok"}`. If it hangs or 404s, check: the container is actually
listening on 8090, Kong's route/service point at the right address, and
`strip_path`/the `X-Forwarded-Prefix` header are both in place (otherwise
`/docs` and the OpenAPI `servers` block will point at the wrong base path).

## Known gaps in this doc

- Where `.env` actually lives on the UAT host, and how it's kept in sync with
  `.env.example` as new settings are added (e.g. the recent `LOG_*` and
  `LOCALITY_HIERARCHY_TYPE` settings).
- Whether the container is run standalone or via a compose file specific to
  UAT (not present in this repo — only `local-setup/docker-compose.yml`, which
  is for local dev).
- How Kong's config is actually applied/persisted on that host.
- Log rotation to disk (`LOG_DIR`, `LOG_OUTPUT=file`) assumes a writable,
  persistent volume if the container is ever recreated — confirm one is mounted,
  or logs disappear with the container.

Fill these in as they're confirmed, so this stops being a reconstruction and
becomes the actual record.

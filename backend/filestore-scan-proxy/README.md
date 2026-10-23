# filestore-scan-proxy

Virus-scans uploads before they reach `egov-filestore`. When a tenant sets
`enable_file_scan: true` (Ansible host_vars), nginx sends every non-GET/HEAD
`/filestore/` request here instead of to Kong; this service scans every
multipart request with ClamAV (`clamd`) and forwards only clean uploads to
Kong, unchanged. GET/HEAD (URL lookups) go straight to Kong, so if this proxy
is down only new uploads fail (502) — existing attachments still display.

```
UI → nginx /filestore/ → filestore-scan-proxy (:18183) → Kong → egov-filestore → MinIO
                                  │
                                  ├─► clamav (clamd :3310)
                                  └─► MinIO egov-quarantine (infected files only)
```

`kong.yml` is not changed, so the local `docker-compose.yml`, CI and k3s tiers
run exactly as before. The compose services (`clamav`, `filestore-scan-proxy`,
`quarantine-init`) live under the `file-scan` profile in
`local-setup/docker-compose.egov-digit.yaml`.

## Turning it on for a tenant

1. In `inventory/host_vars/<tenant>.yml`: `enable_file_scan: true`
2. `./deploy.sh <tenant>`. The playbook builds `filestore-scan-proxy:local` on
   the box (or uses `filestore_scan_proxy_image:` if set), generates the two
   quarantine MinIO passwords into OpenBao, starts the profile, and re-renders
   nginx.
3. Allow ~1.5GB extra RAM. On first start clamd downloads signatures; uploads
   return 503 `SCAN_UNAVAILABLE` until Gatus shows *File Scan* green.

Turning it off (`enable_file_scan: false` + deploy) points nginx back at Kong.

## Outcomes

| Scan result | HTTP | `Errors[0].code` | Stored? |
|---|---|---|---|
| Clean | filestore's response | – | Yes, in `egov-rainmaker` as before |
| Malware found | 400 | `VIRUS_DETECTED` | Copy in `egov-quarantine` only |
| Encrypted / over scan limits | 400 | `FILE_NOT_SCANNABLE` | No |
| Malformed multipart | 400 | `INVALID_UPLOAD` | No |
| Body over `MAX_BODY_BYTES` | 413 | `FILE_TOO_LARGE` | No |
| clamd down / error | 503 | `SCAN_UNAVAILABLE` | No (fails closed) |

Non-multipart requests (`/filestore/v1/files/url`, `/files/id`, …) are
streamed straight through. The ClamAV signature name is logged but never
returned to the client.

Backend services that call `egov-filestore:8083` directly (PDF service,
pgr-services) bypass this proxy. That is intentional: they store files they
generated themselves, not user uploads. Kong (:18000) and egov-filestore
(:18084) are also published on the host; keep those ports firewalled so
uploads can only arrive through nginx.

## Configuration

| Env var | Default | |
|---|---|---|
| `FILESTORE_UPSTREAM` | `http://egov-filestore:8083` | Compose sets `http://kong:8000`, so Kong auth still applies |
| `CLAMD_HOST` / `CLAMD_PORT` | `clamav` / `3310` | |
| `SCAN_TIMEOUT_MS` | `15000` | Keep above clamd `MaxScanTime` |
| `MAX_BODY_BYTES` | `27262976` (26 MiB) | nginx caps at 25M |
| `QUARANTINE_BUCKET` | – | Unset disables quarantine |
| `QUARANTINE_MINIO_URL` | `http://minio:9000` | |
| `QUARANTINE_ACCESS_KEY` / `QUARANTINE_SECRET_KEY` | – | `PutObject`-only user, created by `quarantine-init` |

clamd limits and alert switches live in
[`local-setup/clamav/clamd.conf`](../../local-setup/clamav/clamd.conf).

## Logs

One JSON line per event. Useful `event` values: `virus_detected`,
`upload_not_scannable`, `scan_unavailable`, `quarantine_failed`,
`upload_clean`. Example Loki query:

```
{container="filestore-scan-proxy"} | json | event="virus_detected"
```

## Reading the quarantine

The bucket is private and the proxy can only write to it. Investigators use
the `quarantine-reader` MinIO user (password in OpenBao as
`minio_quarantine_reader_password`):

```sh
ssh -L 9001:localhost:19001 <user>@<server>     # then open http://localhost:9001
# or
mc alias set q http://localhost:19000 quarantine-reader <password>
mc ls --recursive q/egov-quarantine/
mc stat q/egov-quarantine/<key>.bin             # signature, sha256, original filename, tenant, IP
```

Objects expire after 90 days. **These are live malware samples** — open them
only in an isolated analysis VM.

## Development

```sh
npm install
npm test          # fake clamd + fake filestore, no Docker needed
```

End-to-end check against a real stack, using the harmless EICAR test string:

```sh
printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > eicar.txt
curl -s -F tenantId=ke -F module=PGR -F file=@eicar.txt http://localhost:18183/filestore/v1/files
# → 400 {"Errors":[{"code":"VIRUS_DETECTED",...}]}
```

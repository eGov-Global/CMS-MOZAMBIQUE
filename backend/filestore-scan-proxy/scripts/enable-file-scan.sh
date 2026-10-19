#!/usr/bin/env bash
# Enable upload virus scanning on a running DIGIT compose stack WITHOUT Ansible
# (servers where deploy.sh is not used). Mirrors what `enable_file_scan: true`
# does, except nginx — this script never touches nginx; it prints the nginx
# step at the end, to run once the scanner is healthy.
#
#   sudo bash enable-file-scan.sh [proxy-image]
#
# Safe to re-run: existing .env passwords are kept, quarantine-init is
# idempotent, only the three file-scan containers are (re)created (--no-deps).
# Generated from local-setup/docker-compose.egov-digit.yaml + local-setup/clamav/clamd.conf.
set -euo pipefail

IMAGE="${1:-egovio/filestore-scan-proxy:enable-filestore-security-a1f5069}"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

# ── Find the running stack from Kong's compose labels ────────────────────────
PROJECT=$(docker inspect kong-gateway --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null) \
  || { echo "kong-gateway container not found — is the DIGIT stack running?" >&2; exit 1; }
WORKDIR=$(docker inspect kong-gateway --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
FILES=$(docker inspect kong-gateway --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
echo "Stack: project=$PROJECT dir=$WORKDIR"
docker inspect -f '{{.State.Running}}' digit-minio 2>/dev/null | grep -q true \
  || { echo "digit-minio is not running." >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
echo "Available RAM: ${AVAIL_MB} MB (clamd needs ~1500 MB)"
[ "$AVAIL_MB" -ge 1500 ] || echo "WARNING: less than 1.5 GB available — clamd may be OOM-killed."
curl -s -o /dev/null --max-time 10 https://database.clamav.net \
  || echo "WARNING: cannot reach database.clamav.net — clamd will not get signatures (uploads would stay 503)."

# ── clamd.conf ───────────────────────────────────────────────────────────────
mkdir -p "$WORKDIR/clamav"
cat > "$WORKDIR/clamav/clamd.conf" <<'CLAMD_EOF'
# clamd config for the upload virus scanner (used by filestore-scan-proxy).
# Mounted over the clamav/clamav image's /etc/clamav/clamd.conf. The first
# block repeats the image defaults; everything below it is ours.

LogFile /var/log/clamav/clamd.log
LogTime yes
LocalSocket /tmp/clamd.sock
TCPSocket 3310
User clamav

# ---- Limits -----------------------------------------------------------
# nginx caps request bodies at 25M (client_max_body_size) and the proxy at
# 26MiB, so a single upload always fits in one stream.
StreamMaxLength 30M
MaxFileSize 30M
# Total bytes extracted from archives/documents per file.
MaxScanSize 100M
MaxRecursion 10
MaxFiles 1000
# ms. The proxy's SCAN_TIMEOUT_MS (15000) sits just above this so clamd
# reports the timeout itself rather than the socket being cut.
MaxScanTime 10000

# ---- Fail-safe alerts -------------------------------------------------
# Files that can't be fully checked are reported as Heuristics.* FOUND, which
# the proxy rejects with FILE_NOT_SCANNABLE (and does not quarantine).
AlertEncrypted yes
AlertExceedsMax yes

# Block every Office document containing macros, malicious or not. Off by
# default: some departments may share legitimate macro spreadsheets.
AlertOLE2Macros no
CLAMD_EOF

# ── Compose overlay with only the file-scan services ────────────────────────
cat > "$WORKDIR/docker-compose.file-scan.yml" <<'OVERLAY_EOF'
# Upload virus scanning (manual enable). Copied from the repo's
# docker-compose.egov-digit.yaml. Undo: remove this file, the FILE SCAN block
# in .env, and the three containers.
services:
  clamav:
    image: clamav/clamav:1.5.4
    profiles: [file-scan]
    container_name: digit-clamav
    volumes:
      # Signatures persist across restarts; the first start downloads ~300MB.
      - clamav_data:/var/lib/clamav
      - ./clamav/clamd.conf:/etc/clamav/clamd.conf:ro
    healthcheck:
      test: ["CMD", "clamdcheck.sh"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 600s
    restart: unless-stopped
    networks:
      - egov-network

  filestore-scan-proxy:
    image: ${FILESTORE_SCAN_PROXY_IMAGE:-filestore-scan-proxy:local}
    profiles: [file-scan]
    container_name: filestore-scan-proxy
    # Not gated on clamav health: while signatures load the proxy is up and
    # fails uploads closed (503), but downloads and URL lookups keep working.
    depends_on:
      clamav:
        condition: service_started
      kong:
        condition: service_started
    environment:
      FILESTORE_UPSTREAM: http://kong:8000
      CLAMD_HOST: clamav
      CLAMD_PORT: "3310"
      QUARANTINE_BUCKET: egov-quarantine
      QUARANTINE_MINIO_URL: http://minio:9000
      QUARANTINE_ACCESS_KEY: scanproxy
      QUARANTINE_SECRET_KEY: ${MINIO_SCANPROXY_PASSWORD:-}
    ports:
      - 18183:8083
    # 127.0.0.1, not localhost: in the alpine image localhost resolves to ::1
    # first and the server listens on IPv4 only. Declared here (not just in the
    # Dockerfile) so images published before that fix also report correctly.
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8083/health >/dev/null 2>&1 || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    restart: unless-stopped
    networks:
      - egov-network

  # Private quarantine bucket + least-privilege users. Kept apart from
  # minio-init so the shared egov-rainmaker setup is untouched.
  #   scanproxy          s3:PutObject only — can store evidence, never read it
  #   quarantine-reader  read/list only — for investigators
  # Every step is idempotent; it reruns on each deploy.
  quarantine-init:
    image: egovio/mc:RELEASE.2024-01-16T16-06-34Z
    profiles: [file-scan]
    container_name: digit-quarantine-init
    depends_on:
      minio:
        condition: service_healthy
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
      MINIO_SCANPROXY_PASSWORD: ${MINIO_SCANPROXY_PASSWORD:-}
      MINIO_QUARANTINE_READER_PASSWORD: ${MINIO_QUARANTINE_READER_PASSWORD:-}
    entrypoint: >
      /bin/sh -ec "
      : $${MINIO_SCANPROXY_PASSWORD:?missing - set minio_scanproxy_password in OpenBao};
      : $${MINIO_QUARANTINE_READER_PASSWORD:?missing - set minio_quarantine_reader_password in OpenBao};
      mc alias set myminio http://minio:9000 $$MINIO_ROOT_USER $$MINIO_ROOT_PASSWORD;
      mc mb --ignore-existing myminio/egov-quarantine;
      mc anonymous set none myminio/egov-quarantine;
      echo '{\"Rules\":[{\"ID\":\"expire-quarantine\",\"Status\":\"Enabled\",\"Expiration\":{\"Days\":90}}]}' > /tmp/ilm.json;
      mc ilm import myminio/egov-quarantine < /tmp/ilm.json;
      echo '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\"],\"Resource\":[\"arn:aws:s3:::egov-quarantine/*\"]}]}' > /tmp/writer.json;
      echo '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:ListBucket\",\"s3:GetBucketLocation\"],\"Resource\":[\"arn:aws:s3:::egov-quarantine\",\"arn:aws:s3:::egov-quarantine/*\"]}]}' > /tmp/reader.json;
      mc admin policy create myminio quarantine-writer /tmp/writer.json;
      mc admin policy create myminio quarantine-reader /tmp/reader.json;
      mc admin user add myminio scanproxy $$MINIO_SCANPROXY_PASSWORD;
      mc admin user add myminio quarantine-reader $$MINIO_QUARANTINE_READER_PASSWORD;
      mc admin policy attach myminio quarantine-writer --user scanproxy || true;
      mc admin policy attach myminio quarantine-reader --user quarantine-reader || true;
      "
    networks:
      - egov-network

volumes:
  clamav_data: null
OVERLAY_EOF

# ── .env: image + passwords (only added once) ───────────────────────────────
ENV="$WORKDIR/.env"
touch "$ENV"
if grep -q '^# BEGIN FILE SCAN' "$ENV"; then
  sed -i "s#^FILESTORE_SCAN_PROXY_IMAGE=.*#FILESTORE_SCAN_PROXY_IMAGE=$IMAGE#" "$ENV"
  echo ".env: FILE SCAN block already present — kept passwords, set image."
else
  cp -p "$ENV" "$ENV.bak-before-file-scan"
  {
    echo "# BEGIN FILE SCAN (manual)"
    echo "FILESTORE_SCAN_PROXY_IMAGE=$IMAGE"
    echo "MINIO_SCANPROXY_PASSWORD=$(openssl rand -hex 16)"
    echo "MINIO_QUARANTINE_READER_PASSWORD=$(openssl rand -hex 16)"
    echo "# END FILE SCAN (manual)"
  } >> "$ENV"
  echo ".env: FILE SCAN block added (backup: $ENV.bak-before-file-scan)."
fi

# ── Start only the three new services ───────────────────────────────────────
ARGS=(-p "$PROJECT")
IFS=',' read -ra CF <<< "$FILES"
for f in "${CF[@]}"; do ARGS+=(-f "$f"); done
ARGS+=(-f "$WORKDIR/docker-compose.file-scan.yml")
cd "$WORKDIR"
COMPOSE_PROFILES=file-scan docker compose "${ARGS[@]}" pull --ignore-pull-failures clamav quarantine-init filestore-scan-proxy
COMPOSE_PROFILES=file-scan docker compose "${ARGS[@]}" up -d --no-deps clamav quarantine-init filestore-scan-proxy

# ── Wait for the scanner (first start downloads ~300MB of signatures) ───────
echo "Waiting for clamd (up to 15 min)..."
for _ in $(seq 1 90); do
  [ "$(curl -s --max-time 5 127.0.0.1:18183/health)" = '{"status":"ok"}' ] && break
  sleep 10
done
echo "quarantine-init: $(docker inspect -f '{{.State.ExitCode}}' digit-quarantine-init) (0 = ok)"
if [ "$(curl -s --max-time 5 127.0.0.1:18183/health)" != '{"status":"ok"}' ]; then
  echo "Scanner NOT healthy yet — do not change nginx. Check: docker logs digit-clamav / filestore-scan-proxy" >&2
  exit 1
fi
echo
echo "Scanner healthy on 127.0.0.1:18183. Next: point nginx /filestore/ at it (see README / the instructions you were given)."

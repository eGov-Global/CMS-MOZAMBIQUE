#!/usr/bin/env bash
# Full pre-upgrade backup of a DIGIT compose box. STOPS THE STACK for the
# volume copies (asks first). Usage: backup.sh <digit_dir> <out_dir>
set -euo pipefail
DIR="${1:-/opt/digit}"; OUT="${2:?out dir}"
PG="${PG_CONTAINER:-docker-postgres}"
DBU="${DB_USER:-egov}"
DBN="${DB_NAME:-egov}"
MCPPG="${MCP_PG_CONTAINER:-digit-mcp-postgres}"
# BACKUP_STOP_STACK=1 skips the prompt (set by upgrade.sh under --yes);
# 0 skips the volume copies outright; unset keeps the original prompt.
STOP="${BACKUP_STOP_STACK:-}"
mkdir -p "$OUT"; cd "$OUT"
PROJ="$(basename "$DIR")"

echo "== Logical dumps (stack running)"
docker exec "$PG" pg_dumpall -U "$DBU" > pg_dumpall.sql
docker exec "$PG" psql -U "$DBU" -d "$DBN" -c "\copy message to stdout with csv header" > localization.csv
if docker ps --format '{{.Names}}' | grep -qx "$MCPPG"; then
  docker exec "$MCPPG" sh -c 'pg_dumpall -U "${POSTGRES_USER:-postgres}"' > mcp_pg_dumpall.sql || echo "WARN mcp dump failed"
fi
docker inspect $(docker ps -aq) > containers-inspect.json
docker ps --format '{{.Names}}\t{{.Image}}' > images.txt

echo "== Config copies"
sudo tar czf opt-digit.tgz -C "$(dirname "$DIR")" "$PROJ"
sudo tar czf etc-nginx.tgz -C /etc nginx 2>/dev/null || true
sudo chown "$(id -u):$(id -g)" opt-digit.tgz etc-nginx.tgz 2>/dev/null || true

if [ -z "$STOP" ]; then
  read -r -p "Stop the DIGIT stack now to copy the volumes? [y/N] " ans
  [ "$ans" = "y" ] && STOP=1 || STOP=0
fi
if [ "$STOP" = 1 ]; then
  running=$(docker ps -q --filter "label=com.docker.compose.project=$PROJ")
  [ -n "$running" ] && docker stop $running >/dev/null
  for v in $(docker volume ls -q --filter "name=^${PROJ}_"); do
    echo "   volume $v"
    docker run --rm -v "$v":/v:ro -v "$PWD":/b alpine tar czf "/b/vol-$v.tgz" -C /v .
  done
  echo "Volumes copied. Start the stack again (or proceed to deploy)."
else
  echo "Skipped volume copies - the logical dump above is your only DB backup."
fi

sha256sum ./* > SHA256SUMS
echo "Backup in $OUT. Copy it, and especially $DIR/.openbao/init.json, OFF this machine."

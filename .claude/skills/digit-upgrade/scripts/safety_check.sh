#!/usr/bin/env bash
# Read-only pre/post-upgrade safety check for a DIGIT compose box.
# Usage: safety_check.sh <digit_dir> <host_vars.yml>
set -uo pipefail
DIR="${1:-/opt/digit}"; HV="${2:-}"
PG="${PG_CONTAINER:-docker-postgres}"
DBU="${DB_USER:-egov}"
DBN="${DB_NAME:-egov}"
fail=0
ok()   { echo "OK    $*"; }
warn() { echo "WARN  $*"; }
bad()  { echo "FAIL  $*"; fail=1; }
hv()   { [ -f "$HV" ] && grep -E "^$1:" "$HV" | head -1 | sed -E "s/^$1:[[:space:]]*//; s/[[:space:]]*#.*//"; }
q()    { docker exec "$PG" psql -U "$DBU" -d "$DBN" -Atc "$1" 2>/dev/null; }

echo "== Deploy dir: $DIR"
[ -f "$DIR/docker-compose.egov-digit.yaml" ] && ok "compose file present" || bad "no compose file in $DIR"
[ -f "$DIR/.openbao/init.json" ] && ok ".openbao/init.json present (copy it OFF the box)" || warn ".openbao/init.json missing"
# The deploy unseals OpenBao with this file; a key from another install fails
# only mid-deploy. Check it decrypts THIS OpenBao (status only, key never printed).
if [ -f "$DIR/.openbao/init.json" ] && docker ps --format '{{.Names}}' | grep -qx openbao; then
  sealed=$(docker exec -e BAO_ADDR=http://127.0.0.1:8200 openbao bao status -format=json 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("sealed"))' 2>/dev/null)
  if [ "$sealed" = "True" ]; then
    res=$(python3 -I -c 'import json,sys,subprocess; d=json.load(open(sys.argv[1])); k=(d.get("keys_base64") or d.get("keys"))[0]; r=subprocess.run(["docker","exec","-e","BAO_ADDR=http://127.0.0.1:8200","openbao","bao","operator","unseal","-format=json",k],capture_output=True,text=True); print("ok" if r.returncode==0 else "fail")' "$DIR/.openbao/init.json" 2>/dev/null)
    [ "$res" = "ok" ] && ok "init.json unseals this OpenBao" || bad "init.json does NOT unseal this OpenBao - find the matching key file before deploying"
  else
    ok "OpenBao already unsealed"
  fi
  # The deploy rewrites .env from secrets_path. A path that is empty or holds
  # other values makes every DB client fail to log in after the deploy.
  sp=$(hv secrets_path | tr -d '"'"'"' ')
  if [ -n "$sp" ]; then
    res=$(SP="$sp" python3 -I -c '
import json, os, subprocess, sys
tok = json.load(open(sys.argv[1]))["root_token"]
p = os.environ["SP"].replace("kv/", "kv/data/", 1)
r = subprocess.run(["docker","exec","-e","BAO_ADDR=http://127.0.0.1:8200","-e","BAO_TOKEN="+tok,"openbao","bao","read","-format=json",p], capture_output=True, text=True)
if r.returncode: print("missing"); sys.exit()
data = json.loads(r.stdout).get("data", {}).get("data", {})
env = dict(l.rstrip("\n").split("=", 1) for l in open(sys.argv[2]) if "=" in l and not l.startswith("#"))
print("match" if data.get("postgres_password") and data.get("postgres_password") == env.get("POSTGRES_PASSWORD") else "differs")
' "$DIR/.openbao/init.json" "$DIR/.env" 2>/dev/null)
    case "$res" in
      match)   ok "secrets_path $sp exists and its postgres_password matches .env";;
      missing) bad "secrets_path $sp does NOT exist in this OpenBao - the deploy would write empty/new passwords into .env";;
      *)       bad "secrets_path $sp: postgres_password differs from .env (or could not be read) - check before deploying";;
    esac
  fi
fi

proj=$(docker inspect "$PG" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)
[ "$proj" = "$(basename "$DIR")" ] && ok "compose project '$proj' matches dir name" \
  || bad "compose project '$proj' != '$(basename "$DIR")' - a deploy would create NEW empty volumes"

echo "== Postgres data location"
mnt=$(docker inspect "$PG" --format '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null | grep '|/var/lib/postgresql/data$')
fp=$(hv db_fast_path)
case "$mnt" in
  volume\|*_postgres_data\|*)
    ok "data in named volume ($(echo "$mnt" | cut -d'|' -f2))"
    [ "$fp" = "true" ] && ok "db_fast_path: true (matches - keep it)" \
      || bad "db_fast_path is '${fp:-unset}' but the box runs the fast-path layout - set it to true or the DB will look EMPTY";;
  volume\|*)
    warn "data in ANONYMOUS volume ($(echo "$mnt" | cut -d'|' -f2 | cut -c1-12)...)"
    [ "$fp" = "true" ] && bad "db_fast_path: true would move the mount and WIPE this data - keep it false and plan a volume migration" \
      || ok "db_fast_path not true (correct for this layout); never use force_clean / down";;
  *) bad "could not find postgres data mount (is $PG running?)";;
esac

echo "== Dangerous host_vars"
[ "$(hv force_clean)" = "true" ] && bad "force_clean: true" || ok "force_clean off"
# docker_data_root relocates Docker to a NEW dir; newer playbooks act on it even
# if older ones ignored it, and the target being empty makes the box look FRESH
# (new OpenBao, init.json overwritten, demo dump on first DB start).
ddr=$(hv docker_data_root | tr -d '"'"'"); cur=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
if [ -n "$ddr" ] && [ "$ddr" != "$cur" ]; then
  bad "docker_data_root: $ddr but Docker runs on $cur - the deploy would MOVE Docker to an empty dir; set docker_data_root: \"\""
else
  ok "docker_data_root matches current Docker root (${cur})"
fi
[ -n "$(hv bootstrap_password)" ] && ok "bootstrap_password set" || warn "bootstrap_password unset - bootstrap ADMIN will be reset to eGov@123"
[ "$(hv nginx_preserve_vhost)" = "true" ] || warn "nginx_preserve_vhost not true - /etc/nginx site for the domain will be overwritten"

echo "== Anonymous volumes (lost on 'down')"
for c in $(docker ps --format '{{.Names}}'); do
  docker inspect "$c" --format '{{range .Mounts}}{{if eq .Type "volume"}}{{if eq (len .Name) 64}}{{$.Name}} -> {{.Destination}}{{"\n"}}{{end}}{{end}}{{end}}'
done | sed '/^$/d; s#^/#      #'

echo "== Flyway history tables"
hist=$(q "select table_name from information_schema.columns where table_schema='public' and column_name='installed_rank' group by 1 order by 1")
for t in $hist; do
  f=$(q "select count(*) from \"$t\" where not success")
  [ "${f:-0}" = "0" ] && ok "$t" || bad "$t has $f FAILED migration(s)"
done
echo "$hist" | grep -qx flyway_schema_history && warn "generic flyway_schema_history present - check db/flyway-history-map.yml"

echo "== Data counts (compare before/after)"
for t in eg_pgr_service_v2 eg_user eg_mdms_data message eg_wf_processinstance_v2; do
  echo "      $t: $(q "select count(*) from $t" || echo n/a)"
done

echo
[ $fail = 0 ] && echo "RESULT: no blocking problems" || echo "RESULT: FIX the FAIL lines before deploying"
exit $fail

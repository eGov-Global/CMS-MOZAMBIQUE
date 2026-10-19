#!/usr/bin/env python3
"""Add a new release's access-control records (actions, roles, role->action links)
to an EXISTING tenant. Create-only: never updates or deletes.

Why: a deploy never brings these to an existing tenant (full-dump.sql loads only
into an empty DB; tenant_bootstrap copies from the OLD `pg` in the same DB), and
from v2.12.1 Kong enforces action-level RBAC — missing links mean 403s.

Matching is by MEANING, not id: an action is "the same" if its url matches; a
link is "the same" if (rolecode, url) matches. New actions get the release's id
unless the tenant already uses it, then the next free id. Links are rewritten to
the tenant's own action ids.

Dry run by default. Usage:
  python3 -I sync_accesscontrol.py --dump <release>/local-setup/db/full-dump.sql \
      --tenant mz [--exclude-roles PGR_ADMIN,PGR_SUPERVISOR] [--apply]
Writes go straight to mdms-v2 on 127.0.0.1:18094 (not via Kong, whose RBAC is
exactly what is missing). Every created record is logged to --log (JSON lines).
"""
import argparse, json, os, subprocess, sys, time, urllib.request

ACT_TEST = "ACCESSCONTROL-ACTIONS-TEST.actions-test"
ACT = "ACCESSCONTROL-ACTIONS.actions"
ROLES = "ACCESSCONTROL-ROLES.roles"
LINKS = "ACCESSCONTROL-ROLEACTIONS.roleactions"


def dump_rows(path, tenant):
    out = {ACT_TEST: [], ACT: [], ROLES: [], LINKS: []}
    inside = False
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith("COPY public.eg_mdms_data "):
            inside = True; continue
        if not inside: continue
        if line.startswith("\\."): break
        c = line.rstrip("\n").split("\t")
        if len(c) > 5 and c[1] == tenant and c[3] in out and c[5] == "t":
            out[c[3]].append(json.loads(c[4].replace("\\\\", "\\")))
    return out


def live_rows(container, tenant):
    out = {}
    for sc in (ACT_TEST, ACT, ROLES, LINKS):
        r = subprocess.run(["docker", "exec", container, "psql", "-U", "egov", "-d", "egov", "-Atc",
                            f"select data from eg_mdms_data where tenantid='{tenant}' and schemacode='{sc}' and isactive"],
                           capture_output=True, text=True, check=True)
        out[sc] = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
    return out


def login(kong, user, password, tenant):
    data = urllib.parse.urlencode({"grant_type": "password", "username": user, "password": password,
                                   "scope": "read", "tenantId": tenant, "userType": "EMPLOYEE"}).encode()
    req = urllib.request.Request(kong + "/user/oauth/token", data=data, headers={
        "Authorization": "Basic ZWdvdi11c2VyLWNsaWVudDo=", "Content-Type": "application/x-www-form-urlencoded"})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    return d["access_token"], d["UserRequest"]


def create(mdms, tok, ui, tenant, schema, data):
    body = {"RequestInfo": {"apiId": "Rainmaker", "authToken": tok, "userInfo": ui},
            "Mdms": {"tenantId": tenant, "schemaCode": schema, "data": data, "isActive": True}}
    req = urllib.request.Request(f"{mdms}/mdms-v2/v2/_create/{schema}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=30)
        return "created"
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")
        return "duplicate" if "uplicate" in msg or "DUPLICATE" in msg else f"error {e.code}: {msg[:160]}"


def main():
    import urllib.parse  # noqa: F401  (used in login)
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--source-tenant", default="pg")
    ap.add_argument("--exclude-roles", default="PGR_ADMIN,PGR_SUPERVISOR")
    ap.add_argument("--container", default="docker-postgres")
    ap.add_argument("--mdms", default="http://127.0.0.1:18094")
    ap.add_argument("--kong", default="http://127.0.0.1:18000")
    ap.add_argument("--user", default="ADMIN")
    # Read from the environment by default so the password never shows up in
    # `ps` output; --password still works for a one-off manual run.
    ap.add_argument("--password", default=os.environ.get("ADMIN_PASSWORD"))
    ap.add_argument("--log", default="accesscontrol-sync.jsonl")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    rel = dump_rows(a.dump, a.source_tenant)
    cur = live_rows(a.container, a.tenant)
    excluded = {r for r in a.exclude_roles.split(",") if r}

    rel_url_by_id = {str(x["id"]): x.get("url") for x in rel[ACT_TEST] + rel[ACT]}
    cur_id_by_url = {}
    used_ids = set()
    for x in cur[ACT_TEST] + cur[ACT]:
        used_ids.add(int(x["id"]))
        cur_id_by_url.setdefault(x.get("url"), int(x["id"]))
    next_id = max(used_ids | {0}) + 1

    # 1. actions missing by url (keep release id when free)
    new_actions = []
    seen = set()
    for x in rel[ACT_TEST]:
        u = x.get("url")
        if not u or u in cur_id_by_url or u in seen:
            continue
        seen.add(u)
        rid = int(x["id"])
        if rid in used_ids:
            rid, next_id = next_id, next_id + 1
        used_ids.add(rid)
        rec = dict(x); rec["id"] = rid
        new_actions.append(rec)
        cur_id_by_url[u] = rid

    # 2. roles: only report (roles are a team decision; ACCOUNT_ADMIN etc. added by hand)
    cur_roles = {r.get("code") for r in cur[ROLES]}
    missing_roles = sorted({r.get("code") for r in rel[ROLES]} - cur_roles)

    # 3. links for roles that exist in the tenant, not excluded, not tenant-custom
    cur_pairs = set()
    cur_url_by_id = {str(x["id"]): x.get("url") for x in cur[ACT_TEST] + cur[ACT]}
    for r in cur[LINKS]:
        cur_pairs.add((r.get("rolecode"), cur_url_by_id.get(str(r.get("actionid")))))
    link_ids = {int(r["id"]) for r in cur[LINKS] if str(r.get("id", "")).isdigit()}
    next_link = max(link_ids | {0}) + 1
    new_links, skipped_roles = [], set()
    for r in rel[LINKS]:
        role, url = r.get("rolecode"), rel_url_by_id.get(str(r.get("actionid")))
        if not url or (role, url) in cur_pairs:
            continue
        if role not in cur_roles or role in excluded:
            skipped_roles.add(role); continue
        cur_pairs.add((role, url))
        new_links.append({"id": next_link, "rolecode": role, "actionid": cur_id_by_url[url],
                          "actioncode": r.get("actioncode", ""), "tenantId": a.tenant})
        next_link += 1

    by_role = {}
    for l in new_links:
        by_role[l["rolecode"]] = by_role.get(l["rolecode"], 0) + 1
    print(f"tenant {a.tenant}: actions {len(cur[ACT_TEST])} test / {len(cur[ACT])} live, links {len(cur[LINKS])}")
    print(f"to add: {len(new_actions)} actions (into both {ACT_TEST} and {ACT}), {len(new_links)} role links")
    for role, n in sorted(by_role.items(), key=lambda x: -x[1]):
        print(f"   {role:24} +{n}")
    print(f"roles in release but not in tenant (NOT added): {missing_roles}")
    print(f"links skipped for those/excluded roles: {sorted(skipped_roles)}")
    if not a.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return

    if not a.password:
        raise SystemExit("no admin password: export ADMIN_PASSWORD or pass --password")
    tok, ui = login(a.kong, a.user, a.password, a.tenant)
    counts = {}
    with open(a.log, "a") as log:
        jobs = [(ACT_TEST, x) for x in new_actions] + [(ACT, x) for x in new_actions] + [(LINKS, l) for l in new_links]
        for i, (sc, data) in enumerate(jobs, 1):
            res = create(a.mdms, tok, ui, a.tenant, sc, data)
            key = res.split(":")[0]
            counts[(sc, key)] = counts.get((sc, key), 0) + 1
            log.write(json.dumps({"ts": time.time(), "tenant": a.tenant, "schema": sc, "result": res, "data": data}) + "\n")
            if res.startswith("error") and counts[(sc, key)] <= 3:
                print(f"   {sc} id={data.get('id')}: {res}")
            if i % 100 == 0:
                print(f"   ... {i}/{len(jobs)}")
    for (sc, k), n in sorted(counts.items()):
        print(f"{sc:42} {k:10} {n}")
    print(f"log: {a.log}")


if __name__ == "__main__":
    import urllib.parse, urllib.error  # noqa: E401
    main()

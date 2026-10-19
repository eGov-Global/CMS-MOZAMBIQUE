#!/usr/bin/env python3
"""Post-sync access fixes for an existing tenant moving to the v2.12.1 RBAC model.

1. --grant URL=ROLE,ROLE (repeatable): make sure an action exists for URL (in
   both ACCESSCONTROL-ACTIONS-TEST.actions-test and ACCESSCONTROL-ACTIONS.actions)
   and that each listed role is linked to it. For tenant-specific endpoints the
   release data does not know about (e.g. MOZ /pgr-services/v2/request/_admin/_search):
   the v2.12.1 Kong refuses any call with no matching action.

2. --migrate-dashboard: convert dss.KpiDefinition / dss.DashboardPack from the
   beta role-list model (rbac.visibleTo / roles) to the v2.12.1 capability model
   (requiredActionUrl + public), keeping visibility IDENTICAL to beta:
     - empty/PUBLIC-only role list (beta: every signed-in user) -> base action
       BASE_URL, granted to BASE_ROLES
     - "PUBLIC" in the list -> "public": true (anonymous dashboard)
     - a named role set -> the built-in capability given by --tier, granted to
       the roles of that set that exist in the tenant
   pgr-services v2.12.1 only honours the built-in capabilities in
   AnalyticsCapabilities.ALL, so each distinct role set is mapped to one of
   officer | reports | reports-extended with --tier SET=TIER (sets left unmapped
   stop the run before anything is written).
   The old fields are left in place. Records already carrying requiredActionUrl
   are not touched.

Create/update only — nothing is deleted. Dry run unless --apply. Writes go to
mdms-v2 directly (127.0.0.1:18094), not through Kong. Password from $ADMIN_PASSWORD.
"""
import argparse, json, os, subprocess, sys, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from digit_api import login, request_info  # noqa: E402

ACT_TEST = "ACCESSCONTROL-ACTIONS-TEST.actions-test"
ACT = "ACCESSCONTROL-ACTIONS.actions"
LINKS = "ACCESSCONTROL-ROLEACTIONS.roleactions"
ROLES = "ACCESSCONTROL-ROLES.roles"
KPI = "dss.KpiDefinition"
PACK = "dss.DashboardPack"
CAP_PREFIX = "/pgr-services/v2/analytics/capabilities/"
DASHBOARD_BASE = ["_access", "_query", "packs", "catalog/_search", "_schema"]


class Ctx:
    def __init__(self, a):
        self.a = a
        self.log = open(a.log, "a") if a.apply else None
        self.tok = self.ui = None

    def rows(self, schema):
        out = subprocess.run(["docker", "exec", self.a.container, "psql", "-U", "egov", "-d", "egov", "-Atc",
                              f"select data from eg_mdms_data where tenantid='{self.a.tenant}' "
                              f"and schemacode='{schema}' and isactive"],
                             capture_output=True, text=True, check=True).stdout
        return [json.loads(l) for l in out.splitlines() if l.strip()]

    def auth(self):
        if not self.tok:
            pw = os.environ.get("ADMIN_PASSWORD") or sys.exit("export ADMIN_PASSWORD")
            d = login(self.a.kong, self.a.user, pw, self.a.tenant)
            self.tok, self.ui = d, d
        return request_info(self.tok)

    def call(self, path, body):
        req = urllib.request.Request(self.a.mdms + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")[:300]
        except (TimeoutError, urllib.error.URLError) as e:
            return 0, f"no answer from mdms-v2: {e}"

    def create(self, schema, data):
        if not self.a.apply:
            return "planned"
        c, b = self.call(f"/mdms-v2/v2/_create/{schema}", {"RequestInfo": self.auth(), "Mdms": {
            "tenantId": self.a.tenant, "schemaCode": schema, "data": data, "isActive": True}})
        res = "created" if c in (200, 201, 202) else f"error {c}: {b}"
        self.log.write(json.dumps({"op": "create", "schema": schema, "result": res, "data": data}) + "\n")
        return res

    def update(self, schema, record, new_data):
        if not self.a.apply:
            return "planned"
        rec = dict(record); rec["data"] = new_data
        c, b = self.call(f"/mdms-v2/v2/_update/{schema}", {"RequestInfo": self.auth(), "Mdms": rec})
        res = "updated" if c in (200, 201, 202) else f"error {c}: {b}"
        self.log.write(json.dumps({"op": "update", "schema": schema, "result": res,
                                   "before": record.get("data"), "after": new_data}) + "\n")
        return res

    def search(self, schema):
        c, b = self.call("/mdms-v2/v2/_search", {"RequestInfo": self.auth(), "MdmsCriteria": {
            "tenantId": self.a.tenant, "schemaCode": schema, "limit": 500}})
        if c != 200:
            sys.exit(f"MDMS search {schema} failed: {c} {b}")
        return [m for m in b.get("mdms", []) if m.get("isActive")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--grant", action="append", default=[], help="URL=ROLE,ROLE")
    ap.add_argument("--migrate-dashboard", action="store_true")
    ap.add_argument("--action-resource", action="append", default=[],
                    help="URL=FILE: merge FILE (JSON) into data.resource of that action in both action masters")
    ap.add_argument("--ensure-record", action="append", default=[],
                    help="SCHEMA=FILE: create FILE (JSON) as an MDMS record unless an active one with the same code exists")
    ap.add_argument("--tier", action="append", default=[],
                    help="ROLE+ROLE=officer|reports|reports-extended: built-in tier for tiles/packs whose beta role list is exactly this set")
    ap.add_argument("--remap", action="append", default=[],
                    help="OLD_URL=NEW_URL: repoint tiles/packs whose requiredActionUrl is OLD_URL")
    ap.add_argument("--base-roles", default="EMPLOYEE",
                    help="roles that may use the dashboard at all (beta: every signed-in user)")
    ap.add_argument("--container", default="docker-postgres")
    ap.add_argument("--mdms", default="http://127.0.0.1:18094")
    ap.add_argument("--kong", default="http://127.0.0.1:18000")
    ap.add_argument("--user", default="ADMIN")
    ap.add_argument("--log", default="fix-access.jsonl")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    x = Ctx(a)

    acts_test, acts = x.rows(ACT_TEST), x.rows(ACT)
    roles = {r["code"] for r in x.rows(ROLES)}
    id_by_url = {}
    for r in acts + acts_test:
        id_by_url.setdefault(r.get("url"), int(r["id"]))
    in_live = {r.get("url") for r in acts}
    in_test = {r.get("url") for r in acts_test}
    next_id = max([int(r["id"]) for r in acts + acts_test] + [0]) + 1
    links = x.rows(LINKS)
    url_by_id = {int(r["id"]): r.get("url") for r in acts + acts_test}
    have_link = {(l.get("rolecode"), url_by_id.get(int(l.get("actionid", -1)))) for l in links}
    next_link = max([int(l["id"]) for l in links if str(l.get("id", "")).isdigit()] + [0]) + 1
    template = next((r for r in acts if r.get("url", "").startswith(CAP_PREFIX)), None) \
        or next((r for r in acts if "/analytics/" in r.get("url", "")), acts[0])
    plan = {"actions": 0, "links": 0, "kpi": 0, "pack": 0}
    errors = []

    def ensure_action(url, name):
        nonlocal next_id
        aid = id_by_url.get(url)
        if aid is None:
            aid, next_id = next_id, next_id + 1
            id_by_url[url] = aid
        for schema, have in ((ACT_TEST, in_test), (ACT, in_live)):
            if url in have:
                continue
            data = dict(template); data.update({"id": aid, "url": url, "name": name, "displayName": name,
                                                "enabled": False, "orderNumber": 0})
            res = x.create(schema, data); have.add(url); plan["actions"] += 1
            pending.add(aid)
            print(f"  action {aid:5} {url:62} -> {schema.split('.')[0]}: {res}")
            if res.startswith("error"): errors.append(res)
        return aid

    pending = set()   # action ids created this run, not yet seen in the DB

    def wait_stored(aid):
        # mdms-v2 answers 202 and persists asynchronously; a roleaction x-refs the
        # action id, so linking before the row lands fails REFERENCE_VALIDATION_ERR.
        for _ in range(30):
            n = subprocess.run(["docker", "exec", a.container, "psql", "-U", "egov", "-d", "egov", "-Atc",
                                f"select count(*) from eg_mdms_data where tenantid='{a.tenant}' and schemacode='{ACT_TEST}' "
                                f"and isactive and (data->>'id')::int={aid}"], capture_output=True, text=True).stdout.strip()
            if n and int(n) > 0:
                pending.discard(aid); return
            time.sleep(2)
        sys.exit(f"action {aid} not stored after 60s")

    def ensure_link(role, url):
        nonlocal next_link
        if role not in roles:
            print(f"  skip   {role:22} {url} (role not in tenant)"); return
        if (role, url) in have_link:
            return
        if a.apply and id_by_url[url] in pending:
            wait_stored(id_by_url[url])
        data = {"id": next_link, "rolecode": role, "actionid": id_by_url[url], "actioncode": "",
                "tenantId": a.tenant}
        next_link += 1; have_link.add((role, url)); plan["links"] += 1
        res = x.create(LINKS, data)
        print(f"  link   {role:22} {url}: {res}")
        if res.startswith("error"): errors.append(res)

    for g in a.grant:
        url, _, rl = g.partition("=")
        ensure_action(url, url.rstrip("/").split("/")[-1])
        for role in filter(None, rl.split(",")):
            ensure_link(role, url)

    if a.migrate_dashboard:
        base_roles = [r for r in a.base_roles.split(",") if r]
        base_url = "/pgr-services/v2/analytics/_query"
        for p in DASHBOARD_BASE:
            u = f"/pgr-services/v2/analytics/{p}"
            ensure_action(u, p)
            for role in base_roles:
                ensure_link(role, u)

        tiers = {}
        for t in a.tier:
            k, _, v = t.partition("=")
            tiers["+".join(sorted(k.split("+")))] = CAP_PREFIX + v
        # pgr-services v2.12.1 only honours the built-in capabilities
        # (AnalyticsCapabilities.ALL); a custom tier would be silently ignored.
        # So every distinct role set needs an explicit --tier, checked BEFORE writing.
        sets = set()
        for rec in x.search(KPI):
            if not rec["data"].get("requiredActionUrl"):
                vt = [r for r in ((rec["data"].get("rbac") or {}).get("visibleTo") or []) if r != "PUBLIC"]
                if vt: sets.add("+".join(sorted(set(vt))))
        for rec in x.search(PACK):
            d = rec["data"]
            if not d.get("requiredActionUrl") and not d.get("public") and set(d.get("roles") or []) - {"PUBLIC"}:
                sets.add("+".join(sorted(set(d["roles"]) - {"PUBLIC"})))
        unmapped = sorted(k for k in sets if k not in tiers)
        if unmapped:
            print("these beta role sets need a built-in tier (pass --tier SET=officer|reports|reports-extended):")
            for k in unmapped: print("   --tier \"" + k + "=?\"")
            sys.exit(2)

        def cap_for(role_list, label):
            ceiling = sorted({r for r in (role_list or []) if r and r != "PUBLIC"})
            if not ceiling:
                return base_url
            url = tiers["+".join(ceiling)]
            ensure_action(url, url.split("/")[-1])
            for role in ceiling:
                for p in DASHBOARD_BASE:   # a tier is useless without opening the dashboard
                    ensure_link(role, f"/pgr-services/v2/analytics/{p}")
                ensure_link(role, url)
            return url

        for rec in x.search(KPI):
            d = rec["data"]
            if d.get("requiredActionUrl"):
                continue
            vt = (d.get("rbac") or {}).get("visibleTo") or []
            nd = dict(d); nd["requiredActionUrl"] = cap_for(vt, "tiles")
            if "PUBLIC" in vt:
                nd["public"] = True
            res = x.update(KPI, rec, nd); plan["kpi"] += 1
            print(f"  tile   {d.get('id'):38} {str(sorted(set(vt)))[:46]:46} -> {nd['requiredActionUrl'].split('/')[-1]}{' +public' if nd.get('public') else ''}: {res}")
            if res.startswith("error"): errors.append(res)
        for rec in x.search(PACK):
            d = rec["data"]
            if d.get("requiredActionUrl") or d.get("public"):
                continue
            rl = d.get("roles") or []
            nd = dict(d)
            if rl == ["PUBLIC"] or (rl and set(rl) == {"PUBLIC"}):
                nd["public"] = True
            else:
                nd["requiredActionUrl"] = cap_for(rl, "pack")
            res = x.update(PACK, rec, nd); plan["pack"] += 1
            print(f"  pack   {d.get('id'):38} {str(rl)[:46]:46} -> {nd.get('requiredActionUrl', 'public').split('/')[-1]}: {res}")
            if res.startswith("error"): errors.append(res)

    for spec in a.action_resource:
        url, _, path = spec.partition("=")
        want = json.load(open(path))
        for schema in (ACT_TEST, ACT):
            for rec in x.search(schema):
                d = rec["data"]
                if d.get("url") != url:
                    continue
                res_now = d.get("resource") or {}
                merged = dict(res_now); merged.update(want)
                if merged == res_now:
                    continue
                nd = dict(d); nd["resource"] = merged
                res = x.update(schema, rec, nd); plan["actions"] += 1
                print(f"  scope  {schema.split('.')[0]:28} {url} (id {d.get('id')}): {res}")
                if res.startswith("error"): errors.append(res)

    for spec in a.ensure_record:
        schema, _, path = spec.partition("=")
        want = json.load(open(path))
        if any(r["data"].get("code") == want.get("code") for r in x.search(schema)):
            continue
        res = x.create(schema, want)
        print(f"  record {schema} {want.get('code')}: {res}")
        if res.startswith("error"): errors.append(res)

    remap = dict(r.split("=", 1) for r in a.remap)
    if remap:
        for schema in (KPI, PACK):
            for rec in x.search(schema):
                d = rec["data"]
                if d.get("requiredActionUrl") in remap:
                    nd = dict(d); nd["requiredActionUrl"] = remap[d["requiredActionUrl"]]
                    res = x.update(schema, rec, nd); plan["kpi" if schema == KPI else "pack"] += 1
                    print(f"  remap  {d.get('id'):38} {d['requiredActionUrl'].split('/')[-1]} -> {nd['requiredActionUrl'].split('/')[-1]}: {res}")
                    if res.startswith("error"): errors.append(res)

    print(f"\n{'APPLIED' if a.apply else 'DRY RUN'}: {plan['actions']} action rows, {plan['links']} role links, "
          f"{plan['kpi']} tiles, {plan['pack']} packs" + (f", {len(errors)} ERRORS" if errors else ""))
    if not a.apply:
        print("nothing written — re-run with --apply")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()

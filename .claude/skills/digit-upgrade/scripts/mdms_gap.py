#!/usr/bin/env python3
"""Report MDMS records the new release ships (in its full-dump.sql demo tenant)
that the live tenant does not have. Read-only; writes a CSV for review.

Usage:
  python3 -I mdms_gap.py --dump <new-release>/local-setup/db/full-dump.sql \
      --tenant mz [--source-tenant pg] --out gap.csv
"""
import argparse
import csv
import json
import subprocess

# Content keys used to match records across tenants (uniqueidentifiers differ
# per tenant). Schemas not listed fall back to the full data minus tenantId.
KEYS = {
    "ACCESSCONTROL-ROLES.roles": ["code"],
    "ACCESSCONTROL-ACTIONS-TEST.actions-test": ["url"],
    "ACCESSCONTROL-ACTIONS.actions": ["url"],
    "ACCESSCONTROL-ROLEACTIONS.roleactions": ["rolecode", "actionid"],
}


def key(schema, data):
    if schema in KEYS:
        return json.dumps([data.get(k) for k in KEYS[schema]])
    d = {k: v for k, v in data.items() if k.lower() not in ("tenantid",)}
    return json.dumps(d, sort_keys=True)


def unescape_copy(s):
    return s.replace("\\\\", "\\").replace("\\t", "\t").replace("\\n", "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--source-tenant", default="pg")
    ap.add_argument("--out", required=True)
    ap.add_argument("--container", default="docker-postgres")
    a = ap.parse_args()

    new = {}
    inside = False
    with open(a.dump, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("COPY public.eg_mdms_data "):
                inside = True
                continue
            if not inside:
                continue
            if line.startswith("\\."):
                break
            c = line.rstrip("\n").split("\t")
            if len(c) < 6 or c[1] != a.source_tenant or c[5] != "t":
                continue
            try:
                data = json.loads(unescape_copy(c[4]))
            except ValueError:
                continue
            new.setdefault(c[3], {})[key(c[3], data)] = data

    out = subprocess.run(
        ["docker", "exec", a.container, "psql", "-U", "egov", "-d", "egov", "-At", "-F", "\t", "-c",
         f"select schemacode, data from eg_mdms_data where tenantid='{a.tenant}' and isactive"],
        capture_output=True, text=True, check=True).stdout
    have = {}
    for line in out.splitlines():
        sc, _, d = line.partition("\t")
        try:
            have.setdefault(sc, set()).add(key(sc, json.loads(d)))
        except ValueError:
            pass

    rows, summary = [], []
    for sc in sorted(new):
        missing = [k for k in new[sc] if k not in have.get(sc, set())]
        if missing:
            summary.append((sc, len(new[sc]), len(have.get(sc, ())), len(missing)))
            rows += [(sc, k, json.dumps(new[sc][k])) for k in missing]

    with open(a.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["schema", "match_key", "record_from_new_release"])
        w.writerows(rows)

    # Schemas without a KEYS entry match on full content, so a tenant-specific
    # value (StateInfo, IdFormat, tenants...) shows up as "new or different".
    print(f"{'schema':55} {'release':>7} {'live':>6} {'new_or_different':>16}")
    for s in summary:
        print(f"{s[0]:55} {s[1]:>7} {s[2]:>6} {s[3]:>16}")
    print(f"\n{len(rows)} records written to {a.out} - review before inserting anything.")


if __name__ == "__main__":
    main()

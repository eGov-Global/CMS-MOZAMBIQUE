#!/usr/bin/env python3
"""Compare a tenant's localization messages: backup dump vs the live database.

Read-only. Finds messages the upgrade changed or added — e.g. the deploy's
tenant bootstrap upserts generic messages from the demo tenants (pg, statea,
ke) into the target, which can overwrite the tenant's own translations.

Usage: l10n_diff.py <pg_dumpall.sql> [tenant] [out.tsv]
  PG_CONTAINER (docker-postgres), DB_USER (egov), DB_NAME (egov) from the env.
Writes out.tsv (default ./l10n-changed-<tenant>.tsv) with
  status, locale, module, code, message_before, message_now
in Postgres COPY text format, so the "before" column can be put back as is.
"""
import os
import re
import subprocess
import sys


def key_of(row):
    return (row["tenantid"], row["locale"], row["module"], row["code"])


def from_dump(path, tenant):
    out, cols, inside = {}, None, False
    hdr = re.compile(r"^COPY public\.message \((.*)\) FROM stdin;$")
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not inside:
                m = hdr.match(line)
                if m:
                    cols = [c.strip().strip('"') for c in m.group(1).split(",")]
                    inside = True
                continue
            if line == "\\.":
                break
            row = dict(zip(cols, line.split("\t")))
            if row.get("tenantid") == tenant:
                out[key_of(row)] = row["message"]
    if cols is None:
        sys.exit("no 'COPY public.message' block in the dump")
    return out


def from_db(tenant):
    pg = os.environ.get("PG_CONTAINER", "docker-postgres")
    q = ("COPY (SELECT tenantid, locale, module, code, message FROM message "
         f"WHERE tenantid = '{tenant}') TO STDOUT")
    r = subprocess.run(["docker", "exec", pg, "psql", "-U", os.environ.get("DB_USER", "egov"),
                        "-d", os.environ.get("DB_NAME", "egov"), "-Atc", q],
                       capture_output=True, text=True, check=True)
    out = {}
    for line in r.stdout.splitlines():
        t, loc, mod, code, msg = line.split("\t", 4)
        out[(t, loc, mod, code)] = msg
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    dump, tenant = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "mz")
    out_path = sys.argv[3] if len(sys.argv) > 3 else f"l10n-changed-{tenant}.tsv"
    before, now = from_dump(dump, tenant), from_db(tenant)
    changed = sorted(k for k in before.keys() & now.keys() if before[k] != now[k])
    added = sorted(now.keys() - before.keys())
    removed = sorted(before.keys() - now.keys())
    print(f"tenant {tenant}: before {len(before)}  now {len(now)}")
    print(f"  changed text: {len(changed)}   new codes: {len(added)}   gone: {len(removed)}")
    by_loc = {}
    for k in changed:
        by_loc[k[1]] = by_loc.get(k[1], 0) + 1
    for loc, n in sorted(by_loc.items()):
        print(f"    changed in {loc}: {n}")
    for k in changed[:10]:
        print(f"    e.g. {k[1]} {k[2]} {k[3]}: {before[k][:50]!r} -> {now[k][:50]!r}")
    with open(out_path, "w", encoding="utf-8") as f:
        for k in changed:
            f.write("\t".join(["changed", k[1], k[2], k[3], before[k], now[k]]) + "\n")
        for k in removed:
            f.write("\t".join(["gone", k[1], k[2], k[3], before[k], ""]) + "\n")
    print(f"  details -> {out_path}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Merge Checkov + KICS results into ONE professional security report for
Deployment Option C (Ansible remote-server setup).

Outputs:
  - security-report.html      a self-contained, printable executive report
  - GitHub step-summary        a condensed markdown card (stdout -> $GITHUB_STEP_SUMMARY)

Inputs (env, all optional - missing/empty tolerated):
  CHECKOV_JSON   path to checkov results.json   (list of per-framework reports)
  KICS_JSON      path to kics results.json       (KICS native JSON)
  OUT_HTML       output html path                (default: security-report.html)
  REPO, REF, SHA, RUN_URL, SCAN_SCOPE            metadata for the header
"""
import json, os, html, datetime, collections

# ---- severity model -------------------------------------------------------
SEV_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
SEV_COLOR = {
    "CRITICAL": "#7f1d1d", "HIGH": "#b91c1c", "MEDIUM": "#b45309",
    "LOW": "#4b5563", "INFO": "#6b7280",
}
# Checkov OSS emits no severity -> conservative, documented bucketing.
CHECKOV_SEV = {"secrets": "HIGH", "dockerfile": "MEDIUM", "ansible": "MEDIUM"}


def load(path):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def norm_sev(s):
    s = (s or "").upper()
    if s in ("TRACE",):
        return "INFO"
    return s if s in SEV_ORDER else "MEDIUM"


def findings_from_checkov(data):
    out = []
    if not data:
        return out
    reports = data if isinstance(data, list) else [data]
    for r in reports:
        ct = r.get("check_type", "checkov")
        for c in ((r.get("results") or {}).get("failed_checks") or []):
            fp = (c.get("file_path") or "").lstrip("/")
            line = (c.get("file_line_range") or [None])[0]
            out.append({
                "source": "Checkov", "area": ct,
                "severity": CHECKOV_SEV.get(ct, "MEDIUM"),
                "id": c.get("check_id", ""), "title": c.get("check_name", ""),
                "resource": c.get("resource", ""), "file": fp, "line": line,
                "guideline": c.get("guideline") or "",
            })
    return out


def findings_from_kics(data):
    out = []
    if not data:
        return out
    for q in (data.get("queries") or []):
        sev = norm_sev(q.get("severity"))
        for f in (q.get("files") or []):
            out.append({
                "source": "KICS", "area": "docker-compose",
                "severity": sev, "id": q.get("query_id", "") or q.get("query_name", ""),
                "title": q.get("query_name", ""),
                "resource": (f.get("resource_name") or f.get("issue_type") or ""),
                "file": (f.get("file_name") or "").lstrip("/"),
                "line": f.get("line"),
                "guideline": q.get("query_url") or "",
                "desc": f.get("actual_value") or q.get("description", ""),
                "remediation": q.get("description", ""),
            })
    return out


def esc(x):
    return html.escape(str(x if x is not None else ""))


def sev_badge(sev):
    return (f'<span class="sev" style="background:{SEV_COLOR.get(sev,"#6b7280")}">'
            f'{esc(sev.title())}</span>')


def build_html(findings, meta):
    counts = collections.Counter(f["severity"] for f in findings)
    total = len(findings)
    areas = collections.Counter(f["area"] for f in findings)

    # severity bar (stacked)
    bar = ""
    for s in SEV_ORDER:
        n = counts.get(s, 0)
        if not n:
            continue
        pct = round(n / total * 100, 1) if total else 0
        bar += (f'<div class="seg" style="flex:{n};background:{SEV_COLOR[s]}" '
                f'title="{esc(s)}: {n} ({pct}%)"></div>')
    if not bar:
        bar = '<div class="seg" style="flex:1;background:#16a34a" title="No findings"></div>'

    # KPI tiles
    tiles = [("Total findings", total, "#0f172a")]
    for s in SEV_ORDER:
        if counts.get(s):
            tiles.append((s.title(), counts[s], SEV_COLOR[s]))
    tile_html = "".join(
        f'<div class="tile"><div class="n" style="color:{c}">{v}</div>'
        f'<div class="l">{esc(l)}</div></div>' for l, v, c in tiles)

    # area table
    area_rows = "".join(
        f"<tr><td>{esc(a)}</td><td class='r'>{n}</td></tr>"
        for a, n in areas.most_common())

    # findings grouped by severity then area
    order = {s: i for i, s in enumerate(SEV_ORDER)}
    findings.sort(key=lambda f: (order.get(f["severity"], 9), f["area"], f["id"]))
    rows = ""
    for f in findings:
        loc = esc(f["file"]) + (f":{f['line']}" if f.get("line") else "")
        detail = f.get("remediation") or f.get("desc") or ""
        link = (f' &middot; <a href="{esc(f["guideline"])}" target="_blank" rel="noopener">guide</a>'
                if f.get("guideline") else "")
        rows += (
            f'<tr class="row">'
            f'<td>{sev_badge(f["severity"])}</td>'
            f'<td><div class="t">{esc(f["title"])}</div>'
            f'<div class="m"><code>{esc(f["id"])}</code> &middot; {esc(f["source"])} &middot; {esc(f["area"])}{link}</div>'
            f'{("<div class=d>"+esc(detail)+"</div>") if detail else ""}</td>'
            f'<td class="loc"><code>{loc}</code><div class="m">{esc(f["resource"])}</div></td>'
            f'</tr>')
    if not rows:
        rows = '<tr><td colspan="3" class="ok">No findings in scope. Clean.</td></tr>'

    posture = "No issues" if total == 0 else (
        "Action required" if counts.get("CRITICAL") or counts.get("HIGH") else "Review recommended")
    posture_color = "#16a34a" if total == 0 else (
        "#b91c1c" if counts.get("CRITICAL") or counts.get("HIGH") else "#b45309")

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security Assessment - {esc(meta['repo'])} (Option C)</title>
<style>
:root{{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f8fafc;--card:#fff}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);
 font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}}
.wrap{{max-width:1040px;margin:0 auto;padding:32px 24px 64px}}
header.top{{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
 border-bottom:3px solid var(--ink);padding-bottom:16px}}
h1{{font-size:22px;margin:0 0 4px}} .sub{{color:var(--muted);font-size:13px}}
.meta{{text-align:right;font-size:12px;color:var(--muted);line-height:1.7}}
.meta b{{color:var(--ink)}}
.posture{{display:inline-block;margin-top:10px;padding:4px 12px;border-radius:999px;
 color:#fff;font-weight:600;font-size:12px}}
section{{background:var(--card);border:1px solid var(--line);border-radius:12px;
 padding:18px 20px;margin-top:20px}}
h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
 margin:0 0 14px}}
.tiles{{display:flex;gap:14px;flex-wrap:wrap}}
.tile{{flex:1;min-width:120px;background:var(--bg);border:1px solid var(--line);
 border-radius:10px;padding:14px 16px;text-align:center}}
.tile .n{{font-size:28px;font-weight:700;line-height:1}} .tile .l{{font-size:12px;color:var(--muted);margin-top:6px}}
.bar{{display:flex;height:14px;border-radius:7px;overflow:hidden;margin-top:16px;background:#e2e8f0}}
.bar .seg{{min-width:3px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
td,th{{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}}
td.r{{text-align:right;font-variant-numeric:tabular-nums}}
.sev{{display:inline-block;color:#fff;font-size:11px;font-weight:700;padding:2px 9px;
 border-radius:999px;white-space:nowrap}}
.row .t{{font-weight:600}} .row .m{{color:var(--muted);font-size:12px;margin-top:2px}}
.row .d{{color:#475569;font-size:12px;margin-top:6px}}
.loc{{white-space:nowrap}} code{{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:12px}}
.ok{{text-align:center;color:#16a34a;font-weight:600;padding:24px}}
a{{color:#1d4ed8}} .foot{{color:var(--muted);font-size:11px;margin-top:24px;line-height:1.7}}
@media print{{body{{background:#fff}} section{{break-inside:avoid;border-color:#ccc}} .tile{{background:#fff}}}}
</style></head><body><div class="wrap">
<header class="top">
 <div>
  <h1>Security Assessment</h1>
  <div class="sub">{esc(meta['repo'])} &middot; {esc(meta['scope'])}</div>
  <div class="posture" style="background:{posture_color}">{esc(posture)}</div>
 </div>
 <div class="meta">
  <div>Branch: <b>{esc(meta['ref'])}</b></div>
  <div>Commit: <b>{esc(meta['sha'][:7])}</b></div>
  <div>Scanned: <b>{esc(meta['date'])}</b></div>
  <div>Scanners: <b>Checkov + KICS</b></div>
 </div>
</header>

<section>
 <h2>Risk summary</h2>
 <div class="tiles">{tile_html}</div>
 <div class="bar">{bar}</div>
</section>

<section>
 <h2>Findings by area</h2>
 <table><tr><th>Area</th><th class="r">Findings</th></tr>{area_rows}</table>
</section>

<section>
 <h2>Findings ({total})</h2>
 <table>
  <tr><th style="width:96px">Severity</th><th>Issue</th><th style="width:34%">Location</th></tr>
  {rows}
 </table>
</section>

<div class="foot">
 Generated {esc(meta['date'])} from commit {esc(meta['sha'][:7])}
 (<a href="{esc(meta['run_url'])}">workflow run</a>). Scope: {esc(meta['scope'])}.
 Report-only mode - findings are informational and do not block merges.
 Severity: KICS assigns native severities; Checkov (OSS) does not emit severities, so its
 findings are bucketed conservatively (secrets = High, other = Medium).
 Full triage with de-duplication and dismissal is available in the repository
 Security &rarr; Code scanning tab.
</div>
</div></body></html>"""


def build_summary(findings):
    counts = collections.Counter(f["severity"] for f in findings)
    total = len(findings)
    out = ["## 🛡️ Security Assessment — Option C (Ansible deploy)\n"]
    if total == 0:
        out.append("**✅ No findings in scope.**\n")
    else:
        chips = "  ".join(f"**{s.title()}** {counts[s]}" for s in SEV_ORDER if counts.get(s))
        out.append(f"**{total} findings**  ·  {chips}\n")
        out.append("| Severity | Count |")
        out.append("|---|--:|")
        for s in SEV_ORDER:
            if counts.get(s):
                out.append(f"| {s.title()} | {counts[s]} |")
        out.append("\n📄 **Full report:** download the **security-report** artifact from this run "
                   "(printable executive HTML). Engineer triage: **Security → Code scanning**.")
    return "\n".join(out)


def main():
    findings = (findings_from_checkov(load(os.environ.get("CHECKOV_JSON")))
                + findings_from_kics(load(os.environ.get("KICS_JSON"))))
    meta = {
        "repo": os.environ.get("REPO", "repository"),
        "ref": os.environ.get("REF", ""),
        "sha": os.environ.get("SHA", ""),
        "run_url": os.environ.get("RUN_URL", "#"),
        "scope": os.environ.get("SCAN_SCOPE", "Deployment Option C (Ansible remote server)"),
        "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    }
    out_html = os.environ.get("OUT_HTML", "security-report.html")
    with open(out_html, "w") as f:
        f.write(build_html(list(findings), meta))
    print(build_summary(findings))


if __name__ == "__main__":
    main()

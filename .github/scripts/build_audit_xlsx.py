#!/usr/bin/env python3
"""
Build a multi-sheet security AUDIT workbook (.xlsx) from run.json for team tracking.

Sheets:
  1. Summary            - scan metadata + counts by status / priority / severity / category
  2. Action Required    - the tracking sheet (only findings that genuinely need fixing),
                          with blank Status / Owner / Target date / Notes columns for the team
  3. Not Tracked        - acceptable ("okayish") + false positives, with the reason they are
                          excluded from tracking (kept for audit completeness)
  4. All Locations      - every occurrence of an action-required finding (file:line + link)

Triage taxonomy (set by enrich_report.py):
  triage.status  = action_required | acceptable | false_positive
  triage.priority= P1 | P2 | P3   (action_required only)

If enrichment did not run, every finding is treated as action_required (nothing hidden).

Env: RUN_JSON (default run.json), OUT_XLSX (default security-audit.xlsx)
Requires: openpyxl
"""
import os, sys, json

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except Exception as e:
    print(f"openpyxl unavailable ({e}); skipping xlsx audit export.", file=sys.stderr)
    sys.exit(0)

RUN = os.environ.get("RUN_JSON", "run.json")
OUT = os.environ.get("OUT_XLSX", "security-audit.xlsx")

try:
    run = json.load(open(RUN))
except Exception as e:
    print(f"cannot read {RUN}: {e}", file=sys.stderr); sys.exit(0)

meta = run.get("meta", {})
findings = run.get("findings", [])

SEV_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
PRI_ORDER = {"P1": 0, "P2": 1, "P3": 2, "": 3, None: 3}


def status_of(f):
    return (f.get("triage") or {}).get("status") or "action_required"


def priority_of(f):
    return (f.get("triage") or {}).get("priority") or ("P2" if status_of(f) == "action_required" else "")


action = [f for f in findings if status_of(f) == "action_required"]
acceptable = [f for f in findings if status_of(f) == "acceptable"]
false_pos = [f for f in findings if status_of(f) == "false_positive"]

action.sort(key=lambda f: (PRI_ORDER.get(priority_of(f), 3), SEV_ORDER.index(f["severity"]) if f["severity"] in SEV_ORDER else 9, -f.get("count", 0)))

# ---- styling helpers -------------------------------------------------------
INK = "0F172A"
ACCENT = "0F3A5F"
HEAD_FILL = PatternFill("solid", fgColor=ACCENT)
HEAD_FONT = Font(color="FFFFFF", bold=True, size=11)
TITLE_FONT = Font(color=ACCENT, bold=True, size=15)
SUB_FONT = Font(color="64748B", size=10)
WRAP = Alignment(vertical="top", wrap_text=True)
TOP = Alignment(vertical="top")
THIN = Side(style="thin", color="E5E9F0")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
SEV_FILL = {"CRITICAL": "7F1D1D", "HIGH": "DC2626", "MEDIUM": "F59E0B", "LOW": "64748B", "INFO": "CBD5E1"}
PRI_FILL = {"P1": "DC2626", "P2": "F59E0B", "P3": "64748B"}


def header_row(ws, headers, row=1):
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=row, column=c, value=h)
        cell.fill = HEAD_FILL; cell.font = HEAD_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[row].height = 26
    ws.freeze_panes = ws.cell(row=row + 1, column=1)


def widths(ws, w):
    for i, width in enumerate(w, 1):
        ws.column_dimensions[get_column_letter(i)].width = width


def sev_tag(cell, sev):
    cell.fill = PatternFill("solid", fgColor=SEV_FILL.get(sev, "CBD5E1"))
    cell.font = Font(color="0F172A" if sev in ("LOW", "INFO") else "FFFFFF", bold=True)
    cell.alignment = Alignment(horizontal="center", vertical="top")


def pri_tag(cell, pri):
    if pri in PRI_FILL:
        cell.fill = PatternFill("solid", fgColor=PRI_FILL[pri])
        cell.font = Font(color="FFFFFF", bold=True)
    cell.alignment = Alignment(horizontal="center", vertical="top")


wb = Workbook()

# ---- Sheet 1: Summary ------------------------------------------------------
ws = wb.active; ws.title = "Summary"
ws["A1"] = "Security Audit - Ansible Remote Server Deployment"; ws["A1"].font = TITLE_FONT
ws["A2"] = f"{meta.get('repo','')}  ·  branch {meta.get('branch','')}  ·  commit {meta.get('shaShort','')}  ·  scanned {meta.get('date','')}"
ws["A2"].font = SUB_FONT
eng = meta.get("engine")
ws["A3"] = ("Triage & remediation: %s, fail-safe dual-pass verified." % eng) if eng else "Remediation: curated ruleset (AI enrichment not run)."
ws["A3"].font = SUB_FONT

r = 5
ws.cell(row=r, column=1, value="Tracking status").font = Font(bold=True, color=ACCENT)
r += 1
rows = [
    ("Action required (tracked)", len(action)),
    ("Acceptable / not tracked", len(acceptable)),
    ("False positives", len(false_pos)),
    ("Total issue types", len(findings)),
    ("Total occurrences", run.get("summary", {}).get("occurrences", sum(f.get("count", 0) for f in findings))),
]
for label, val in rows:
    ws.cell(row=r, column=1, value=label).alignment = TOP
    ws.cell(row=r, column=2, value=val).alignment = TOP
    r += 1

r += 1
ws.cell(row=r, column=1, value="Action required by priority").font = Font(bold=True, color=ACCENT); r += 1
for p in ("P1", "P2", "P3"):
    ws.cell(row=r, column=1, value=p)
    ws.cell(row=r, column=2, value=sum(1 for f in action if priority_of(f) == p)); r += 1

r += 1
ws.cell(row=r, column=1, value="Action required by category").font = Font(bold=True, color=ACCENT); r += 1
cats = {}
for f in action:
    cats[f.get("category", "General Hardening")] = cats.get(f.get("category", "General Hardening"), 0) + 1
for cat, n in sorted(cats.items(), key=lambda x: -x[1]):
    ws.cell(row=r, column=1, value=cat)
    ws.cell(row=r, column=2, value=n); r += 1

widths(ws, [34, 12])

# ---- Sheet 2: Action Required (tracking) -----------------------------------
ws = wb.create_sheet("Action Required")
H = ["Priority", "Severity", "Category", "Finding", "Rule ID", "Scanner", "Exposure",
     "Occurrences", "Why it matters", "How to fix", "Reference", "First location",
     "Status", "Owner", "Target date", "Notes"]
header_row(ws, H)
row = 2
for f in action:
    tri = f.get("triage") or {}
    loc = (f.get("locations") or [{}])[0]
    vals = [priority_of(f), f["severity"], f.get("category", ""), f.get("title", ""),
            f.get("id", ""), f.get("source", ""), tri.get("exposure", ""),
            f.get("count", 0), f.get("why", ""), f.get("fix", ""), f.get("guide", ""),
            f"{loc.get('path','')}:{loc.get('line','')}" if loc.get("path") else "",
            "Open", "", "", tri.get("reason", "")]
    for c, v in enumerate(vals, 1):
        cell = ws.cell(row=row, column=c, value=v)
        cell.alignment = WRAP if c in (3, 4, 9, 10, 16) else TOP
        cell.border = BORDER
    pri_tag(ws.cell(row=row, column=1), priority_of(f))
    sev_tag(ws.cell(row=row, column=2), f["severity"])
    # hyperlink the reference + first location
    if f.get("guide"):
        ws.cell(row=row, column=11).hyperlink = f["guide"]; ws.cell(row=row, column=11).font = Font(color="1D4ED8", underline="single")
    if loc.get("url"):
        ws.cell(row=row, column=12).hyperlink = loc["url"]; ws.cell(row=row, column=12).font = Font(color="1D4ED8", underline="single")
    ws.row_dimensions[row].height = 58
    row += 1
if row == 2:
    ws.cell(row=2, column=1, value="No action-required findings.").font = SUB_FONT
widths(ws, [9, 10, 22, 30, 16, 9, 11, 12, 46, 50, 26, 30, 12, 14, 12, 30])
ws.auto_filter.ref = f"A1:{get_column_letter(len(H))}{max(row-1,1)}"

# ---- Sheet 3: Not Tracked (acceptable + false positive) --------------------
ws = wb.create_sheet("Not Tracked")
H = ["Tracking status", "Severity", "Category", "Finding", "Rule ID", "Scanner",
     "Occurrences", "Reason excluded", "Why (context)"]
header_row(ws, H)
row = 2
for f in acceptable + false_pos:
    tri = f.get("triage") or {}
    label = "Acceptable" if status_of(f) == "acceptable" else "False positive"
    vals = [label, f["severity"], f.get("category", ""), f.get("title", ""), f.get("id", ""),
            f.get("source", ""), f.get("count", 0), tri.get("reason", ""), f.get("why", "")]
    for c, v in enumerate(vals, 1):
        cell = ws.cell(row=row, column=c, value=v)
        cell.alignment = WRAP if c in (3, 4, 8, 9) else TOP
        cell.border = BORDER
    sev_tag(ws.cell(row=row, column=2), f["severity"])
    ws.row_dimensions[row].height = 44
    row += 1
if row == 2:
    ws.cell(row=2, column=1, value="Nothing excluded - every finding is action-required.").font = SUB_FONT
widths(ws, [15, 10, 22, 30, 16, 9, 12, 46, 46])
ws.auto_filter.ref = f"A1:{get_column_letter(len(H))}{max(row-1,1)}"

# ---- Sheet 4: All Locations (action-required occurrences) ------------------
ws = wb.create_sheet("All Locations")
H = ["Priority", "Severity", "Category", "Finding", "Rule ID", "File", "Line", "Link"]
header_row(ws, H)
row = 2
for f in action:
    for loc in (f.get("locations") or []):
        vals = [priority_of(f), f["severity"], f.get("category", ""), f.get("title", ""),
                f.get("id", ""), loc.get("path", ""), loc.get("line", ""), loc.get("url", "")]
        for c, v in enumerate(vals, 1):
            cell = ws.cell(row=row, column=c, value=v)
            cell.alignment = WRAP if c in (3, 4) else TOP
            cell.border = BORDER
        pri_tag(ws.cell(row=row, column=1), priority_of(f))
        sev_tag(ws.cell(row=row, column=2), f["severity"])
        if loc.get("url"):
            ws.cell(row=row, column=8).value = "open"
            ws.cell(row=row, column=8).hyperlink = loc["url"]
            ws.cell(row=row, column=8).font = Font(color="1D4ED8", underline="single")
        row += 1
if row == 2:
    ws.cell(row=2, column=1, value="No action-required locations.").font = SUB_FONT
widths(ws, [9, 10, 22, 30, 16, 46, 8, 10])
ws.auto_filter.ref = f"A1:{get_column_letter(len(H))}{max(row-1,1)}"

wb.save(OUT)
print(f"wrote {OUT}: {len(action)} action-required, {len(acceptable)} acceptable, {len(false_pos)} false-positive.", file=sys.stderr)

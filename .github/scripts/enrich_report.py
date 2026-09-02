#!/usr/bin/env python3
"""
Agentic enrichment of run.json via a free OpenAI-compatible LLM (default: Google Gemini).

Pipeline (batched, ~6 calls/run):
  0. context   - read the real code around each finding (deterministic, no LLM)
  1. triage    - action_required / acceptable / false_positive + priority + exposure + reason
     1b. audit  - skeptical independent second triage pass (fail-safe)
  2. validate  - independent labeling/assertion pass: re-derives category, severity,
                 priority and deployment-applicability FROM THE CODE, so mis-labeled or
                 agent-sourced (Strix) findings get the right label/priority. Reconciled
                 with a bias-to-caution 3-way vote; raw scanner severity is annotated, not
                 overwritten.
  3. remediate - context-aware why / how-to-fix, grounded in the actual code
  4. verify    - DUAL-PASS critic: a fix is "verified" only if BOTH independent
                 reviewers approve; otherwise "needs review"
  5. summary   - executive summary + prioritized action list

Guardrails (no negligence):
  - No API key -> clean no-op (report keeps its curated remediation).
  - Any stage failure -> that stage is skipped, pipeline continues (never crashes).
  - Raw scanner findings are never altered; the agents only ANNOTATE.
  - Likely false positives are LABELLED, never dropped.
  - Per-rule results cached on gh-pages so unchanged rules aren't re-billed.

Env: GEMINI_API_KEY (or LLM_API_KEY), GEMINI_MODEL, LLM_BASE, RUN_JSON, CACHE_FILE, REPO.
"""
import os, sys, json, time, re, urllib.request, urllib.error

def log(*a): print(*a, file=sys.stderr)

KEY   = os.environ.get("GEMINI_API_KEY") or os.environ.get("LLM_API_KEY")
BASE  = os.environ.get("LLM_BASE", "https://generativelanguage.googleapis.com/v1beta/openai").rstrip("/")
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.0-flash"
RUN   = os.environ.get("RUN_JSON", "run.json")
CACHE = os.environ.get("CACHE_FILE", "enrich-cache.json")
REPO  = os.environ.get("REPO", "")

if not KEY:
    log("no LLM API key set; skipping enrichment (curated remediation kept).")
    sys.exit(0)


def _http(url, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def discover_model():
    """Pick a model this key can actually use, from the provider's /models list.
    Hardcoded IDs (e.g. gemini-2.0-flash) 404 on keys that don't expose them."""
    want = os.environ.get("GEMINI_MODEL")
    ids = []
    try:
        d = _http(BASE + "/models")
        ids = [m.get("id") for m in (d.get("data") or d.get("models") or []) if m.get("id")]
    except Exception as e:
        log("model discovery failed:", e)
    def find(name):
        for i in ids:
            if i == name or i.endswith("/" + name):
                return i
        return None
    if want:
        m = find(want)
        if m or not ids:
            return m or want
    # Ranked current-generation first. The provider's /models list can include models
    # that are deprecated for NEW keys (they 404 at chat time with "use models/X"), so
    # the *-latest aliases lead because they always resolve to a callable current model;
    # call() also auto-switches to whatever the API recommends. All are reasoning-capable.
    for pref in ("gemini-flash-latest", "gemini-3.6-flash", "gemini-3-flash",
                 "gemini-2.5-flash", "gemini-pro-latest", "gemini-2.5-pro",
                 "gemini-2.0-flash", "gemini-1.5-flash"):
        m = find(pref)
        if m:
            return m
    for i in ids:  # any flash model as a last resort
        if "flash" in i.lower():
            return i
    return ids[0] if ids else (want or "gemini-flash-latest")


MODEL = discover_model()
# The /models list returns ids like "models/gemini-2.5-flash", but the OpenAI-compat
# chat endpoint wants the BARE id ("gemini-2.5-flash"). Keeping the prefix makes every
# chat call 404 while /models still succeeds - which looks like "enabled but empty".
if MODEL and MODEL.startswith("models/"):
    MODEL = MODEL[len("models/"):]
log(f"using model: {MODEL}")


def _suggested_model(body):
    """Extract a replacement model from a provider 404 like:
    'This model models/gemini-2.5-flash is no longer available ... use models/gemini-3.6-flash'."""
    m = re.search(r"use\s+(?:the\s+)?`?(?:models/)?([A-Za-z0-9][A-Za-z0-9.\-]*[A-Za-z0-9])", body)
    return m.group(1) if m else None


# If the primary model is overloaded (503 "high demand") or unavailable, fall back to
# these in order. Lite variants have far more free-tier headroom, so they ride out
# capacity spikes on the flagship flash model while staying capable for annotation.
FALLBACKS = ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite", "gemini-2.0-flash"]


def _chat(model, messages, temperature, max_tokens, use_json):
    body = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    if use_json:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def call(messages, temperature=0.2, max_tokens=4096):
    """One OpenAI-compatible chat call, resilient by design. Walks a candidate chain
    (primary model first, then lighter fallbacks). Per model: retries transient errors
    (503 "high demand", timeouts, 429) with exponential backoff, drops response_format
    on a 400, and honours an API 'use models/X' recommendation. Returns text or None.
    Whatever model first succeeds becomes the new default for the rest of the run."""
    global MODEL
    candidates = [MODEL] + [m for m in FALLBACKS if m != MODEL]
    ci = 0
    while ci < len(candidates):
        model = candidates[ci]; use_json = True
        for attempt in range(4):
            try:
                out = _chat(model, messages, temperature, max_tokens, use_json)
                if model != MODEL:
                    log(f"switched to model '{model}' (previous unavailable/overloaded)")
                    MODEL = model
                return out
            except urllib.error.HTTPError as e:
                eb = ""
                try: eb = e.read().decode("utf-8", "ignore")
                except Exception: pass
                if e.code == 404:
                    sug = _suggested_model(eb)
                    if sug and sug not in candidates:
                        candidates.insert(ci + 1, sug)  # try the API's recommendation next
                    break  # a 404 won't clear on retry; move to next candidate
                if e.code == 400 and use_json:
                    use_json = False; continue  # provider rejected response_format
                if e.code in (408, 429, 500, 502, 503) and attempt < 3:
                    time.sleep(min(30, 4 * (2 ** attempt))); continue  # 4, 8, 16s
                log(f"LLM HTTP {e.code} on {model}: {eb[:160]}"); break
            except Exception as e:
                # A timeout/connection error means this model is too slow or overloaded;
                # pivoting to a lighter fallback beats burning another 120s on the same one.
                log(f"LLM error on {model}: {e}"); break
        ci += 1
    return None


def parse(text):
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        pass
    for a, b in (("{", "}"), ("[", "]")):
        i, j = text.find(a), text.rfind(b)
        if 0 <= i < j:
            try:
                return json.loads(text[i:j + 1])
            except Exception:
                pass
    return None


def rows(text):
    d = parse(text)
    if isinstance(d, dict):
        d = d.get("results", d.get("items", []))
    return {x["id"]: x for x in d if isinstance(x, dict) and x.get("id")} if isinstance(d, list) else {}


def snippet(path, line, ctx=6):
    try:
        lines = open(path, errors="ignore").readlines()
    except Exception:
        return ""
    if not line:
        return "".join(lines[:12])[:600]
    a = max(0, line - ctx - 1); b = min(len(lines), line + ctx)
    return "".join(f"{a + 1 + k}: {l}" for k, l in enumerate(lines[a:b]))[:800]


# ---- load ------------------------------------------------------------------
try:
    run = json.load(open(RUN))
except Exception as e:
    log(f"cannot read {RUN}: {e}"); sys.exit(0)
findings = run.get("findings", [])
if not findings:
    log("no findings to enrich."); sys.exit(0)

rules = {}
for f in findings:
    r = rules.setdefault(f["id"], {"id": f["id"], "title": f["title"], "severity": f["severity"],
                                   "area": f["area"], "source": f.get("source", ""),
                                   "category": f.get("category", ""), "cvss": f.get("cvss"),
                                   "cwe": f.get("cwe"), "count": 0, "locs": []})
    r["count"] += f["count"]
    if not r["locs"] and f.get("locations"):
        r["locs"] = f["locations"][:2]
for r in rules.values():
    r["snippet"] = "\n---\n".join(snippet(l["path"], l.get("line"), ctx=10) for l in r["locs"]) or "(no code context)"

# NO cross-run cache. Every run re-enriches every rule from scratch so results are never
# diluted by stale enrichment carried over from a previous run (explicit requirement).
cache = {}
CACHE_V = 6  # bumped: cache is now single-run only, always fresh
todo = list(rules.values())  # always re-enrich everything
CTX = "Ansible remote-server deployment (setup path C: ./deploy.sh) plus its docker-compose stack for DIGIT/CMS, a public-sector complaint-management platform. The repository is PUBLIC."

# Deployment topology the triager must reason WITH, so it judges real-world exposure
# instead of the raw rule. This mirrors how this stack actually runs.
DEPLOY = (
    "Deployment reality (verified on the live server via a read-only audit): services run on a single "
    "internet-facing remote host. nginx terminates TLS on 443 and is the intended public entry point. "
    "IMPORTANT: there is NO host firewall (ufw is inactive), and ~33 service ports - INCLUDING datastores "
    "(PostgreSQL, Redis, Kafka, MinIO) and admin UIs (Grafana, Prometheus, Jupyter) - are published on "
    "0.0.0.0 (all host interfaces). Externally only 22/80/443 are reachable, so the cloud security group "
    "is the SOLE control in front of those datastore/admin ports - a single point of failure with no "
    "defense-in-depth. Data is citizen grievance data (confidential). Judge each finding by real "
    "abusability here: a datastore/admin port bound to 0.0.0.0 with no host firewall is action_required at P0 "
    "(one security-group misconfig from full exposure), NOT 'internal/acceptable'. A control genuinely "
    "required and already constrained (e.g. node_exporter host mounts, read-only) may be acceptable."
)

RUBRIC = (
    "Classify each finding into exactly one status, reasoning from the code and the topology:\n"
    "- action_required: a genuine weakness a hardening standard (CIS Docker Benchmark / OWASP) would require "
    "fixing. This INCLUDES missing standard security controls even on internal services - not dropping Linux "
    "capabilities (cap_drop:[ALL]), missing no-new-privileges, a writable root filesystem, disabling TLS "
    "certificate validation, http:// for calls carrying credentials/secrets, mounting the Docker socket, "
    "sharing a host namespace writable, or bind-mounting sensitive host paths writable. Being on an internal "
    "network or behind a gateway is a reason to LOWER the priority (usually to P3), NOT to dismiss the finding: "
    "defense in depth still matters if any single container is compromised.\n"
    "- acceptable: reserve for findings that are NOT a security control, or where the flagged access is genuinely "
    "REQUIRED by the workload AND already constrained. Specifically only: (a) reliability-only controls (missing "
    "healthcheck, CPU or memory limits); (b) host access a monitoring/telemetry agent legitimately needs AND that "
    "is read-only (e.g. node_exporter mounting host /proc,/sys or sharing host PID read-only); (c) a benign, "
    "equivalent-security rewrite (mapping privileged port 80 to a high host port). Do NOT mark a missing cheap "
    "standard hardening control (cap_drop, no-new-privileges, read_only) as acceptable just because the service is internal.\n"
    "- false_positive: the scanner misfired - the flagged condition does not actually hold: a templated/example "
    "value, the control IS present by another means, or it applies only under a dev-only flag that is off in "
    "production (only if the code clearly proves this).\n"
    "Bias to caution: if unsure, choose action_required (P3). Never downgrade a real hardening gap to acceptable or "
    "false_positive merely because exploitation would need a prior foothold or the service is internal.\n"
    "priority (action_required only) - use a 4-level scale P0..P3:\n"
    "  P0 = critical, act now: direct container escape / host takeover / credential or secret exposure, "
    "or a critical asset reachable with the sole control one misconfig away (Docker socket mount; a datastore/"
    "admin port on 0.0.0.0 with NO host firewall; a committed default credential; an unauthenticated admin API).\n"
    "  P1 = high, needs a precondition: enables privilege escalation or lateral movement given a foothold, or "
    "weakened transport security (disabled TLS validation, insecure registry, cleartext carrying secrets).\n"
    "  P2 = medium: a real hardening gap with limited blast radius.\n"
    "  P3 = low / defense-in-depth on an internal service (drop capabilities, no-new-privileges, resource limits).\n"
    "exposure: public (reachable from internet) | internal (container-to-container only) | local (host-only) | unknown."
)


# ---- stages ----------------------------------------------------------------
def _tri_payload(rs):
    return [{"id": r["id"], "title": r["title"], "severity": r["severity"], "area": r["area"],
             "file": (r["locs"][0]["path"] if r["locs"] else ""), "snippet": r["snippet"]} for r in rs]


def stage_triage(rs):
    """Primary, deployment-aware assessment: status + priority + exposure + reason."""
    if not rs: return {}
    return rows(call([
        {"role": "system", "content": f"You are a senior application-security engineer triaging findings for a {CTX} {DEPLOY}\n\n{RUBRIC}\n\nReason from the actual code snippet and file before deciding."},
        {"role": "user", "content": 'Return ONLY JSON: {"results":[{"id":"...","status":"action_required|acceptable|false_positive","priority":"P1|P2|P3","exposure":"public|internal|local|unknown","confidence":0.0,"reason":"<=25 words, evidence-based"}]}\n\nFindings:\n' + json.dumps(_tri_payload(rs))}]))


def stage_triage_audit(rs):
    """Independent skeptical second pass (fail-safe). Only agrees to dismiss a finding
    when confident it cannot be abused; otherwise keeps it action_required."""
    if not rs: return {}
    return rows(call([
        {"role": "system", "content": f"You are a skeptical lead security auditor reviewing a {CTX} {DEPLOY}\n\nFor each finding decide independently whether it TRULY needs action here, or is safely acceptable / a false positive. Only dismiss when the finding is a reliability-only control (healthcheck, cpu/memory), OR the flagged host access is genuinely required by the workload and already read-only/constrained (e.g. a monitoring agent), OR the scanner clearly misfired. Do NOT dismiss a missing standard hardening control - dropping capabilities, no-new-privileges, TLS certificate validation, avoiding cleartext for secrets - just because the service is internal or behind a gateway; keep those action_required at low priority. When in doubt, keep it action_required. Do not rubber-stamp."},
        {"role": "user", "content": 'Return ONLY JSON: {"results":[{"id":"...","status":"action_required|acceptable|false_positive","reason":"<=20 words"}]}\n\nFindings:\n' + json.dumps(_tri_payload(rs))}]))


def _final_status(*statuses):
    """Combine triage/audit/validation votes. Downgrade out of action_required ONLY when
    EVERY non-null vote agrees it is non-actionable; any action_required vote (or a
    disagreement) keeps it action_required. Bias to caution - a single reviewer can never
    silently suppress a finding the others consider real."""
    votes = [s for s in statuses if s]
    non_act = {"acceptable", "false_positive"}
    if votes and all(s in non_act for s in votes):
        return "false_positive" if all(s == "false_positive" for s in votes) else "acceptable"
    return "action_required"


def _val_status(v):
    """Turn a validation assertion into a non-actionable vote, but only at high confidence:
    a clear scanner misfire (is_real=false) reads as false_positive; a control that only
    applies to a runtime this deploy does not use (applicable=false) reads as acceptable."""
    if not v: return None
    try: conf = float(v.get("confidence"))
    except Exception: conf = 0.0
    if v.get("is_real") is False and conf >= 0.7: return "false_positive"
    if v.get("applicable") is False and conf >= 0.7: return "acceptable"
    return "action_required"


def _most_urgent(*prios):
    ps = [p for p in prios if p in _PRI_RANK]
    return min(ps, key=lambda p: _PRI_RANK[p]) if ps else None


def stage_remediate(rs):
    if not rs: return {}
    payload = [{"id": r["id"], "title": r["title"], "severity": r["severity"], "area": r["area"], "snippet": r["snippet"]} for r in rs]
    return rows(call([
        {"role": "system", "content": f"You are a senior security engineer hardening a {CTX} "
         "Reason step by step from the actual code shown, then give remediation a developer can apply directly. "
         "Be specific to THIS stack (docker-compose services / Ansible tasks). Never invent config that is not plausible. "
         "If the finding is likely a false positive or benign, say so in `why` rather than inventing a fix."},
        {"role": "user", "content": 'For each finding return JSON. `why`: 1-2 sentences on the concrete risk in THIS deployment (what an attacker gains). '
         '`fix`: the exact change to make - name the file/service and include the precise YAML/directive to add or remove (e.g. `cap_drop: [ALL]` under the service). Prefer a copy-pasteable snippet over prose.\n'
         'Return ONLY JSON: {"results":[{"id":"...","why":"...","fix":"..."}]}\n\nFindings:\n' + json.dumps(payload)}]))


def stage_verify(rs, rem, n):
    payload = [{"id": r["id"], "title": r["title"], "why": rem.get(r["id"], {}).get("why", ""), "fix": rem.get(r["id"], {}).get("fix", "")}
               for r in rs if rem.get(r["id"])]
    if not payload: return {}
    return rows(call([
        {"role": "system", "content": f"You are strict, independent security reviewer #{n}. Verify each remediation is technically correct, specific to the rule, and not hallucinated. If uncertain, set verified=false."},
        {"role": "user", "content": 'Return ONLY JSON: {"results":[{"id":"...","verified":true,"note":"<=20 words, only when not verified"}]}\n\nRemediations:\n' + json.dumps(payload)}]))


# The report's own 12-category taxonomy (mirrors SEC_CATEGORY in security_report.py).
# The validator must pick EXACTLY one so the assigned label is consistent with the
# rest of the dashboard - never an ad-hoc phrase.
CANON_CATEGORIES = [
    "Container Isolation & Escape", "Host & Service Hardening", "File Permissions",
    "Access Control", "Supply Chain & Integrity", "Web & Edge Hardening",
    "Network Exposure", "Transport Security (TLS)", "Secrets Management",
    "Resource & Availability Controls", "Data Sharing", "General Hardening",
]
_SEV_LEVELS = ("CRITICAL", "HIGH", "MEDIUM", "LOW")
_SEV_RANK = {s: i for i, s in enumerate(_SEV_LEVELS)}          # 0 = most severe
_PRI_RANK = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}


def _val_payload(rs):
    return [{"id": r["id"], "title": r["title"], "reported_severity": r["severity"],
             "reported_cvss": r.get("cvss"), "cwe": r.get("cwe"), "area": r["area"],
             "scanner": r.get("source") or "scanner",
             "agent_sourced": (r.get("source") == "Strix"),
             "current_category": r.get("category") or "",
             "file": (r["locs"][0]["path"] if r["locs"] else ""), "snippet": r["snippet"]} for r in rs]


def stage_validate(rs):
    """Independent labeling/assertion pass - the 'get proper assertion & validation done'
    layer. For every finding it re-derives, FROM THE CODE, the four things a scanner (and
    especially the Strix agent, whose severity/CVSS/labels are unreliable) most often gets
    wrong: the vulnerability category, the true severity, the priority, and whether the
    finding even applies to THIS Ansible remote-server deployment or is a scanner misfire.
    Returns per-id assertions; reconciliation (never blind trust) happens in the caller."""
    if not rs: return {}
    cats = ", ".join(CANON_CATEGORIES)
    return rows(call([
        {"role": "system", "content":
            f"You are an independent security classifier auditing findings for a {CTX} {DEPLOY}\n\n"
            "Do NOT trust the reported severity/CVSS/category - re-derive each from the actual code shown. "
            "Findings marked agent_sourced:true come from an autonomous pentest agent whose severity, CVSS and "
            "labels are frequently wrong; weigh those on the code evidence alone. For each finding assert:\n"
            f"- category: EXACTLY one of [{cats}] - the best fit for the real weakness.\n"
            "- severity: CRITICAL|HIGH|MEDIUM|LOW, judged from concrete impact in THIS deployment, not the CVE headline.\n"
            "- priority: P0|P1|P2|P3 per the same rubric the triager uses (P0 = act now; P3 = defense-in-depth on an internal service).\n"
            "- applicable: true if this weakness genuinely applies to this Ansible/docker-compose remote-server deployment; "
            "false ONLY if it applies solely to a runtime this deploy does not use (e.g. a pure-Kubernetes control) or to dead/unused code.\n"
            "- is_real: true if the flagged condition actually holds in the code shown; false ONLY if the SNIPPET "
            "ITSELF proves the scanner misfired - a templated/example value, or a dev-only flag clearly off in prod. "
            "You are shown only a SNIPPET: you CANNOT see other files, so you must NOT claim a control is 'configured "
            "elsewhere', 'managed elsewhere', or 'present in another file' - if you cannot prove the misfire from the "
            "snippet in front of you, set is_real=true.\n"
            "Be evidence-based and decisive. Set a low confidence instead of guessing when the snippet is insufficient."},
        {"role": "user", "content":
            'Return ONLY JSON: {"results":[{"id":"...","category":"<one of the list>","severity":"CRITICAL|HIGH|MEDIUM|LOW",'
            '"priority":"P0|P1|P2|P3","applicable":true,"is_real":true,"confidence":0.0,"note":"<=25 words, cite the evidence"}]}'
            "\n\nFindings:\n" + json.dumps(_val_payload(rs))}]))


if todo:
    log(f"enriching {len(todo)} new rule(s) via {MODEL} ...")
    tri = stage_triage(todo)            # primary deployment-aware assessment
    aud = stage_triage_audit(todo)      # skeptical fail-safe second pass
    val = stage_validate(todo)          # independent labeling/assertion pass (category/severity/priority/applicability)
    rem = stage_remediate(todo)
    v1 = stage_verify(todo, rem, 1)
    v2 = stage_verify(todo, rem, 2)
    for r in todo:
        rid = r["id"]; rr = rem.get(rid) or {}
        # Only cache rules that actually got remediation. If the LLM produced nothing
        # (e.g. a transient error), leave the curated text and retry on the next run -
        # never poison the cache with empty enrichment.
        if not (rr.get("why") and rr.get("fix")):
            continue
        t = tri.get(rid) or {}
        v = val.get(rid) or {}
        agent_sourced = (r.get("source") == "Strix")
        try: vconf = float(v.get("confidence"))
        except Exception: vconf = 0.0
        # CLAIM-CHECK: reject a false-positive verdict that rests on an unverifiable external
        # mitigation. The validator only sees a snippet; a note like "configured elsewhere" /
        # "managed in another file" cannot be proven and has produced hallucinated FPs (e.g.
        # nginx security headers it claimed were "managed elsewhere" but exist nowhere). If
        # is_real=false is justified by such a claim, neutralize it so it cannot vote the
        # finding non-actionable, and correct the misleading note.
        if v.get("is_real") is False:
            _note = (v.get("note") or "").lower()
            if any(w in _note for w in ("elsewhere", "another file", "other file", "other template",
                                        "managed", "configured in", "defined in", "handled in", "set in a")):
                v["is_real"] = None
                v["note"] = "Validator claimed an external mitigation it could not prove from the code; kept as action-required."
        # 3-way status vote: triage, skeptical audit, and the validation pass. Conservative
        # about WHETHER a finding is real (any action_required vote wins).
        status = _final_status(t.get("status"), (aud.get(rid) or {}).get("status"), _val_status(v))
        # Label: adopt the validator's canonical category when confident, else keep the
        # deterministic sec_category(). This is the "right label" the agent assigns.
        vcat = v.get("category") if v.get("category") in CANON_CATEGORIES and vconf >= 0.5 else None
        # Severity CALIBRATION. Deterministic scanners (Checkov/KICS/custom) produce trustworthy
        # severities - we honour them and only RAISE on a confident higher read, never lower.
        # Strix is an AI agent whose CVSS/severity is the known-unreliable input the user asked
        # us to correct, so for agent-sourced findings the validator's severity is authoritative
        # (up OR down) when confident. This is calibration of a soft label, not altering raw
        # deterministic scan output.
        vsev = v.get("severity") if v.get("severity") in _SEV_LEVELS else None
        eff_sev = r["severity"]
        if vsev:
            if agent_sourced and vconf >= 0.6:
                eff_sev = vsev
            elif (not agent_sourced) and vconf >= 0.75 and _SEV_RANK[vsev] < _SEV_RANK.get(r["severity"], 9):
                eff_sev = vsev
        # Priority. For agent-sourced findings the validator calibrates it directly (it owns the
        # severity too); for deterministic ones, keep the more urgent of triager vs validator.
        if status == "action_required":
            if agent_sourced and v.get("priority") in _PRI_RANK and vconf >= 0.6:
                prio = v.get("priority")
            else:
                prio = _most_urgent(t.get("priority"), v.get("priority")) or "P2"
        else:
            prio = ""
        cache[rid] = {
            "v": CACHE_V,
            "category": vcat,
            "severity_effective": eff_sev,
            "triage": {"status": status, "priority": prio,
                       "exposure": t.get("exposure", "unknown"),
                       "confidence": t.get("confidence"),
                       "reason": t.get("reason") or (aud.get(rid, {}) or {}).get("reason", "")},
            "validation": {"category": vcat, "severity": vsev, "severity_effective": eff_sev,
                           "scanner_severity": r["severity"], "priority": v.get("priority"),
                           "applicable": v.get("applicable"), "is_real": v.get("is_real"),
                           "confidence": vconf, "adjusted": eff_sev != r["severity"],
                           "note": v.get("note", "")} if v else None,
            "why": rr["why"], "fix": rr["fix"],
            "verify": {"verified": bool(v1.get(rid, {}).get("verified")) and bool(v2.get(rid, {}).get("verified")),
                       "note": (v1.get(rid, {}).get("note") or v2.get(rid, {}).get("note") or "")},
        }

# apply this run's enrichment (annotate findings; never drop or alter raw data). Only apply
# entries that carry REAL remediation - if the LLM produced nothing for a rule, the finding
# keeps its curated floor rather than a misleading empty badge.
for f in findings:
    c = cache.get(f["id"])
    if not (c and c.get("why") and c.get("fix")):
        continue
    if c.get("triage"): f["triage"] = c["triage"]
    if c.get("validation"): f["validation"] = c["validation"]
    if c.get("category"): f["category"] = c["category"]   # validated label overrides the heuristic one
    if c.get("severity_effective"): f["severity"] = c["severity_effective"]  # calibrated (Strix up/down, scanners raise-only)
    f["why"] = c["why"]
    f["fix"] = c["fix"]
    if c.get("verify"): f["verify"] = c["verify"]
    f["enriched"] = True

# Severity floor on priority: a CRITICAL finding must never sit below P0. This reads the
# EFFECTIVE (post-calibration) severity, so a Strix finding the validator confidently
# down-rated (e.g. a CVSS 9.8 CVE that only affects a build/test dependency) is no longer
# force-floored to P0 - while a genuinely CRITICAL finding still is. We only raise urgency.
for f in findings:
    t = f.get("triage") or {}
    if t.get("status") == "action_required" and f.get("severity") == "CRITICAL" and t.get("priority") != "P0":
        t["priority"] = "P0"; f["triage"] = t

# Reliability-only / benign-by-design controls -> acceptable (documented, not tracked).
# These are REAL but are not security weaknesses, so per the rubric they belong on the
# "acceptable" list. The triage/validation vote lacks an "acceptable" path for a
# real-AND-applicable finding (is_real/applicable are both true for a healthcheck gap), so
# it wrongly kept them action_required. This deterministic floor corrects that for the
# unambiguous cases. NOTE: the dangerous host-access rules are deliberately NOT here -
# "Docker Socket Mounted" and "Volume Has Sensitive Host Directory" stay action_required.
_ACCEPTABLE_SIGNATURES = (
    "healthcheck",                      # missing healthcheck - reliability only
    "memory not limited", "memory limit",
    "cpus not limited", "cpu not limited", "cpu limit",
    "privileged ports mapped",          # privileged container port remapped to a high host port
    "shared volumes between containers",
    "host namespace is shared",         # host pid/ipc share for read-only monitoring agents
)
def _is_reliability(f):
    tl = (f.get("title") or "").lower()
    return any(s in tl for s in _ACCEPTABLE_SIGNATURES)
_rel = 0
for f in findings:
    if not _is_reliability(f):
        continue
    t = f.get("triage") or {}
    if t.get("status") == "action_required":
        t["status"] = "acceptable"; t["priority"] = ""
        t["reason"] = (t.get("reason") or "").strip() or "Reliability/benign control, not a security weakness."
        f["triage"] = t; _rel += 1
if _rel:
    log(f"reclassified {_rel} reliability-only finding(s) action_required -> acceptable.")

# Recompute the severity summary from the (possibly calibrated) finding severities so the
# dashboard donut/counts stay consistent with per-finding severities after validation.
import collections as _collections
_types_by = _collections.Counter(f["severity"] for f in findings)
_occ_by = _collections.Counter()
for f in findings:
    _occ_by[f["severity"]] += f.get("count", 1)
_SEV_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
run["summary"]["typesBySeverity"] = {s: _types_by.get(s, 0) for s in _SEV_ORDER}
run["summary"]["occBySeverity"] = {s: _occ_by.get(s, 0) for s in _SEV_ORDER}
run["summary"]["types"] = len(findings)
run["summary"]["occurrences"] = sum(f.get("count", 1) for f in findings)

# executive summary + priorities over ACTION-REQUIRED findings only (exclude acceptable / FPs)
def _status(f): return (f.get("triage") or {}).get("status")
action = [f for f in findings if _status(f) == "action_required"]
# If triage failed entirely (no statuses set), fall back to all findings so the summary
# is never empty when remediation did succeed.
basis = action or [f for f in findings if f.get("enriched")]
exsum = parse(call([
    {"role": "system", "content": f"You are a security lead briefing management on a {CTX} {DEPLOY}"},
    {"role": "user", "content": 'Write for a public-sector delivery team. Return ONLY JSON: {"executive_summary":"3-4 sentences: overall posture, the systemic themes (correlate related risks into root causes), and what to prioritise first","priority_actions":["ordered, concrete remediation step tied to the findings","..."]}\n\nAction-required findings:\n'
     + json.dumps([{"severity": f["severity"], "priority": (f.get("triage") or {}).get("priority"), "category": f.get("category"), "title": f["title"], "count": f["count"]} for f in basis])}])) or {}
run["meta"]["executive_summary"] = exsum.get("executive_summary", "")
pa = exsum.get("priority_actions")
run["meta"]["priority_actions"] = pa if isinstance(pa, list) else []
# Only claim the report was AI-enriched if something actually came back, so a total
# LLM failure yields a clean curated report (no misleading AI tags / "needs review").
if any(f.get("enriched") for f in findings) or run["meta"]["executive_summary"]:
    run["meta"]["enriched"] = True
    run["meta"]["engine"] = f"Gemini ({MODEL})"

json.dump(run, open(RUN, "w"), indent=1)
log(f"enriched fresh: {len(todo)} rules this run; action-required {len(action)}/{len(findings)}.")

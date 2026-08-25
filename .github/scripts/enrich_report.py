#!/usr/bin/env python3
"""
Agentic enrichment of run.json via a free OpenAI-compatible LLM (default: Google Gemini).

Pipeline (batched, ~5 calls/run):
  0. context   - read the real code around each finding (deterministic, no LLM)
  1. triage    - confirmed / likely_false_positive / needs_review + confidence + reason
  2. remediate - context-aware why / how-to-fix, grounded in the actual code
  3. verify    - DUAL-PASS critic: a fix is "verified" only if BOTH independent
                 reviewers approve; otherwise "needs review"
  4. summary   - executive summary + prioritized action list

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
                                   "area": f["area"], "count": 0, "locs": []})
    r["count"] += f["count"]
    if not r["locs"] and f.get("locations"):
        r["locs"] = f["locations"][:2]
for r in rules.values():
    r["snippet"] = "\n---\n".join(snippet(l["path"], l.get("line"), ctx=10) for l in r["locs"]) or "(no code context)"

cache = {}
if os.path.exists(CACHE):
    try: cache = json.load(open(CACHE))
    except Exception: cache = {}
elif REPO:
    try:
        cache = json.loads(urllib.request.urlopen(
            f"https://raw.githubusercontent.com/{REPO}/gh-pages/{CACHE}", timeout=10).read())
    except Exception as e:
        log("no remote cache:", e)

# Cache schema version. BUMP THIS whenever the enrichment schema or prompts change
# (e.g. the triage taxonomy or rubric) so stale entries from older runs are re-enriched
# instead of silently reused.
#   v2 = action_required/acceptable/false_positive triage taxonomy
#   v3 = stricter rubric: internal/behind-gateway lowers priority, does not dismiss
#        standard hardening controls (cap_drop, no-new-privileges, TLS validation)
#   v4 = deployment context corrected to verified live reality (no host firewall;
#        datastores published on 0.0.0.0 -> security group is the sole control)
#   v5 = 4-level priority scale P0..P3 (P0 = critical/act-now)
CACHE_V = 5


def _cache_ok(c):
    """A cache entry is reusable only if it is the current schema version AND carries
    real remediation. Missing/old-version/empty entries are re-enriched (self-healing)."""
    return bool(c and c.get("v") == CACHE_V and c.get("why") and c.get("fix"))


todo = [r for r in rules.values() if not _cache_ok(cache.get(r["id"]))]
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


def _final_status(a, b):
    """Combine the two triage passes. Downgrade out of action_required ONLY when both
    passes agree it is non-actionable; any action_required vote (or disagreement) wins."""
    sa = (a or {}).get("status"); sb = (b or {}).get("status")
    non_act = {"acceptable", "false_positive"}
    if sa in non_act and sb in non_act:
        return "false_positive" if sa == sb == "false_positive" else "acceptable"
    return "action_required"


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


if todo:
    log(f"enriching {len(todo)} new rule(s) via {MODEL} ...")
    tri = stage_triage(todo)            # primary deployment-aware assessment
    aud = stage_triage_audit(todo)      # skeptical fail-safe second pass
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
        status = _final_status(t, aud.get(rid))
        prio = (t.get("priority") or "P2") if status == "action_required" else ""
        cache[rid] = {
            "v": CACHE_V,
            "triage": {"status": status, "priority": prio,
                       "exposure": t.get("exposure", "unknown"),
                       "confidence": t.get("confidence"),
                       "reason": t.get("reason") or (aud.get(rid, {}) or {}).get("reason", "")},
            "why": rr["why"], "fix": rr["fix"],
            "verify": {"verified": bool(v1.get(rid, {}).get("verified")) and bool(v2.get(rid, {}).get("verified")),
                       "note": (v1.get(rid, {}).get("note") or v2.get(rid, {}).get("note") or "")},
        }

# apply cache (annotate findings; never drop or alter raw data). Only apply current-schema
# entries that carry REAL remediation - a stale/empty entry must not stamp misleading or
# outdated triage/verify badges; those findings fall back to the curated floor instead.
for f in findings:
    c = cache.get(f["id"])
    if not _cache_ok(c):
        continue
    if c.get("triage"): f["triage"] = c["triage"]
    f["why"] = c["why"]
    f["fix"] = c["fix"]
    if c.get("verify"): f["verify"] = c["verify"]
    f["enriched"] = True

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
json.dump(cache, open(CACHE, "w"), indent=1)
log(f"enriched: {len(todo)} new rules; cache {len(cache)}; action-required {len(action)}/{len(findings)}.")

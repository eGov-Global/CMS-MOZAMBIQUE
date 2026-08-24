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
import os, sys, json, time, urllib.request, urllib.error

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
    # Ranked by REASONING capability + free-tier reliability. 2.5 models are
    # "thinking" models (step-by-step reasoning, not guesswork); 2.5-flash leads
    # because it pairs that reasoning with generous free limits, 2.5-pro is the
    # strongest but has tighter free quota, older flash/pro are fallbacks.
    for pref in ("gemini-2.5-flash", "gemini-2.5-pro", "gemini-flash-latest",
                 "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"):
        m = find(pref)
        if m:
            return m
    # any 2.5 model, then any flash, then anything
    for i in ids:
        if "2.5" in i:
            return i
    for i in ids:
        if "flash" in i.lower():
            return i
    return ids[0] if ids else (want or "gemini-2.5-flash")


MODEL = discover_model()
# The /models list returns ids like "models/gemini-2.5-flash", but the OpenAI-compat
# chat endpoint wants the BARE id ("gemini-2.5-flash"). Keeping the prefix makes every
# chat call 404 while /models still succeeds - which looks like "enabled but empty".
if MODEL and MODEL.startswith("models/"):
    MODEL = MODEL[len("models/"):]
log(f"using model: {MODEL}")


def call(messages, temperature=0.2, max_tokens=4096):
    """One OpenAI-compatible chat call. Returns text or None. Retries transient errors;
    drops response_format if the provider rejects it."""
    def _post(use_json):
        body = {"model": MODEL, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if use_json:
            body["response_format"] = {"type": "json_object"}
        req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read())["choices"][0]["message"]["content"]
    for attempt in range(3):
        try:
            return _post(use_json=(attempt == 0))
        except urllib.error.HTTPError as e:
            body = ""
            try: body = e.read().decode("utf-8", "ignore")[:200]
            except Exception: pass
            if e.code == 400 and attempt == 0:
                continue  # retry without response_format
            if e.code in (408, 429, 500, 502, 503) and attempt < 2:
                time.sleep(3 * (attempt + 1)); continue
            log(f"LLM HTTP {e.code}: {body}"); return None
        except Exception as e:
            if attempt < 2:
                time.sleep(2); continue
            log(f"LLM error: {e}"); return None
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
    r["snippet"] = "\n---\n".join(snippet(l["path"], l.get("line")) for l in r["locs"]) or "(no code context)"

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

# Re-enrich anything not cached OR cached without real remediation (self-heals a
# cache poisoned by an earlier failed run).
todo = [r for r in rules.values() if not (cache.get(r["id"]) or {}).get("why")]
CTX = "Ansible remote-server deployment (setup path C: ./deploy.sh) plus its docker-compose stack for DIGIT/CMS, a public-sector complaint-management platform. The repository is PUBLIC."


# ---- stages ----------------------------------------------------------------
def stage_triage(rs):
    if not rs: return {}
    payload = [{"id": r["id"], "title": r["title"], "severity": r["severity"], "area": r["area"], "snippet": r["snippet"]} for r in rs]
    return rows(call([
        {"role": "system", "content": f"You are a security triage engineer for a {CTX} Decide, from the code snippet, whether each finding is a real security issue or a likely false positive (templating, example/placeholder files, intentional benign config)."},
        {"role": "user", "content": 'Return ONLY JSON: {"results":[{"id":"...","verdict":"confirmed|likely_false_positive|needs_review","confidence":0.0,"reason":"<=20 words"}]}\n\nFindings:\n' + json.dumps(payload)}]))


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
    tri = stage_triage(todo)
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
        cache[rid] = {
            "triage": {"verdict": t.get("verdict", "needs_review"), "confidence": t.get("confidence"), "reason": t.get("reason", "")},
            "why": rr["why"], "fix": rr["fix"],
            "verify": {"verified": bool(v1.get(rid, {}).get("verified")) and bool(v2.get(rid, {}).get("verified")),
                       "note": (v1.get(rid, {}).get("note") or v2.get(rid, {}).get("note") or "")},
        }

# apply cache (annotate findings; never drop or alter raw data). Only apply entries
# that carry REAL remediation - a cache entry without why/fix is a failed/poisoned
# run and must not stamp misleading "needs review" triage/verify badges.
for f in findings:
    c = cache.get(f["id"])
    if not c or not (c.get("why") and c.get("fix")):
        continue
    if c.get("triage"): f["triage"] = c["triage"]
    f["why"] = c["why"]
    f["fix"] = c["fix"]
    if c.get("verify"): f["verify"] = c["verify"]
    f["enriched"] = True

# executive summary + priorities over CONFIRMED findings (exclude likely-FPs)
confirmed = [f for f in findings if (f.get("triage") or {}).get("verdict") != "likely_false_positive"]
exsum = parse(call([
    {"role": "system", "content": f"You are a security lead briefing management on a {CTX}"},
    {"role": "user", "content": 'Return ONLY JSON: {"executive_summary":"3-4 sentences: overall posture, systemic themes (correlate related risks), what to prioritise","priority_actions":["ordered concrete step", "..."]}\n\nConfirmed findings:\n'
     + json.dumps([{"severity": f["severity"], "title": f["title"], "count": f["count"], "area": f["area"]} for f in confirmed])}])) or {}
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
log(f"enriched: {len(todo)} new rules; cache {len(cache)}; confirmed {len(confirmed)}/{len(findings)}.")

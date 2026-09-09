---
name: audit
description: Use when the operator types "/audit", or says "audit the recent changes", "review what I just changed", "check my edits", or similar. Performs static and semantic analysis of the most recent changes — no tests, no builds, no running the app — and reports improvements and drawbacks as bullet points of at most 50 words each, ordered by severity.
---

# Audit recent changes

Static and semantic review of whatever changed most recently. Reads the diff, then
reads far enough around it to judge whether the change is *correct*, not merely
well-formed. Produces two short bullet lists — what got better, what got worse —
sized so the whole report is readable in under a minute.

This is a reading exercise. It does not run the test suite, start the app, or
build anything.

## IRON LAW

```
NEVER REPORT A DEFECT YOU HAVE NOT TRACED IN THE SOURCE.
NO CLAIM FROM MEMORY. NO CLAIM FROM THE DIFF ALONE.
```

A diff shows what changed, never what it means. Every finding must be backed by
having opened the definition of the thing being called, the caller of the thing
being changed, or both. If you cannot trace it, do not report it.

## Scope

Resolve the target in this order, stopping at the first that yields changes:

1. An explicit argument — `/audit src/foo.js`, `/audit HEAD~3`, `/audit <branch>`.
2. Uncommitted work: `git status --short`, then `git diff` plus untracked files.
   Untracked files matter and are easy to miss; read them in full.
3. The most recent commit: `git show --stat HEAD`.

State which scope you resolved to in one line before the findings, so the reader
knows what was and was not examined.

## Method

Read the diff first, then abandon it. A diff is a starting index, not the unit of
analysis. For each changed symbol, open the file it lives in and read the whole
surrounding function or class — a change is frequently wrong because of code that
did not change.

Then follow the edges outward, which is where the real defects are:

- **Callers.** Who invokes the changed function, and does the new contract still
  suit them? A changed return type, an added throw, a removed null check.
- **Callees.** What does the changed code now call, and what does that thing
  actually do? Never assume a function named `parse`, `get` or `format` is pure —
  open it and look for network calls, writes and uploads.
- **Deletions.** Anything the diff removed existed for a reason. Find out what it
  guarded against before accepting its removal.

## Static checks

Mechanical defects, each cheap to confirm by reading:

- Syntax and parse validity — `node --check <file>` is permitted; it executes
  nothing.
- **A method referenced without calling it.** `if (!this.hasThing)` on a method is
  always falsy-negated and the branch is dead. A classic and near-invisible bug.
- Unused variables, unused imports, dead parameters, orphaned helpers.
- Assignments whose value is never read; variables holding the result of a
  function that returns nothing.
- Missing `await` on a promise; a promise with no rejection handling.
- Removed null or type guards; loosened validation.
- Logic duplicated from somewhere else in the tree — two sources of truth for the
  same decision.
- Hardcoded values where configuration already exists for exactly that value.

## Semantic checks

Ask what the running system now does differently:

- **Is anything called twice that was called once?** Then ask whether that thing
  has side effects. Two calls to a pure function waste cycles; two calls to
  something that uploads a file leave an orphan.
- Does an error path still exist for every failure the code can produce?
- Does the change alter persisted data, its shape, or its keys? If state is
  serialised anywhere, a rename is a migration.
- Does it change what happens on retry, resume, or restart?
- Does module-load order or eager importing now do work that used to be lazy?
- Is behaviour preserved for the inputs nobody thinks about — empty string, wrong
  media type, a payload that is not a user message?

## Two rules that prevent bad reports

**Look for masked pairs.** Two defects sometimes cancel out, so the code works by
accident. When you find one, check whether repairing it alone makes things worse,
and say so explicitly — an "obvious fix" that breaks an endpoint is the worst
possible outcome of an audit.

**Separate live from latent.** A defect reachable by a real request today is not
the same as one waiting on a config change or a feature flag. Label it. Ranking a
theoretical issue above a live one wastes the reader's attention.

## Output

Exactly two sections, in this order. Improvements first — the change was made for
a reason and the reader deserves to see it acknowledged before the problems.

```
Scope: <what was audited, one line>

**Improvements**
- <bullet, ≤50 words>

**Drawbacks**
- <bullet, ≤50 words>
```

Bullet rules:

- **At most 50 words each.** Count them. Two tight sentences, not three loose
  ones. If a finding will not fit, it is two findings.
- Lead with the claim, not the preamble. "The null guard is gone, so `fromUser`
  is called with null for status callbacks" — not "I noticed that it appears…".
- Cite `file.js:line` as a markdown link for anything a reader would want to open.
- Order each list by severity: data loss, then wrong behaviour, then latent risk,
  then maintainability.
- Name the concrete consequence. "Two filestore uploads per attachment, first
  orphaned" beats "possible inefficiency".
- Say "no drawbacks found" rather than manufacturing one, and the same for
  improvements. An empty section is a real result.

## Do not report

- Formatting, blank lines, import order, quote style. If a file's only change is
  whitespace, note that in one bullet and move on.
- Preferences dressed as defects. "I would have used a map here" is not a
  finding.
- Anything you could not trace. Uncertainty is not a finding either; if it
  matters and you cannot resolve it, ask a question instead of filing a bullet.

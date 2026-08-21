#!/usr/bin/env bash
# Publish the current run's report to the gh-pages branch, keeping all previous
# reports so they can be switched/viewed on the public dashboard.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?}"
RUN_ID="${GITHUB_RUN_ID:?}"
TOKEN="${GH_TOKEN:?}"
URL="https://x-access-token:${TOKEN}@github.com/${REPO}.git"

work="$(mktemp -d)"
if git clone --depth 1 --branch gh-pages "$URL" "$work" 2>/dev/null; then
  echo "gh-pages exists"
else
  echo "creating gh-pages"
  git clone --depth 1 "$URL" "$work"
  ( cd "$work" && git checkout --orphan gh-pages && git rm -rf . >/dev/null 2>&1 || true )
fi

mkdir -p "$work/data"
cp run.json "$work/data/${RUN_ID}.json"
cp .github/security-dashboard/index.html "$work/index.html"
# carry the LLM enrichment cache forward if this run produced/updated one
[ -f enrich-cache.json ] && cp enrich-cache.json "$work/enrich-cache.json" || true
# GitHub Pages Jekyll would ignore files/dirs it doesn't like; disable it.
touch "$work/.nojekyll"
python3 .github/scripts/build_manifest.py "$work/data" > "$work/manifest.json"

cd "$work"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then
  echo "no changes to publish"; exit 0
fi
git commit -m "security dashboard: run ${RUN_ID}"
git push origin gh-pages
echo "published run ${RUN_ID} to gh-pages"

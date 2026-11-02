#!/bin/bash
# Assemble dist/ and ship it.
#
# This exists because the deploy was a cp list typed by hand out of the
# runbook, and a cp list has two failure modes that both ship quietly.
#
# A file that changed but did not get copied: dist/ is gitignored, so nothing
# in git status says it is stale, and wrangler cheerfully uploads whatever is
# sitting there. This has already happened once -- app.js was 584 lines ahead
# of dist/app.js and the deploy would have published neither an error nor the
# change.
#
# A file that is new: add something to index.html, forget to add it to the
# list, and the page references a URL that 404s. The reference check at the
# bottom is for that one.
#
# The tests run FIRST and a failure stops the deploy. Written after a red
# suite and a deploy went out in the same breath, because the two commands
# were next to each other and nothing made the second wait for the first.
set -euo pipefail
cd "$(dirname "$0")"

FORCE=0; API=0; DRY=0
for a in "$@"; do
    case "$a" in
        api)     API=1 ;;
        --force) FORCE=1 ;;
        # Assemble and check, then stop. What you want before handing the
        # deploy to somebody else, and what CI would run if this ever gets one.
        --dry)   DRY=1 ;;
        *) echo "usage: ./deploy.sh [api] [--force] [--dry]"; exit 2 ;;
    esac
done

# ---------------------------------------------------------------- the gate
if [ $FORCE -eq 1 ]; then
    echo "!! --force: shipping WITHOUT running the tests."
    echo "!! Only right when you are rolling back a live break."
    echo
else
    echo "== tests =="
    ./run-tests.sh || { echo; echo "Suite is red. Not deploying."; exit 1; }
    echo
fi

# ------------------------------------------------------------- assemble
# Every file the app serves. Keep this list and index.html in step; the
# reference check below is what tells you when they have drifted apart.
FILES=(index.html app.js airports.js airports-extra.js optimizer.js
       flights.json manifest.json favicon.svg robots.txt)

echo "== assembling dist/ =="
mkdir -p dist
for f in "${FILES[@]}"; do
    [ -f "$f" ] || { echo "  MISSING in repo: $f"; exit 1; }
    cp "$f" dist/
done
cp ./*.png dist/ 2>/dev/null || true

# Removed first because the copy does not prune: an image deleted from
# splash/ would otherwise go on being served forever.
rm -rf dist/splash
cp -r splash dist/

# Did the copy actually land? Cheap, and it is the exact failure this script
# was written for, so it is worth asserting rather than assuming.
for f in "${FILES[@]}"; do
    cmp -s "$f" "dist/$f" || { echo "  copy did not take: $f"; exit 1; }
done
echo "  ${#FILES[@]} files + images + splash/"

# Anything index.html asks for that is not there. Local paths only -- a
# missing CDN URL is not something this can know about.
echo "== checking references =="
missing=0
while read -r ref; do
    [ -z "$ref" ] && continue
    case "$ref" in http*|//*|data:*|\#*|mailto:*) continue ;; esac
    ref="${ref%%\?*}"; ref="${ref%%\#*}"; ref="${ref#./}"; ref="${ref#/}"
    [ -z "$ref" ] && continue
    [ -e "dist/$ref" ] || { echo "  index.html references dist/$ref, which is not there"; missing=1; }
done < <(grep -oE '(src|href)="[^"]+"' index.html | sed -E 's/^(src|href)="//; s/"$//' | sort -u)
[ $missing -eq 0 ] && echo "  all local references resolve" || { echo; echo "Refusing to ship a page with dead references."; exit 1; }

# ---------------------------------------------------------------- ship
if [ $DRY -eq 1 ]; then
    echo
    echo "--dry: dist/ is assembled and checked. Nothing was deployed."
    exit 0
fi

echo
echo "== deploying the app =="
npx wrangler deploy -c wrangler.site.toml

if [ $API -eq 1 ]; then
    echo
    echo "== deploying the API =="
    (cd worker && npx wrangler deploy -c ./wrangler.toml)
fi

echo
echo "== live =="
for u in https://fly.altorien.com https://fly-with-friends.altorien.workers.dev; do
    printf '  %-48s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$u")"
done

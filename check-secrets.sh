#!/bin/bash
# Scan for credentials before publishing. Exits non-zero on a hit.
#
# This replaces a one-line grep that was documented here for months and was
# quietly broken the whole time: it used "\s" inside git grep -E, and POSIX ERE
# has no \s escape, so it degraded to a literal "s" and "\s*" meant "zero or
# more letter s". It therefore only matched KEY='...' with no spaces around the
# equals sign, and reported clean on a file holding a live key. A check that
# cannot fail is worse than no check, because it is believed.
#
# Scans the working tree and the full history of every ref, because a key
# deleted today is still served by GitHub from yesterday's commit.
set -uo pipefail
cd "$(dirname "$0")"

PATTERN="(api[_-]?key|apikey|secret|token|bearer|password|passwd)[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_\\-]{12,}"
found=0

echo "== working tree =="
if git grep -nIiE "$PATTERN" -- . ':(exclude)check-secrets.sh'; then found=1; else echo "   clean"; fi

echo "== history, all refs =="
# Walk blobs rather than diffs: a key added and removed shows up in both the
# add and the remove diff, but the blob is the thing GitHub still serves.
hits=$(git rev-list --all --objects 2>/dev/null \
  | awk '{print $1}' \
  | git cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null \
  | awk '$2=="blob" {print $1}' \
  | while read -r sha; do
      if git cat-file blob "$sha" 2>/dev/null | grep -qIiE "$PATTERN"; then echo "$sha"; fi
    done)
if [ -n "$hits" ]; then
  found=1
  echo "$hits" | while read -r sha; do
    echo "   blob $sha  (git cat-file blob $sha | grep -niE 'key|secret|token')"
  done
else
  echo "   clean"
fi

if [ "$found" -ne 0 ]; then
  echo
  echo "FAILED — a credential-shaped string is present. Rotate it; deleting the"
  echo "line is not enough once it has been pushed to a public repo."
  exit 1
fi
echo
echo "PASSED"

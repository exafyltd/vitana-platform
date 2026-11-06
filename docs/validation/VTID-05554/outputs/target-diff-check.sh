#!/bin/bash
# VTID-05554 (agentic-delivery/reseat): byte check of the eight target lane files.
# For each target: the base copy must hold exactly one line `seat: exafyltd`; the head copy must equal the base copy
# with only that line changed to `seat: exafy` (sha256 of the expected bytes == sha256 of the head bytes), and
# `git diff --numstat` must be `1 1`. Usage (from the worktree root): target-diff-check.sh <base> [<rev>|WT]
set -u
BASE=${1:?base revision}
REV=${2:-HEAD}
D=.kiro/specs/agentic-delivery/lanes
TMP=$(mktemp -d)
pass=0; fail=0
echo "base $(git rev-parse "$BASE")  head ${REV}$( [ "$REV" = WT ] || echo " $(git rev-parse "$REV")")"
for l in prerequisites pipelines deploy-path verify-on-gitlab merge-queue github-bridge gateway-delivery cutover; do
  f=$D/$l.md
  git show "$BASE:$f" > "$TMP/base"
  if [ "$REV" = WT ]; then cat "$f" > "$TMP/head"; else git show "$REV:$f" > "$TMP/head"; fi
  n=$(grep -c '^seat: exafyltd$' "$TMP/base")
  sed 's/^seat: exafyltd$/seat: exafy/' "$TMP/base" > "$TMP/expected"
  eh=$(sha256sum < "$TMP/expected" | cut -c1-16); hh=$(sha256sum < "$TMP/head" | cut -c1-16)
  if [ "$REV" = WT ]; then ns=$(git diff --numstat "$BASE" -- "$f" | cut -f1,2 | tr '\t' ' '); else ns=$(git diff --numstat "$BASE" "$REV" -- "$f" | cut -f1,2 | tr '\t' ' '); fi
  minus=$(diff "$TMP/base" "$TMP/head" | grep '^<' | tr '\n' ' '); plus=$(diff "$TMP/base" "$TMP/head" | grep '^>' | tr '\n' ' ')
  if [ "$n" = 1 ] && [ "$eh" = "$hh" ] && [ "$ns" = "1 1" ]; then r=PASS; pass=$((pass+1)); else r=FAIL; fail=$((fail+1)); fi
  echo "$r $f: base seat lines=$n numstat=\"$ns\" expected=$eh head=$hh removed=[${minus% }] added=[${plus% }]"
done
rm -rf "$TMP"
echo "targets: $pass pass, $fail fail"
[ "$fail" = 0 ]

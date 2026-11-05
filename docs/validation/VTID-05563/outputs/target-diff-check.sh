#!/bin/bash
# VTID-05563 (agentic-delivery/nav-paths): byte check of the one target lane file, lanes/gateway-delivery.md.
# The head copy must equal the base copy with exactly the four expected `paths` lines inserted before the last entry
# `  - docs/validation/**` (sha256 of the expected bytes == sha256 of the head bytes), `git diff --numstat` must be
# `4 0`, and the parsed front matter must be equal on every key except `paths`, where head = base + the four entries.
# Usage (from the worktree root): target-diff-check.sh <base> [<rev>|WT]
set -u
BASE=${1:?base revision}
REV=${2:-HEAD}
F=.kiro/specs/agentic-delivery/lanes/gateway-delivery.md
TMP=$(mktemp -d)
echo "base $(git rev-parse "$BASE")  head ${REV}$( [ "$REV" = WT ] || echo " $(git rev-parse "$REV")")"
git show "$BASE:$F" > "$TMP/base"
if [ "$REV" = WT ]; then cat "$F" > "$TMP/head"; else git show "$REV:$F" > "$TMP/head"; fi
cat > "$TMP/four" <<'EOF'
  - services/gateway/src/navigation/data/command-hub-screens.json
  - services/gateway/src/navigation/data/nav-embeddings.bin
  - services/gateway/src/navigation/data/nav-embeddings.json
  - scripts/ci/command-hub-ownership-guard.js
EOF
n=$(grep -c '^  - docs/validation/\*\*$' "$TMP/base")
awk -v four="$TMP/four" '/^  - docs\/validation\/\*\*$/ { while ((getline l < four) > 0) print l } { print }' "$TMP/base" > "$TMP/expected"
eh=$(sha256sum < "$TMP/expected" | cut -c1-16); hh=$(sha256sum < "$TMP/head" | cut -c1-16)
if [ "$REV" = WT ]; then ns=$(git diff --numstat "$BASE" -- "$F" | cut -f1,2 | tr '\t' ' '); else ns=$(git diff --numstat "$BASE" "$REV" -- "$F" | cut -f1,2 | tr '\t' ' '); fi
removed=$(diff "$TMP/base" "$TMP/head" | grep -c '^<'); added=$(diff "$TMP/base" "$TMP/head" | grep '^>' | sed 's/^> *//' | tr '\n' ' ')
echo "diff hunks: $(diff "$TMP/base" "$TMP/head" | grep -E '^[0-9]' | tr '\n' ' ')"
fm=$(node --input-type=module - "$TMP/base" "$TMP/head" "$PWD/scripts/collab/queue.mjs" <<'JS'
import { readFileSync } from 'node:fs';
const [b, h, q] = process.argv.slice(2);
const { parseFrontMatter } = await import(q);
const fb = parseFrontMatter(readFileSync(b, 'utf8')); const fh = parseFrontMatter(readFileSync(h, 'utf8'));
const list = (v) => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]);
const keys = [...new Set([...Object.keys(fb), ...Object.keys(fh)])];
const other = keys.filter((k) => k !== 'paths' && JSON.stringify(fb[k]) !== JSON.stringify(fh[k]));
const pb = list(fb.paths); const ph = list(fh.paths);
const gone = pb.filter((p) => !ph.includes(p)); const extra = ph.filter((p) => !pb.includes(p));
const ok = other.length === 0 && gone.length === 0 && extra.length === 4;
console.log(`${ok ? 'ok' : 'BAD'} front matter: keys=${keys.length}, other keys changed=[${other.join(', ')}], paths base=${pb.length} head=${ph.length}, removed=[${gone.join(', ')}], added=[${extra.join(', ')}]`);
JS
)
echo "$fm"
if [ "$n" = 1 ] && [ "$eh" = "$hh" ] && [ "$ns" = "4 0" ] && [ "$removed" = 0 ] && [ "${fm#ok }" != "$fm" ]; then r=PASS; else r=FAIL; fi
echo "$r $F: base docs/validation lines=$n numstat=\"$ns\" expected=$eh head=$hh removed lines=$removed added=[${added% }]"
rm -rf "$TMP"
[ "$r" = PASS ]

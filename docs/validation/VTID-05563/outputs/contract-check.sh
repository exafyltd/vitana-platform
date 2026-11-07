#!/bin/bash
# VTID-05563 (agentic-delivery/nav-paths): the PR's contract. Every changed file is the target lane file, this lane's own
# file or this lane's evidence; none is a governance path (GOVERNANCE_PATHS) or a protected gate file
# (PROTECTED_GATE_PATHS, scripts/collab/protected-gate-files.json); and this lane's permission fields (executor, seat,
# reviewer_seat, paths) and lane_admin are the same at base and head. The four new target paths are checked the same way
# (none is governance or protected, so lane gateway-delivery can use them).
# Usage (from the worktree root): contract-check.sh <base> [<head>]
set -u
BASE=${1:?base revision}
HEAD_REV=${2:-HEAD}
echo "base $(git rev-parse "$BASE")  head $(git rev-parse "$HEAD_REV")"
git diff --name-only "$BASE...$HEAD_REV" > /tmp/navp-files.$$
git show "$BASE:.kiro/specs/agentic-delivery/lanes/nav-paths.md" > /tmp/navp-base.$$
git show "$HEAD_REV:.kiro/specs/agentic-delivery/lanes/nav-paths.md" > /tmp/navp-head.$$
node --input-type=module - /tmp/navp-files.$$ /tmp/navp-base.$$ /tmp/navp-head.$$ "$PWD/scripts/collab/queue.mjs" <<'JS'
import { readFileSync } from 'node:fs';
const [filesPath, basePath, headPath, q] = process.argv.slice(2);
const { GOVERNANCE_PATHS, PROTECTED_GATE_PATHS, matchesAny, parseFrontMatter } = await import(q);
const files = readFileSync(filesPath, 'utf8').split('\n').filter(Boolean);
const allowed = ['.kiro/specs/agentic-delivery/lanes/gateway-delivery.md', '.kiro/specs/agentic-delivery/lanes/nav-paths.md', 'docs/validation/VTID-05563/**'];
let bad = 0;
console.log(`changed files (${files.length}):`);
for (const f of files) {
  const inScope = matchesAny(f, allowed); const gov = matchesAny(f, GOVERNANCE_PATHS); const prot = matchesAny(f, PROTECTED_GATE_PATHS);
  const code = /\.(m?js|cjs|ts|tsx|sql|ya?ml)$/.test(f) && !f.startsWith('docs/validation/');
  const ok = inScope && !gov && !prot && !code;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${f}${gov ? ' [governance]' : ''}${prot ? ' [protected gate]' : ''}${code ? ' [code]' : ''}${inScope ? '' : ' [outside the lane]'}`);
}
const four = ['services/gateway/src/navigation/data/command-hub-screens.json', 'services/gateway/src/navigation/data/nav-embeddings.bin',
  'services/gateway/src/navigation/data/nav-embeddings.json', 'scripts/ci/command-hub-ownership-guard.js'];
for (const f of four) {
  const gov = matchesAny(f, GOVERNANCE_PATHS); const prot = matchesAny(f, PROTECTED_GATE_PATHS);
  if (gov || prot) bad++;
  console.log(`  new target path ${f}: governance=${gov} protected=${prot}`);
}
const b = parseFrontMatter(readFileSync(basePath, 'utf8')); const h = parseFrontMatter(readFileSync(headPath, 'utf8'));
for (const k of ['executor', 'seat', 'reviewer_seat', 'paths', 'lane_admin']) {
  const same = JSON.stringify(b[k]) === JSON.stringify(h[k]);
  if (!same) bad++;
  console.log(`  nav-paths ${k}: ${same ? 'unchanged' : 'CHANGED'} (${JSON.stringify(h[k])})`);
}
console.log(bad === 0 ? 'contract: PASS' : `contract: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 1);
JS
rc=$?
rm -f /tmp/navp-files.$$ /tmp/navp-base.$$ /tmp/navp-head.$$
exit $rc

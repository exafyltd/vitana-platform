#!/usr/bin/env node
// VTID-05564 (agentic-delivery/sv-cwd) — the diff contract of the three manifests, checked from git:
//   node diff-check.mjs <base> <head>     (run in the lane checkout)
// For each of docs/validation/VTID-05515|05516|05518/staging-tests.json:
//   1. `git diff --numstat` is "1 0" (one line added, none removed);
//   2. the added line is exactly `      "cwd": "services/gateway",`;
//   3. the head JSON equals the base JSON with `cwd: "services/gateway"` set on the `existing` test only.
// Then: every file changed in <base>..<head> is one of the three manifests, this lane's file, or its evidence folder.
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const [base, head] = process.argv.slice(2);
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
const MANIFESTS = ['VTID-05515', 'VTID-05516', 'VTID-05518'].map((v) => `docs/validation/${v}/staging-tests.json`);
const ADDED = '      "cwd": "services/gateway",';
let pass = 0;
let fail = 0;
const check = (ok, what) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};

console.log(`base ${git('rev-parse', base).trim()}  head ${git('rev-parse', head).trim()}`);
for (const f of MANIFESTS) {
  const numstat = git('diff', '--numstat', base, head, '--', f).trim();
  check(numstat === `1\t0\t${f}`, `${f}: numstat ${JSON.stringify(numstat.split('\t').slice(0, 2).join(' '))} (want "1 0")`);
  const added = git('diff', '-U0', base, head, '--', f)
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  check(added.length === 1 && added[0] === ADDED, `${f}: added line ${JSON.stringify(added)}`);
  const before = JSON.parse(git('show', `${base}:${f}`));
  const after = JSON.parse(git('show', `${head}:${f}`));
  const want = structuredClone(before);
  const existing = want.tests.filter((t) => t.kind === 'existing');
  existing.forEach((t) => (t.cwd = 'services/gateway'));
  check(existing.length === 1 && isDeepStrictEqual(after, want), `${f}: head JSON = base JSON + cwd on its one existing test`);
}
const allowed = (p) =>
  MANIFESTS.includes(p) || p === '.kiro/specs/agentic-delivery/lanes/sv-cwd.md' || p.startsWith('docs/validation/VTID-05564/');
const changed = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
const outside = changed.filter((p) => !allowed(p));
check(outside.length === 0, `${changed.length} changed file(s) in ${base.slice(0, 10)}..${head.slice(0, 10)}, outside the lane: ${JSON.stringify(outside)}`);
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

// VTID-05763 (plan autonomous-to-staging, lane gate-invariants-ci) — static check of GATE-INVARIANTS.yml.
//
// GATE-INVARIANTS.yml is the only workflow that runs the gate invariants (scripts/collab/gate-invariants.test.mjs)
// against `main` itself. It must keep running on every push to `main` and on a daily schedule, must run the invariant
// suite, must fetch `origin/main` (the suite loads its baseline from there) and must stay read-only.
//
//   node --test scripts/ci/workflow-trigger-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = path.join(ROOT, '.github/workflows/GATE-INVARIANTS.yml');

/** The `on:` block of a workflow, up to the next top-level key. */
export function onBlock(yaml) {
  const m = yaml.match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)+)/m);
  return m ? m[1] : '';
}

/** Problems with a GATE-INVARIANTS.yml text; empty when it is fine. */
export function checkGateInvariantsWorkflow(yaml) {
  const problems = [];
  const on = onBlock(yaml);
  if (!on) problems.push('no on: block');
  if (!/^\s+push:\s*\n\s+branches:\s*\[\s*main\s*\]/m.test(on)) problems.push('does not run on push to main');
  if (/^\s+push:\s*\n(?:\s+branches:.*\n)?\s+paths(-ignore)?:/m.test(on)) problems.push('push trigger is path-filtered (must run on every push to main)');
  const cron = on.match(/^\s+schedule:\s*\n\s+-\s*cron:\s*['"]([^'"]+)['"]/m);
  if (!cron) problems.push('has no schedule (cron) trigger');
  else {
    const f = cron[1].trim().split(/\s+/);
    if (f.length !== 5 || f[2] !== '*' || f[3] !== '*' || f[4] !== '*') problems.push(`schedule ${cron[1]} is not daily`);
  }
  if (!/node --test[^\n]*scripts\/collab\/gate-invariants\.test\.mjs/.test(yaml)) problems.push('does not run scripts/collab/gate-invariants.test.mjs');
  if (!/git fetch[^\n]*origin[^\n]*main/.test(yaml) && !/fetch-depth:\s*0/.test(yaml)) problems.push('does not fetch origin/main (baseline)');
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(yaml)) problems.push('top-level permissions are not contents: read');
  if (/secrets\./.test(yaml)) problems.push('uses a secret (must be read-only, no credentials)');
  if (/continue-on-error:\s*true/.test(yaml)) problems.push('continue-on-error hides a failure');
  return problems;
}

test('GATE-INVARIANTS.yml exists', () => {
  assert.ok(fs.existsSync(WF), `${path.relative(ROOT, WF)} is missing`);
});

test('GATE-INVARIANTS.yml runs the invariants on every push to main and daily, read-only', () => {
  assert.deepEqual(checkGateInvariantsWorkflow(fs.readFileSync(WF, 'utf8')), []);
});

const GOOD = `name: X
on:
  push:
    branches: [main]
  schedule:
    - cron: '17 4 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  j:
    steps:
      - run: git fetch --no-tags --depth=1 origin main:refs/remotes/origin/main
      - run: node --test scripts/collab/gate-invariants.test.mjs
`;

test('mutations: each weakened trigger or step is caught', () => {
  assert.deepEqual(checkGateInvariantsWorkflow(GOOD), []);
  const cases = [
    [GOOD.replace('  push:\n    branches: [main]\n', ''), /push to main/],
    [GOOD.replace('    branches: [main]\n', '    branches: [main]\n    paths: [\'scripts/**\']\n'), /path-filtered/],
    [GOOD.replace("  schedule:\n    - cron: '17 4 * * *'\n", ''), /no schedule/],
    [GOOD.replace("'17 4 * * *'", "'17 4 * * 1'"), /not daily/],
    [GOOD.replace('scripts/collab/gate-invariants.test.mjs', 'scripts/collab/other.test.mjs'), /gate-invariants/],
    [GOOD.replace(/.*git fetch.*\n/, ''), /origin\/main/],
    [GOOD.replace('contents: read', 'contents: write'), /permissions/],
    [GOOD.replace('      - run: node', '      - continue-on-error: true\n        run: node'), /continue-on-error/],
    [GOOD + '        env:\n          T: ${{ secrets.X }}\n', /secret/],
  ];
  for (const [yaml, re] of cases) {
    const p = checkGateInvariantsWorkflow(yaml);
    assert.ok(p.some((x) => re.test(x)), `expected ${re} in ${JSON.stringify(p)}`);
  }
});

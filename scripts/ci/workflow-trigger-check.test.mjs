// VTID-05763 (plan autonomous-to-staging, lane gate-invariants-ci) — static check of GATE-INVARIANTS.yml.
// VTID-05780 (plan autonomous-to-staging-r2, lane protect-gate-workflow) — PROTECTED GATE FILE; the audit step and the
// per-job permissions.
//
// GATE-INVARIANTS.yml is the only workflow that runs the gate invariants (scripts/collab/gate-invariants.test.mjs)
// and the post-merge audit (scripts/collab/gate-audit.mjs) against `main` itself. It must keep running on every push to
// `main` and on a daily schedule, must run the invariant suite and the audit, must fetch `origin/main` (the suite loads
// its baseline from there) with the full history (the audit walks it), and its permissions are exact: top level
// `contents: read`; job `invariants` `contents: read` + `pull-requests: read`; job `report` `contents: read`, the only
// job that names a secret, run only when `invariants` failed.
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

/** Lines of a block indented deeper than `indent`, starting after line `i`. */
function blockAfter(lines, i, indent) {
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '' || /^\s*#/.test(l)) { out.push(l); continue; }
    if (l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  return out;
}
/** `key: value` pairs directly under a `permissions:` line at `indent`, or null when there is none. */
function permissionsAt(lines, indent) {
  const i = lines.findIndex((l) => new RegExp(`^ {${indent}}permissions:\\s*$`).test(l));
  if (i < 0) return null;
  const perms = {};
  for (const l of blockAfter(lines, i, indent)) {
    const m = /^\s+([a-z-]+):\s*([a-z]+)\s*$/.exec(l);
    if (m) perms[m[1]] = m[2];
  }
  return perms;
}
/** Jobs of a workflow → { id: text } (each job's own lines, 2-space job ids under top-level `jobs:`). */
export function jobsOf(yaml) {
  const lines = yaml.split('\n');
  const i = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (i < 0) return {};
  const jobs = {};
  let cur = null;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^\S/.test(l)) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; jobs[cur] = []; continue; }
    if (cur) jobs[cur].push(l);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}
const same = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b).sort());

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
  if (/continue-on-error:\s*true/.test(yaml)) problems.push('continue-on-error hides a failure');
  // Permissions: exact sets, top level and per job.
  const lines = yaml.split('\n');
  if (!same(permissionsAt(lines, 0), { contents: 'read' })) problems.push('top-level permissions are not exactly contents: read');
  const jobs = jobsOf(yaml);
  const inv = jobs.invariants;
  const rep = jobs.report;
  if (!inv) problems.push('no job "invariants"');
  else {
    if (!same(permissionsAt(inv.split('\n'), 4), { contents: 'read', 'pull-requests': 'read' })) problems.push('job invariants permissions are not exactly contents: read, pull-requests: read');
    if (!/node --test[^\n]*scripts\/collab\/gate-invariants\.test\.mjs/.test(inv)) problems.push('does not run scripts/collab/gate-invariants.test.mjs');
    if (!/git fetch[^\n]*origin[^\n]*main/.test(inv)) problems.push('does not fetch origin/main (baseline)');
    if (!/uses:\s*actions\/checkout@\S+\s*\n\s+with:\s*\n(?:\s+[a-z-]+:.*\n)*?\s+fetch-depth:\s*0\b/.test(`${inv}\n`)) problems.push('invariants checkout is not fetch-depth: 0 (the audit walks the full history)');
    if (!/node scripts\/collab\/gate-audit\.mjs[^\n]*--repo \.[^\n]*--gh/.test(inv)) problems.push('does not run the post-merge audit (scripts/collab/gate-audit.mjs --repo . --gh …)');
  }
  if (!rep) problems.push('no job "report"');
  else {
    if (!same(permissionsAt(rep.split('\n'), 4), { contents: 'read' })) problems.push('job report permissions are not exactly contents: read');
    if (!/^ {4}if:\s*(\$\{\{\s*)?failure\(\)(\s*\}\})?\s*$/m.test(rep)) problems.push('job report does not run only if: failure()');
    if (!/^ {4}needs:\s*\[\s*invariants\s*\]\s*$/m.test(rep)) problems.push('job report does not need [invariants]');
    if (!/collab\.gate\.bypass_detected/.test(rep) || !/\/api\/v1\/events\/ingest/.test(rep)) problems.push('job report does not emit OASIS collab.gate.bypass_detected through /api/v1/events/ingest');
  }
  // Secrets: only in job report.
  const outside = [yaml.split(/^jobs:\s*$/m)[0], ...Object.entries(jobs).filter(([k]) => k !== 'report').map(([, v]) => v)].join('\n');
  if (/secrets\./.test(outside)) problems.push('a secret is used outside job report');
  return problems;
}

test('GATE-INVARIANTS.yml exists', () => {
  assert.ok(fs.existsSync(WF), `${path.relative(ROOT, WF)} is missing`);
});

test('GATE-INVARIANTS.yml runs the invariants and the audit on every push to main and daily, with exact permissions', () => {
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
  invariants:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
      - run: node --test scripts/collab/gate-invariants.test.mjs
      - run: node scripts/collab/gate-audit.mjs --since '14 days ago' --repo . --gh o/r
  report:
    needs: [invariants]
    if: failure()
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - env:
          T: \${{ secrets.GATEWAY_SERVICE_TOKEN }}
        run: curl -X POST "$U/api/v1/events/ingest" -d '{"type":"collab.gate.bypass_detected"}'
`;

test('mutations: each weakened trigger, step, permission or secret placement is caught', () => {
  assert.deepEqual(checkGateInvariantsWorkflow(GOOD), []);
  const cases = [
    [GOOD.replace('  push:\n    branches: [main]\n', ''), /push to main/],
    [GOOD.replace('    branches: [main]\n', '    branches: [main]\n    paths: [\'scripts/**\']\n'), /path-filtered/],
    [GOOD.replace("  schedule:\n    - cron: '17 4 * * *'\n", ''), /no schedule/],
    [GOOD.replace("'17 4 * * *'", "'17 4 * * 1'"), /not daily/],
    [GOOD.replace('scripts/collab/gate-invariants.test.mjs', 'scripts/collab/other.test.mjs'), /gate-invariants/],
    [GOOD.replace(/.*git fetch.*\n/, ''), /origin\/main/],
    [GOOD.replace('permissions:\n  contents: read\njobs', 'permissions:\n  contents: write\njobs'), /top-level permissions/],
    [GOOD.replace('permissions:\n  contents: read\njobs', 'permissions:\n  contents: read\n  pull-requests: read\njobs'), /top-level permissions/],
    [GOOD.replace('      - run: node', '      - continue-on-error: true\n        run: node'), /continue-on-error/],
    [GOOD.replace('          fetch-depth: 0\n', '          fetch-depth: 1\n'), /fetch-depth: 0/],
    [GOOD.replace(/.*gate-audit\.mjs.*\n/, ''), /post-merge audit/],
    [GOOD.replace('      contents: read\n      pull-requests: read\n', '      contents: read\n'), /job invariants permissions/],
    [GOOD.replace('      contents: read\n      pull-requests: read\n', '      contents: read\n      pull-requests: write\n'), /job invariants permissions/],
    [GOOD.replace('    permissions:\n      contents: read\n    steps:\n      - env', '    permissions:\n      contents: read\n      issues: write\n    steps:\n      - env'), /job report permissions/],
    [GOOD.replace('    if: failure()\n', ''), /if: failure\(\)/],
    [GOOD.replace('    if: failure()\n', '    if: always()\n'), /if: failure\(\)/],
    [GOOD.replace('    needs: [invariants]\n', ''), /need \[invariants\]/],
    [GOOD.replace('collab.gate.bypass_detected', 'collab.other'), /bypass_detected/],
    [GOOD.replace('  report:\n', '  report_x:\n'), /no job "report"/],
    [GOOD.replace('      - run: node --test scripts/collab/gate-invariants.test.mjs\n', '      - run: node --test scripts/collab/gate-invariants.test.mjs\n        env:\n          X: ${{ secrets.X }}\n'), /secret is used outside job report/],
    [GOOD.replace('permissions:\n  contents: read\njobs', 'permissions:\n  contents: read\nenv:\n  X: ${{ secrets.X }}\njobs'), /secret is used outside job report/],
  ];
  for (const [yaml, re] of cases) {
    assert.notEqual(yaml, GOOD, `mutation ${re} did not apply`);
    const p = checkGateInvariantsWorkflow(yaml);
    assert.ok(p.some((x) => re.test(x)), `expected ${re} in ${JSON.stringify(p)}`);
  }
});

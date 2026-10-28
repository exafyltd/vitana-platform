'use strict';
// VTID-05144 — STAGING-VERIFY.yml: full runs survive a mid-run staging redeploy.
// Run: node --test scripts/ci/staging-verify/workflow.test.cjs (UNIT.yml runs it on every PR)
//
// Static checks of the workflow text (same pattern as record-oasis.test.cjs):
// full runs have their own concurrency group, a `chain` input reaches run.mjs,
// superseded is reported as `error` (never success), and a superseded full run
// re-dispatches a full run on the newer commit, at most 3 in a row.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'STAGING-VERIFY.yml');
const wf = fs.readFileSync(WORKFLOW, 'utf8');

function block(start, end) {
  const i = wf.indexOf(start);
  assert.ok(i >= 0, `missing: ${start}`);
  const j = end ? wf.indexOf(end, i + start.length) : -1;
  return wf.slice(i, j === -1 ? undefined : j);
}
const reportJob = () => block('\n  report:\n');
const redispatch = () => block('- name: Re-run the full verification on the newer commit (VTID-05144)');

test('full runs get their own -full concurrency group; nothing running is ever cancelled', () => {
  const c = block('\nconcurrency:\n', '\njobs:');
  assert.match(c, /group: staging-verify-\$\{\{[^\n]*\}\}\$\{\{ inputs\.full && '-full' \|\| '' \}\}\n/);
  assert.match(c, /cancel-in-progress: false/);
  assert.doesNotMatch(c, /cancel-in-progress: true/);
});

test('workflow_dispatch has a numeric `chain` input defaulting to 0, passed through to run.mjs', () => {
  const inputs = block('  workflow_dispatch:\n', '\npermissions:');
  assert.match(inputs, /\n      chain:\n(?:        .*\n)*?        type: number\n(?:        .*\n)*?        default: 0/);
  const run = block('- name: Run STAGING-VERIFY', '- name: Record result in OASIS');
  assert.match(run, /--chain "\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.chain \|\| 0 \}\}"/);
});

test('the verify job exposes superseded_by from the runner', () => {
  assert.match(block('    outputs:\n', '    steps:'), /superseded_by: \$\{\{ steps\.verify\.outputs\.superseded_by \}\}/);
});

test('superseded is reported as commit status error with "not verified", never success', () => {
  const r = reportJob();
  assert.match(r, /superseded\) STATE=error; DESCRIPTION="superseded — staging moved to \$\{SUPERSEDED_BY:0:12\}; not verified";;/);
  assert.doesNotMatch(r, /superseded\) STATE=success/);
  assert.match(r, /passed\) STATE=success;;/);
  assert.match(r, /-f description="\$DESCRIPTION"/);
});

test('a superseded full run re-dispatches a full run on the newer commit, guarded by FULL and chain < 3', () => {
  const s = redispatch();
  assert.match(s, /if: always\(\) && env\.FULL == 'true' && env\.OUTCOME == 'superseded'/);
  assert.match(s, /if \[ "\$CHAIN" -lt 3 \]; then\n\s+gh workflow run STAGING-VERIFY\.yml --repo exafyltd\/vitana-platform --ref main -f service="\$SERVICE" -f commit_sha="\$SUPERSEDED_BY" -f full=true -f chain=\$\(\(CHAIN\+1\)\)/);
  assert.match(s, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(s, /grep -Eq '\^\[0-9a-f\]\{40\}\$'/, 'only a full sha is dispatched');
});

test('the report job grants itself actions: write next to its status/comment permissions', () => {
  const perms = block('\n  report:\n', '    env:\n');
  assert.match(perms, /permissions:\n      statuses: write\n      pull-requests: write\n      actions: write\n/);
  const r = reportJob();
  assert.match(r, /SUPERSEDED_BY: \$\{\{ needs\.verify\.outputs\.superseded_by \}\}/);
  assert.match(r, /CHAIN: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.chain \|\| 0 \}\}/);
});

test('the deploy-run lookup tokens reach run.mjs, never the test processes', () => {
  const run = block('- name: Run STAGING-VERIFY', '- name: Record result in OASIS');
  assert.match(run, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(run, /VITANA_V1_READ_TOKEN: \$\{\{ secrets\.VITANA_V1_READ_TOKEN \}\}/);
  const src = fs.readFileSync(path.join(__dirname, 'run.mjs'), 'utf8');
  // runPlaywright / runExisting build an explicit env; neither passes these tokens.
  for (const fn of ['function runPlaywright', 'function runExisting']) {
    const body = src.slice(src.indexOf(fn), src.indexOf('\n}\n', src.indexOf(fn)));
    assert.doesNotMatch(body, /GITHUB_TOKEN|VITANA_V1_READ_TOKEN|\.\.\.process\.env\b/, fn);
  }
});

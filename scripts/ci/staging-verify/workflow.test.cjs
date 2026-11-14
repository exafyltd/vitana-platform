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

// VTID-05797: the staging group-admin pair reaches only the Playwright env, and is scrubbed from process.env first.
const RUN_JS = path.join(__dirname, 'run.mjs');
const runSrc = () => fs.readFileSync(RUN_JS, 'utf8');
function fnBody(src, sig) {
  const i = src.indexOf(sig);
  assert.ok(i >= 0, `missing: ${sig}`);
  return src.slice(i, src.indexOf('\n}\n', i));
}

test('(a) the group pair is passed only in the runPlaywright env builder', () => {
  const src = runSrc();
  assert.match(fnBody(src, 'function runPlaywright'), /\.\.\.groupAccountEnv\(\)/);
  for (const fn of ['function runExisting', 'function ensureDeps', 'function passthrough']) {
    assert.doesNotMatch(fnBody(src, fn), /groupAccountEnv|STAGING_GROUP_TEST/, fn);
  }
});

test('(b) the group pair is deleted from process.env at the start of the verify path', () => {
  const src = runSrc();
  assert.match(src, /const GROUP_ACCOUNT_VARS = \['STAGING_GROUP_TEST_EMAIL', 'STAGING_GROUP_TEST_PASSWORD'\]/);
  assert.match(fnBody(src, 'function captureGroupAccount'), /for \(const n of GROUP_ACCOUNT_VARS\) delete process\.env\[n\]/);
  // Called inside verify(), before any git, gh, npm or playwright command.
  const verifyBody = fnBody(src, 'async function verify(args)');
  const capture = verifyBody.indexOf('captureGroupAccount()');
  assert.ok(capture > 0, 'verify() calls captureGroupAccount()');
  for (const spawn of ['confirmLive(', 'productionStamp(', 'git(repoRoot']) {
    const at = verifyBody.indexOf(spawn);
    if (at >= 0) assert.ok(capture < at, `capture runs before ${spawn}`);
  }
  assert.doesNotMatch(src.slice(0, src.indexOf('async function verify')), /captureGroupAccount\(\);/, 'not at import time');
});

test('(c) the TEST_USER_* pair in the Playwright env is unchanged', () => {
  const body = fnBody(runSrc(), 'function runPlaywright');
  assert.match(body, /TEST_USER_EMAIL: process\.env\.TEST_USER_EMAIL \|\| '',/);
  assert.match(body, /TEST_USER_PASSWORD: process\.env\.TEST_USER_PASSWORD \|\| '',/);
});

test('(d) the workflow passes the group secrets to the verify step only', () => {
  const run = block('- name: Run STAGING-VERIFY', '- name: Record result in OASIS');
  assert.match(run, /STAGING_GROUP_TEST_EMAIL: \$\{\{ secrets\.STAGING_GROUP_TEST_EMAIL \}\}/);
  assert.match(run, /STAGING_GROUP_TEST_PASSWORD: \$\{\{ secrets\.STAGING_GROUP_TEST_PASSWORD \}\}/);
  assert.doesNotMatch(wf.replace(run, ''), /STAGING_GROUP_TEST_/, 'no other step or job receives the group pair');
});

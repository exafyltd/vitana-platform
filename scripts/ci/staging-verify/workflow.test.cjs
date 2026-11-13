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
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

// ── commit_sha is optional on workflow_dispatch ───────────────────────────
// Root cause this guards against: a manual workflow_dispatch required
// commit_sha and used it as-is as "the commit under test", with no
// cross-check against what staging actually serves (run
// https://github.com/exafyltd/vitana-platform/actions/runs/43434282759 was
// dispatched with main's tip while staging served an older commit, and
// burned a full run failing against the wrong target). STAGING-VERIFY-NIGHTLY.yml
// already resolves the live-served commit (`run.mjs stamp`) before it
// dispatches; omitting commit_sha now does the same lookup inline, while an
// explicit commit_sha (e.g. a VTID-04709 pinned-rollback re-verification)
// is never second-guessed.

test('commit_sha is optional, with an empty default — not required', () => {
  const field = block('      commit_sha:\n', '\n      full:');
  assert.match(field, /required: false/);
  assert.match(field, /default: ''/);
  assert.doesNotMatch(field, /required: true/);
});

test('an omitted commit_sha gets a full-history checkout of target@main for the live-stamp lookup, gated per service and never when commit_sha is given', () => {
  const gw = block('- name: Checkout target main for live-served commit lookup (gateway)', '- name: Checkout target main for live-served commit lookup (community-app)');
  assert.match(gw, /if: env\.SERVICE == 'gateway' && github\.event_name == 'workflow_dispatch' && inputs\.commit_sha == ''/);
  assert.match(gw, /\n {10}ref: main\n/);
  assert.match(gw, /\n {10}path: target\n/);
  assert.match(gw, /\n {10}fetch-depth: 0\n/);

  const ca = block('- name: Checkout target main for live-served commit lookup (community-app)', '- name: Resolve commit under test');
  assert.match(ca, /if: env\.SERVICE == 'community-app' && github\.event_name == 'workflow_dispatch' && inputs\.commit_sha == ''/);
  assert.match(ca, /repository: exafyltd\/vitana-v1/);
  assert.match(ca, /\n {10}ref: main\n/);
});

test('the real checkout at SHA (used whether commit_sha was given or resolved) is unconditional on commit_sha — never second-guesses an explicit value', () => {
  const gw = block('- name: Checkout commit under test (gateway)', '- name: Checkout commit under test (community-app)');
  assert.match(gw, /if: env\.SERVICE == 'gateway'\n/);
  assert.match(gw, /ref: \$\{\{ env\.SHA \}\}/);
  assert.doesNotMatch(gw, /commit_sha/);

  const ca = block('- name: Checkout commit under test (community-app)', '- name: Run STAGING-VERIFY');
  assert.match(ca, /if: env\.SERVICE == 'community-app'\n/);
  assert.doesNotMatch(ca, /commit_sha/);
});

test('the runner and node are available before the live-stamp lookup, which the Resolve step relies on', () => {
  const steps = block('    steps:\n', '- name: Validate inputs');
  const runnerAt = steps.indexOf('Checkout runner (vitana-platform main)');
  const nodeAt = steps.indexOf('actions/setup-node@v4');
  const lookupAt = steps.indexOf('Checkout target main for live-served commit lookup (gateway)');
  const resolveAt = steps.indexOf('Resolve commit under test (VTID-04715)');
  assert.ok(runnerAt >= 0 && nodeAt >= 0 && lookupAt >= 0 && resolveAt >= 0, 'all four steps must be present');
  assert.ok(runnerAt < nodeAt, 'the runner checkout must come before node is set up');
  assert.ok(nodeAt < lookupAt, 'node must be available before the live-stamp lookup can run');
  assert.ok(lookupAt < resolveAt, 'the live-stamp checkout must land before Resolve commit under test runs it');
});

// ── Resolve commit under test: behavioral (not just textual) proof ───────
// Extracts the exact `run:` body of the step from the YAML and executes it
// with the same shell GitHub Actions uses, so these tests exercise the real
// production text, not a parallel reimplementation. A revert of the fix (or
// a change that silently drops the new branch) fails these again.
function stepScript(name) {
  const marker = `- name: ${name}`;
  const start = wf.indexOf(marker);
  assert.ok(start >= 0, `missing step: ${name}`);
  const nextStep = wf.indexOf('\n      - name:', start + marker.length);
  const nextUses = wf.indexOf('\n      - uses:', start + marker.length);
  const candidates = [nextStep, nextUses].filter((i) => i !== -1);
  const end = candidates.length ? Math.min(...candidates) : wf.length;
  const runAt = wf.indexOf('run: |', start);
  assert.ok(runAt >= 0 && runAt < end, `step ${name} has no 'run: |' block`);
  const body = wf.slice(runAt + 'run: |'.length, end);
  const lines = body.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indents = lines.filter((l) => l.trim() !== '').map((l) => l.match(/^ */)[0].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => (l.length >= indent ? l.slice(indent) : l)).join('\n') + '\n';
}

const RESOLVE_SCRIPT = stepScript('Resolve commit under test (VTID-04715)');

// A fake `node`, first on PATH: records every call (to NODE_CALL_LOG) and,
// for `run.mjs stamp`, answers with FAKE_STAMP_SHA (empty = "could not
// resolve", mirroring a real stamp failure). Any other invocation fails
// loudly rather than guessing what the script wanted.
const FAKE_NODE = `#!/usr/bin/env bash
echo "$@" >> "$NODE_CALL_LOG"
if [ "$2" = "stamp" ]; then
  echo "$FAKE_STAMP_SHA"
  exit "\${FAKE_STAMP_EXIT:-0}"
fi
echo "unexpected fake-node invocation: $@" >&2
exit 1
`;

/** Runs the real "Resolve commit under test" script text with `bash --noprofile --norc -eo pipefail` (GitHub
 * Actions' own invocation), a fake `node` first on PATH, and the given env. RECORDED defaults to a path that
 * does not exist (no deployed-commit artifact), matching every event except a workflow_run with VTID-04715 pinning. */
function runResolveStep(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-commit-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), FAKE_NODE, { mode: 0o755 });
    const scriptFile = path.join(dir, 'step.sh');
    fs.writeFileSync(scriptFile, RESOLVE_SCRIPT);
    const githubEnv = path.join(dir, 'github_env');
    fs.writeFileSync(githubEnv, '');
    const callLog = path.join(dir, 'node_calls.log');
    fs.writeFileSync(callLog, '');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME || '',
        GITHUB_ENV: githubEnv,
        NODE_CALL_LOG: callLog,
        RECORDED: path.join(dir, 'no-such-artifact'),
        ...env,
      },
    });
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      githubEnv: fs.readFileSync(githubEnv, 'utf8'),
      nodeCalls: fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const FAKE_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const GIVEN_SHA = '1111111111111111111111111111111111111111';
const DEPLOYED_SHA = '2222222222222222222222222222222222222222';

test('commit_sha omitted (workflow_dispatch): resolves via `run.mjs stamp` and uses its result as SHA', () => {
  const r = runResolveStep({ GITHUB_EVENT_NAME: 'workflow_dispatch', SERVICE: 'gateway', EVENT_SHA: '', FAKE_STAMP_SHA: FAKE_SHA });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.nodeCalls.length, 1, 'the live-stamp lookup must run exactly once');
  assert.match(r.nodeCalls[0], /run\.mjs stamp --service gateway --repo-root target/);
  assert.match(r.githubEnv, new RegExp(`SHA=${FAKE_SHA}\\n`));
});

test('commit_sha given (workflow_dispatch): the live-stamp lookup is never called, and the given commit is never overridden', () => {
  const r = runResolveStep({ GITHUB_EVENT_NAME: 'workflow_dispatch', SERVICE: 'gateway', EVENT_SHA: GIVEN_SHA, FAKE_STAMP_SHA: FAKE_SHA });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.nodeCalls.length, 0, 'an explicit commit_sha must never trigger the live-stamp lookup');
  assert.match(r.githubEnv, new RegExp(`SHA=${GIVEN_SHA}\\n`));
});

test('a VTID-04709 pinned rollback (workflow_run, recorded deployed-commit) still wins over EVENT_SHA — unchanged, no live-stamp lookup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-'));
  try {
    const recorded = path.join(dir, 'sha');
    fs.writeFileSync(recorded, `${DEPLOYED_SHA}\n`);
    const r = runResolveStep({ GITHUB_EVENT_NAME: 'workflow_run', SERVICE: 'gateway', EVENT_SHA: GIVEN_SHA, RECORDED: recorded, FAKE_STAMP_SHA: FAKE_SHA });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(r.nodeCalls.length, 0);
    assert.match(r.githubEnv, new RegExp(`SHA=${DEPLOYED_SHA}\\n`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a normal workflow_run deploy (no recorded artifact) keeps using EVENT_SHA — unchanged, no live-stamp lookup', () => {
  const r = runResolveStep({ GITHUB_EVENT_NAME: 'workflow_run', SERVICE: 'community-app', EVENT_SHA: GIVEN_SHA, FAKE_STAMP_SHA: FAKE_SHA });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.nodeCalls.length, 0);
  assert.match(r.githubEnv, new RegExp(`SHA=${GIVEN_SHA}\\n`));
});

test('a repository_dispatch deploy (community-app) keeps using EVENT_SHA — unchanged, no live-stamp lookup', () => {
  const r = runResolveStep({ GITHUB_EVENT_NAME: 'repository_dispatch', SERVICE: 'community-app', EVENT_SHA: GIVEN_SHA, FAKE_STAMP_SHA: FAKE_SHA });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.nodeCalls.length, 0, 'only workflow_dispatch resolves live; other events already name a commit');
  assert.match(r.githubEnv, new RegExp(`SHA=${GIVEN_SHA}\\n`));
});

test('commit_sha omitted and the live commit cannot be resolved: fails loudly, never silently proceeds with no commit', () => {
  const r = runResolveStep({ GITHUB_EVENT_NAME: 'workflow_dispatch', SERVICE: 'community-app', EVENT_SHA: '', FAKE_STAMP_SHA: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /::error::.*could not be resolved/);
  assert.equal(r.githubEnv, '', 'SHA must never reach GITHUB_ENV when resolution failed');
});

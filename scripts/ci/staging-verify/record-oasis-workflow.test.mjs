// VTID-05551 (agentic-delivery/prerequisites) — record-oasis.sh names the host that verified.
// Run: node --test scripts/ci/staging-verify/record-oasis-workflow.test.mjs (UNIT.yml runs it on every PR)
//
// The GitLab staging-verify pipeline reuses record-oasis.sh and sets
// WORKFLOW=gitlab:<project>/staging-verify, so every staging.verify.* row in
// OASIS says which host verified it. GitHub's STAGING-VERIFY.yml sets no
// WORKFLOW, so its rows must stay byte for byte what they are today. These
// tests run the real script with a fake curl first on PATH that saves the body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'record-oasis.sh');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN_URL = 'https://github.com/exafyltd/vitana-platform/actions/runs/1';
const GITLAB = 'gitlab:vitana/vitana-v1/staging-verify';

const FAKE_CURL = `#!/usr/bin/env bash
# saves the @file body curl is sent
for a in "$@"; do
  case "$a" in @*) cp "\${a#@}" "$FAKE_OUT/body.json" ;; esac
done
exit 0
`;

const FIXTURE = {
  vtid: 'VTID-05551', outcome: 'passed', service: 'gateway', sha: SHA,
  message: '**Staging verification passed**', vtids: ['VTID-05551'], production_stamp: '98ebdab1',
  results: [
    { suite: 'smoke', name: 'alive', ok: true, problems: [] },
    { suite: 'VTID-05551', name: 'atlas claims', ok: true, problems: [], attributed: true },
  ],
  plan: { missing: [], invalid: [] }, shipping: ['VTID-05551'], full: false,
};

// The bodies today's script (origin/main before VTID-05551) sends for FIXTURE and
// for a crashed runner: same keys, same order, no spaces, one trailing newline (jq -c).
const TODAY_RESULTS_BODY = `${JSON.stringify({
  vtid: 'VTID-05551', topic: 'staging.verify.passed', service: 'staging-verify-gateway', role: 'CICD',
  model: 'staging-verify', status: 'success', message: '**Staging verification passed**',
  metadata: {
    env: 'staging', service: 'gateway', commit: SHA, outcome: 'passed', vtids: ['VTID-05551'], run_url: RUN_URL,
    production_commit: '98ebdab1',
    results: [
      { suite: 'smoke', name: 'alive', ok: true, problems: [] },
      { suite: 'VTID-05551', name: 'atlas claims', ok: true, problems: [], attributed: true },
    ],
    missing_suites: [], invalid_suites: [], shipping: ['VTID-05551'], full: false, workflow: 'STAGING-VERIFY.yml',
    superseded_by: null, attribution_cutoff: null, chain: 0,
  },
})}\n`;

const TODAY_CRASHED_BODY = `${JSON.stringify({
  vtid: 'BOOTSTRAP-STAGING-VERIFY', topic: 'staging.verify.failed', service: 'staging-verify-gateway', role: 'CICD',
  model: 'staging-verify', status: 'error',
  message: `**Staging verification FAILED — the runner crashed before producing a result.** Not ready for production. Run: ${RUN_URL}`,
  metadata: { env: 'staging', service: 'gateway', commit: SHA, outcome: 'failed', run_url: RUN_URL, crashed: true, workflow: 'STAGING-VERIFY.yml' },
})}\n`;

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-oasis-workflow-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  const results = path.join(dir, 'results.json');
  fs.writeFileSync(results, JSON.stringify(FIXTURE));
  return { dir, bin, results, missing: path.join(dir, 'missing.json') };
}

/** Runs the script with only the env it reads; `workflow: undefined` leaves WORKFLOW unset. */
function send(h, { results, workflow }) {
  const env = {
    PATH: `${h.bin}:${process.env.PATH}`,
    FAKE_OUT: h.dir,
    RUNNER_TEMP: h.dir,
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SVC: 'test-key',
    RESULTS: results,
    RUN_URL,
    SERVICE: 'gateway',
    SHA,
  };
  if (workflow !== undefined) env.WORKFLOW = workflow;
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(path.join(h.dir, 'body.json'), 'utf8');
}

const withWorkflow = (body, value) =>
  body.replace('"workflow":"STAGING-VERIFY.yml"', `"workflow":${JSON.stringify(value)}`);

test('WORKFLOW unset: the body is byte-identical to today\'s', () => {
  const h = harness();
  assert.equal(send(h, { results: h.results }), TODAY_RESULTS_BODY);
});

test('WORKFLOW empty: treated as unset, the body is byte-identical to today\'s', () => {
  const h = harness();
  assert.equal(send(h, { results: h.results, workflow: '' }), TODAY_RESULTS_BODY);
});

test('WORKFLOW set: the body differs from today\'s only in metadata.workflow', () => {
  const h = harness();
  const body = send(h, { results: h.results, workflow: GITLAB });
  assert.equal(body, withWorkflow(TODAY_RESULTS_BODY, GITLAB));
  const sent = JSON.parse(body);
  const today = JSON.parse(TODAY_RESULTS_BODY);
  assert.equal(sent.metadata.workflow, GITLAB);
  sent.metadata.workflow = today.metadata.workflow;
  assert.deepEqual(sent, today);
});

test('crashed runner, WORKFLOW unset: the body is byte-identical to today\'s', () => {
  const h = harness();
  assert.equal(send(h, { results: h.missing }), TODAY_CRASHED_BODY);
});

test('crashed runner, WORKFLOW set: the body differs from today\'s only in metadata.workflow', () => {
  const h = harness();
  const body = send(h, { results: h.missing, workflow: GITLAB });
  assert.equal(body, withWorkflow(TODAY_CRASHED_BODY, GITLAB));
  const sent = JSON.parse(body);
  assert.equal(sent.metadata.workflow, GITLAB);
  assert.equal(sent.metadata.crashed, true);
  assert.equal(sent.topic, 'staging.verify.failed');
});

test('WORKFLOW is passed as data: quotes and backslashes stay one JSON string', () => {
  const h = harness();
  const odd = 'gitlab:x"y\\z", "injected": true';
  const sent = JSON.parse(send(h, { results: h.results, workflow: odd }));
  assert.equal(sent.metadata.workflow, odd);
  assert.equal('injected' in sent.metadata, false);
});

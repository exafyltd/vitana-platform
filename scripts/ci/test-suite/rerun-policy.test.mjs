// VTID-05272 — tests for rerun-policy.mjs and TEST-SUITE-RERUN.yml.
// Run: node --test scripts/ci/test-suite/ (CI-SCRIPTS-TEST.yml)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRerun, classifyJob, hasJestSummary } from './rerun-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const step = (name, conclusion, status = 'completed') => ({ name, status, conclusion });
const shardJob = (id, n, steps) => ({ id, name: `Gateway (Jest, shard ${n}/4)`, conclusion: 'failure', steps });
const ok = (name) => step(name, 'success');
const run = (o = {}) => ({ run_attempt: 1, conclusion: 'failure', ...o });
const roll = [{ id: 90, name: 'gateway-shard-union', conclusion: 'failure', steps: [ok('Download shard results'), step('Check shard union', 'failure')] },
  { id: 91, name: 'Test Suite Summary', conclusion: 'failure', steps: [step('Report', 'failure')] }];

test('install failed → re-run', () => {
  const jobs = [shardJob(1, 2, [ok('Set up job'), step('Install', 'failure'), step('List tests', 'skipped'), step('Run Jest suite', 'skipped')]), ...roll];
  const d = shouldRerun({ run: run(), jobs });
  assert.equal(d.rerun, true, d.reason);
});
test('Jest ran and failed (summary printed) → no re-run', () => {
  const jobs = [shardJob(1, 3, [ok('Install'), ok('List tests'), step('Run Jest suite', 'failure')]), ...roll];
  const log = '2026-10-20T10:00:00.0000000Z Test Suites: 1 failed, 430 passed, 431 total\n2026-10-20T10:00:00.0000000Z Tests:       1 failed, 7000 passed, 7001 total\n';
  const d = shouldRerun({ run: run(), jobs, logs: { 1: log } });
  assert.equal(d.rerun, false);
  assert.match(d.reason, /real failure/);
});
test('Jest step died without a summary → re-run; unreadable log → no re-run', () => {
  const jobs = [shardJob(1, 1, [ok('Install'), ok('List tests'), step('Run Jest suite', 'failure')])];
  assert.equal(shouldRerun({ run: run(), jobs, logs: { 1: 'Error: The runner has received a shutdown signal.\n' } }).rerun, true);
  assert.equal(shouldRerun({ run: run(), jobs }).rerun, false);
});
test('attempt 2 → no re-run (at most one)', () => {
  const jobs = [shardJob(1, 2, [step('Install', 'failure'), step('Run Jest suite', 'skipped')])];
  const d = shouldRerun({ run: run({ run_attempt: 2 }), jobs });
  assert.equal(d.rerun, false);
  assert.match(d.reason, /at most one/);
});
test('cancelled or successful run → no re-run', () => {
  const jobs = [shardJob(1, 2, [step('Install', 'failure'), step('Run Jest suite', 'skipped')])];
  assert.equal(shouldRerun({ run: run({ conclusion: 'cancelled' }), jobs }).rerun, false);
  assert.equal(shouldRerun({ run: run({ conclusion: 'success' }), jobs: [] }).rerun, false);
});
test('one infra death plus one real red → no re-run; a union mismatch with green shards is real', () => {
  const jobs = [
    shardJob(1, 1, [step('Install', 'failure'), step('Run Jest suite', 'skipped')]),
    shardJob(2, 2, [ok('Install'), step('Run Jest suite', 'failure')]),
    ...roll,
  ];
  assert.equal(shouldRerun({ run: run(), jobs, logs: { 2: 'Tests:       2 failed, 10 passed, 12 total' } }).rerun, false);
  assert.equal(shouldRerun({ run: run(), jobs: roll }).rerun, false, 'only the union failed: a real gap in the shards');
  assert.equal(classifyJob(roll[0], { shardFailed: false }), 'real');
  assert.equal(classifyJob(roll[1]), 'derived');
});
test('services matrix job: install failure is infra, a failed `Run tests` with a summary is real; unknown jobs never re-run', () => {
  const svc = (steps) => ({ id: 5, name: 'vcaop (jest)', conclusion: 'failure', steps });
  assert.equal(classifyJob(svc([step('Install', 'failure'), step('Run tests', 'skipped')])), 'infra');
  assert.equal(classifyJob(svc([ok('Install'), step('Run tests', 'failure')]), { logHasSummary: true }), 'real');
  assert.equal(classifyJob({ name: 'other', steps: [step('Build', 'failure')] }), 'unknown');
  assert.equal(hasJestSummary('Tests:       1 failed, 1 total'), true);
  assert.equal(hasJestSummary('Test Suites: 3 passed, 3 total'), true);
  assert.equal(hasJestSummary('npm ERR! code 1'), false);
});
test('TEST-SUITE-RERUN.yml: workflow_run of TEST-SUITE, failure + attempt 1 only, policy from the default branch', () => {
  const y = readFileSync(path.join(ROOT, '.github/workflows/TEST-SUITE-RERUN.yml'), 'utf8');
  assert.match(y, /workflow_run:\n\s+workflows: \[TEST-SUITE\]\n\s+types: \[completed\]/);
  assert.match(y, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(y, /github\.event\.workflow_run\.run_attempt == 1/);
  assert.match(y, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(y, /node scripts\/ci\/test-suite\/rerun-policy\.mjs --repo/);
  assert.doesNotMatch(y, /pull_request_target|contents: write/);
});

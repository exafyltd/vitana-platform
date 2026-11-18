// VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover): the flip gate (scripts/aws/staging-cutover-gate.mjs),
// the impact check (scripts/ci/staging-db/impact.mjs) and the smoke runner (scripts/aws/staging-cutover-smoke.mjs).
// No network, no AWS.
//   node --test scripts/ci/staging-db/cutover-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, passingRehearsal, PRODUCTION_GATEWAY } from '../../aws/staging-cutover-gate.mjs';
import { report, stagingCallers, classifyWorkflows, loadClassification, classifyTest, activeLaneVtids } from './impact.mjs';
import { runSmoke } from '../../aws/staging-cutover-smoke.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-11-13T10:00:00Z');
const RUN = { head_sha: SHA, conclusion: 'success', status: 'completed', event: 'workflow_dispatch', head_branch: 'main',
  display_title: `Staging cutover rehearsal run @ ${SHA} [VTID: VTID-05781]`, updated_at: '2026-11-13T09:00:00Z', html_url: 'https://github.com/x/runs/1' };
const ENV = { STAGING_CUTOVER_APPROVED: 'yes', PLAN_SPAR_GATEWAY_URL: PRODUCTION_GATEWAY, STAGING_DB_CLIENT_SG_ID: 'sg-0abc1234def567890' };
const CLEAR = { blockers: [] };
const ok = (over = {}) => decide({ sha: SHA, runs: [RUN], impact: CLEAR, busy: [], env: ENV, now: NOW, ...over });

test('gate: allowed when every precondition holds', () => {
  const r = ok();
  assert.deepEqual(r.reasons, []);
  assert.equal(r.allowed, true);
});

const cases = [
  ['STAGING_CUTOVER_APPROVED unset', { env: { ...ENV, STAGING_CUTOVER_APPROVED: '' } }, /STAGING_CUTOVER_APPROVED/],
  ['STAGING_CUTOVER_APPROVED=true (only "yes" counts)', { env: { ...ENV, STAGING_CUTOVER_APPROVED: 'true' } }, /STAGING_CUTOVER_APPROVED/],
  ['PLAN_SPAR_GATEWAY_URL unset (PLAN-SPAR/VTID-ALLOCATE default to staging)', { env: { ...ENV, PLAN_SPAR_GATEWAY_URL: '' } }, /second ledger/],
  ['PLAN_SPAR_GATEWAY_URL = the staging gateway', { env: { ...ENV, PLAN_SPAR_GATEWAY_URL: 'https://preview-aws-gateway.vitanaland.com' } }, /second ledger/],
  ['STAGING_DATA_PLANE already isolated', { env: { ...ENV, STAGING_DATA_PLANE: 'isolated' } }, /starts from shared/],
  ['no client SG', { env: { ...ENV, STAGING_DB_CLIENT_SG_ID: '' } }, /STAGING_DB_CLIENT_SG_ID/],
  ['no rehearsal', { runs: [] }, /no successful rehearsal/],
  ['rehearsal on another commit', { runs: [{ ...RUN, head_sha: 'b'.repeat(40) }] }, /no successful rehearsal/],
  ['rehearsal in register mode only', { runs: [{ ...RUN, display_title: `Staging cutover rehearsal register @ ${SHA} [VTID: VTID-05781]` }] }, /no successful rehearsal/],
  ['failed rehearsal', { runs: [{ ...RUN, conclusion: 'failure' }] }, /no successful rehearsal/],
  ['rehearsal off main', { runs: [{ ...RUN, head_branch: 'kiro/x' }] }, /no successful rehearsal/],
  ['rehearsal older than 7 days', { runs: [{ ...RUN, updated_at: '2026-11-01T09:00:00Z' }] }, /no successful rehearsal/],
  ['impact blockers', { impact: { blockers: ['PLAN-SPAR.yml: blocks'] } }, /impact: PLAN-SPAR\.yml/],
  ['impact report missing', { impact: null }, /impact report missing/],
  ['a staging deploy running', { busy: ['https://github.com/x/actions/runs/9'] }, /one staging deploy at a time/],
  ['busy list missing', { busy: null }, /missing/],
  ['short SHA', { sha: 'abc123' }, /40-character/],
];
for (const [name, over, re] of cases) {
  test(`gate refuses: ${name}`, () => {
    const r = ok(over);
    assert.equal(r.allowed, false);
    assert.ok(r.reasons.some((x) => re.test(x)), r.reasons.join(' | '));
  });
}

test('gate: the newest qualifying rehearsal is chosen', () => {
  const older = { ...RUN, updated_at: '2026-11-12T09:00:00Z', html_url: 'old' };
  assert.equal(passingRehearsal([older, RUN], SHA, NOW).html_url, RUN.html_url);
});

// ---- impact.mjs
test('impact: every workflow naming the staging gateway is classified on this checkout, and no classification is stale', () => {
  const r = report({ root: ROOT, env: {} });
  assert.deepEqual(r.workflows.filter((w) => w.class === null).map((w) => w.file), []);
  assert.deepEqual(r.stale_classifications, []);
  assert.ok(r.workflows.length >= 18);
});

test('impact: PLAN-SPAR and VTID-ALLOCATE block until PLAN_SPAR_GATEWAY_URL is the production gateway; owner acceptance cannot unblock them', () => {
  const callers = stagingCallers(ROOT);
  const cls = loadClassification(ROOT);
  const pick = (rows, f) => rows.find((r) => r.file === f);
  const accepted = { STAGING_CUTOVER_IMPACT_ACCEPTED: 'PLAN-SPAR.yml,VTID-ALLOCATE.yml' };
  for (const f of ['PLAN-SPAR.yml', 'VTID-ALLOCATE.yml']) {
    assert.equal(pick(classifyWorkflows(callers, cls, {}).rows, f).blocking, true);
    assert.equal(pick(classifyWorkflows(callers, cls, accepted).rows, f).blocking, true);
    assert.equal(pick(classifyWorkflows(callers, cls, { PLAN_SPAR_GATEWAY_URL: 'https://gateway.vitanaland.com' }).rows, f).blocking, false);
  }
});

test('impact: an acceptable governance-signal writer blocks until the owner lists it', () => {
  const callers = stagingCallers(ROOT);
  const cls = loadClassification(ROOT);
  const row = (e) => classifyWorkflows(callers, cls, e).rows.find((r) => r.file === 'DEV-AUTOPILOT.yml');
  assert.equal(row({}).blocking, true);
  assert.equal(row({ STAGING_CUTOVER_IMPACT_ACCEPTED: 'E2E-TEST-RUN.yml, DEV-AUTOPILOT.yml' }).blocking, false);
});

test('impact: a new, unclassified workflow that names the staging gateway blocks the flip (temp repo)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-'));
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/ci/staging-db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/validation'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/ci/staging-db/impact-classification.json'), path.join(root, 'scripts/ci/staging-db/impact-classification.json'));
  fs.writeFileSync(path.join(root, '.github/workflows/NEW-WRITER.yml'), 'run: curl -X POST https://preview-aws-gateway.vitanaland.com/api/v1/vtid/allocate\n');
  const r = report({ root, env: { PLAN_SPAR_GATEWAY_URL: 'https://gateway.vitanaland.com' } });
  assert.equal(r.flip_allowed, false);
  assert.ok(r.blockers.some((b) => /NEW-WRITER\.yml: unclassified/.test(b)));
});

test('impact: suites are classified; an in-flight lane suite that reads data blocks, a done lane suite does not', () => {
  assert.equal(classifyTest({ kind: 'http', path: '/alive' }), 'plane-neutral');
  assert.equal(classifyTest({ kind: 'http', path: '/api/v1/community/members', expect_status: 401 }), 'plane-neutral');
  assert.equal(classifyTest({ kind: 'http', method: 'POST', path: '/api/v1/x', rejected_probe: true, expect_status: 401 }), 'plane-neutral');
  assert.equal(classifyTest({ kind: 'existing', ref: 'npx jest x' }), 'plane-neutral');
  assert.equal(classifyTest({ kind: 'http', path: '/api/v1/vtid/health' }), 'schema-dependent');
  assert.equal(classifyTest({ kind: 'http', path: '/api/v1/oasis/tasks' }), 'needs-review');
  assert.equal(classifyTest({ kind: 'playwright', spec: 'x' }), 'needs-review');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-'));
  for (const d of ['.github/workflows', 'scripts/ci/staging-db', 'docs/validation/VTID-09001', 'docs/validation/VTID-09002', '.kiro/specs/p/lanes']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/ci/staging-db/impact-classification.json'), path.join(root, 'scripts/ci/staging-db/impact-classification.json'));
  const suite = (v) => JSON.stringify({ vtid: v, service: 'gateway', tests: [{ kind: 'http', path: '/api/v1/oasis/tasks' }] });
  fs.writeFileSync(path.join(root, 'docs/validation/VTID-09001/staging-tests.json'), suite('VTID-09001'));
  fs.writeFileSync(path.join(root, 'docs/validation/VTID-09002/staging-tests.json'), suite('VTID-09002'));
  fs.writeFileSync(path.join(root, '.kiro/specs/p/lanes/a.md'), '---\nlane: a\nstate: in-review\nvtid: VTID-09001\n---\n');
  fs.writeFileSync(path.join(root, '.kiro/specs/p/lanes/b.md'), '---\nlane: b\nstate: done\nvtid: VTID-09002\n---\n');
  assert.deepEqual([...activeLaneVtids(root)], ['VTID-09001']);
  const r = report({ root, env: {} });
  assert.deepEqual(r.active_needs_review, ['VTID-09001']);
  assert.equal(r.flip_allowed, false);
});

// ---- staging-cutover-smoke.mjs
const fakeFetch = (handler) => async (url, init) => {
  const { status, body, type } = handler(new URL(url).pathname, init);
  return { status, headers: { get: () => type ?? 'application/json' }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
};
const SUITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/staging-verify/smoke/gateway.json'), 'utf8'));
const healthy = (p) => {
  if (p === '/api/v1/community/members' || p === '/api/v1/operator/publish') return { status: 401, body: { ok: false } };
  if (p === '/api/v1/admin/health') return { status: 200, body: { env: 'staging' } };
  if (p === '/api/v1/admin/build-info') return { status: 200, body: { ok: true, env: 'staging' } };
  return { status: 200, body: { ok: true } };
};

test('smoke: the STAGING-VERIFY gateway suite passes against a healthy candidate', async () => {
  const r = await runSmoke({ base: 'https://preview-iso-gateway.vitanaland.com', suite: SUITE, attempts: 1, fetchImpl: fakeFetch(healthy) });
  assert.equal(r.passed, r.total);
  assert.equal(r.total, SUITE.tests.length);
});

test('smoke: a failing check is retried, then fails the run (cold start vs. real failure)', async () => {
  let n = 0;
  const cold = (p) => (p === '/api/v1/vtid/health' && n++ < 1 ? { status: 503, body: {} } : healthy(p));
  const r1 = await runSmoke({ base: 'https://preview-iso-gateway.vitanaland.com', suite: SUITE, attempts: 3, sleep: async () => {}, fetchImpl: fakeFetch(cold) });
  assert.equal(r1.passed, r1.total, 'one cold-start 503 is absorbed by the retry');
  const broken = (p) => (p === '/api/v1/admin/health' ? { status: 200, body: { env: 'production' } } : healthy(p));
  const r2 = await runSmoke({ base: 'https://preview-iso-gateway.vitanaland.com', suite: SUITE, attempts: 2, sleep: async () => {}, fetchImpl: fakeFetch(broken) });
  assert.equal(r2.passed, r2.total - 1);
});

test('smoke: a production host is refused before any request; a write is never sent', async () => {
  let calls = 0;
  await assert.rejects(runSmoke({ base: 'https://gateway.vitanaland.com', suite: SUITE, attempts: 1, sleep: async () => {}, fetchImpl: async () => { calls++; return null; } }), /production/);
  assert.equal(calls, 0);
  const sent = [];
  const r = await runSmoke({ base: 'https://preview-iso-gateway.vitanaland.com', suite: { tests: [{ kind: 'http', name: 'w', method: 'POST', path: '/api/v1/x' }] }, attempts: 1, fetchImpl: async (u, i) => { sent.push(i.method); return null; } });
  assert.equal(r.passed, 0);
  assert.deepEqual(sent, []);
});

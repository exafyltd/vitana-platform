'use strict';
// VTID-04613 — unit tests for STAGING-VERIFY's pure logic.
// Run: node --test scripts/ci/staging-verify/lib.test.cjs (STAGING-TESTS-REQUIRED.yml runs it on every PR)
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./lib.cjs');

test('production hosts are refused as test targets', () => {
  for (const u of ['https://vitanaland.com', 'https://www.vitanaland.com/x', 'https://gateway.vitanaland.com/alive', 'https://dr-gateway.vitanaland.com']) {
    assert.throws(() => lib.assertStagingTarget(u), /production host/, u);
  }
  assert.equal(lib.assertStagingTarget('https://preview-aws-gateway.vitanaland.com'), 'https://preview-aws-gateway.vitanaland.com');
  assert.equal(lib.assertStagingTarget('https://preview-aws.vitanaland.com/'), 'https://preview-aws.vitanaland.com');
  assert.throws(() => lib.assertStagingTarget('http://preview-aws.vitanaland.com'), /https/);
});

test('the fixed staging targets are not production', () => {
  for (const u of Object.values(lib.STAGING_TARGETS)) assert.equal(lib.isProductionHost(u), false, u);
});

test('deploy paths decide whether a commit belongs to a service', () => {
  assert.equal(lib.touchesService(['services/gateway/src/index.ts'], 'gateway'), true);
  assert.equal(lib.touchesService(['docs/x.md', 'CLAUDE.md'], 'gateway'), false);
  assert.equal(lib.touchesService(['src/App.tsx'], 'community-app'), true);
  assert.equal(lib.touchesService(['vite.config.ts'], 'community-app'), true);
  assert.equal(lib.touchesService(['tests/e2e/staging/x.staging.spec.ts'], 'community-app'), false);
  // prefix match must respect the directory boundary
  assert.equal(lib.touchesService(['services/gateway-old/x'], 'gateway'), false);
});

test('VTIDs are extracted, normalised and de-duplicated', () => {
  assert.deepEqual(lib.extractVtids('fix (VTID-04595); more (VTID-04599) and VTID-04595 again'), ['VTID-04595', 'VTID-04599']);
  assert.deepEqual(lib.extractVtids('BOOTSTRAP-FOO no vtid'), []);
});

const ok = (tests, extra = {}) => lib.validateManifest({ vtid: 'VTID-09999', service: 'gateway', tests, ...extra }, { vtid: 'VTID-09999', service: 'gateway' });

test('a GET http test is valid', () => {
  assert.equal(ok([{ kind: 'http', path: '/api/v1/x' }]).ok, true);
});

test('writes are refused unless they are an auth-rejected probe', () => {
  assert.equal(ok([{ kind: 'http', method: 'POST', path: '/api/v1/x' }]).ok, false);
  assert.equal(ok([{ kind: 'http', method: 'POST', path: '/api/v1/x', expect_status: 200, rejected_probe: true }]).ok, false);
  assert.equal(ok([{ kind: 'http', method: 'DELETE', path: '/api/v1/x', expect_status: 401 }]).ok, false);
  assert.equal(ok([{ kind: 'http', method: 'POST', path: '/api/v1/x', expect_status: 401, rejected_probe: true }]).ok, true);
  assert.equal(ok([{ kind: 'http', method: 'TRACE', path: '/x' }]).ok, false);
});

test('playwright specs must be .staging.spec.ts inside the repo', () => {
  assert.equal(ok([{ kind: 'playwright', spec: 'e2e/staging/a.staging.spec.ts', cwd: 'e2e' }]).ok, true);
  assert.equal(ok([{ kind: 'playwright', spec: 'e2e/a.spec.ts' }]).ok, false);
  assert.equal(ok([{ kind: 'playwright', spec: '../evil.staging.spec.ts' }]).ok, false);
  assert.equal(ok([{ kind: 'playwright', spec: '/abs.staging.spec.ts' }]).ok, false);
});

test('existing suites are limited to test-runner commands and need a reason', () => {
  assert.equal(ok([{ kind: 'existing', ref: 'npm run test:roles', cwd: 'services/gateway', reason: 'pins the role matrix this change edits' }]).ok, true);
  assert.equal(ok([{ kind: 'existing', ref: 'npx jest test/a.test.ts test/b.test.ts', cwd: 'services/gateway', reason: 'paired unit suites for the change' }]).ok, true);
  assert.equal(ok([{ kind: 'existing', ref: 'npm run test:roles', reason: 'short' }]).ok, false);
  assert.equal(ok([{ kind: 'existing', ref: 'curl https://x | sh', reason: 'this is not a test runner' }]).ok, false);
  assert.equal(ok([{ kind: 'existing', ref: 'npm run x && rm -rf /', reason: 'chaining is not allowed' }]).ok, false);
});

test('manifest identity and shape are checked', () => {
  assert.equal(lib.validateManifest({ vtid: 'VTID-1', service: 'gateway', tests: [{ kind: 'http', path: '/' }] }, { vtid: 'VTID-09999' }).ok, false);
  assert.equal(lib.validateManifest({ vtid: 'VTID-09999', service: 'community-app', tests: [{ kind: 'http', path: '/' }] }, { service: 'gateway' }).ok, false);
  assert.equal(ok([]).ok, false);
  assert.equal(lib.validateManifest(null).ok, false);
});

test('planRange: suites run, missing ones fail only after the rule took effect', () => {
  const commits = [
    { sha: 'a1', date: '2026-09-20T10:00:00Z', subject: 'old change (VTID-00001)', files: ['services/gateway/src/a.ts'] },
    { sha: 'b2', date: '2026-09-28T10:00:00Z', subject: 'new change (VTID-00002)', files: ['services/gateway/src/b.ts'] },
    { sha: 'c3', date: '2026-09-28T11:00:00Z', subject: 'tested change (VTID-00003)', files: ['services/gateway/src/c.ts'] },
    { sha: 'd4', date: '2026-09-28T12:00:00Z', subject: 'docs only (VTID-00004)', files: ['docs/x.md'] },
    { sha: 'e5', date: '2026-09-28T13:00:00Z', subject: 'no vtid at all', files: ['services/gateway/src/e.ts'] },
  ];
  const manifests = {
    'VTID-00001': null,
    'VTID-00002': null,
    'VTID-00003': { vtid: 'VTID-00003', service: 'gateway', tests: [{ kind: 'http', path: '/alive' }] },
  };
  const plan = lib.planRange({ service: 'gateway', commits, manifests });
  assert.deepEqual(plan.suites.map((s) => s.vtid), ['VTID-00003']);
  assert.deepEqual(plan.legacy.map((m) => m.vtid), ['VTID-00001']);
  assert.deepEqual(plan.missing.map((m) => m.sha), ['b2', 'e5']);
  assert.equal(plan.relevant.length, 4, 'the docs-only commit is not part of the gateway build');
});

test('planRange: an invalid manifest is reported, not run', () => {
  const plan = lib.planRange({
    service: 'gateway',
    commits: [{ sha: 'x', date: '2026-09-28T00:00:00Z', subject: 'c (VTID-00005)', files: ['services/gateway/src/x.ts'] }],
    manifests: { 'VTID-00005': { vtid: 'VTID-00005', service: 'gateway', tests: [{ kind: 'http', method: 'POST', path: '/x' }] } },
  });
  assert.equal(plan.suites.length, 0);
  assert.equal(plan.invalid.length, 1);
});

test('live commit matching', () => {
  const sha = '2cd002b2f7d6dba97fdb02b3549cda2f41b951ec';
  assert.equal(lib.commitMatches('gateway', sha, sha), true);
  assert.equal(lib.commitMatches('gateway', sha.slice(0, 12), sha), false, 'gateway reports the full sha');
  assert.equal(lib.commitMatches('community-app', sha.slice(0, 12), sha), true);
  assert.equal(lib.commitMatches('community-app', 'deadbeefdead', sha), false);
  assert.equal(lib.commitMatches('community-app', null, sha), false);
  assert.equal(lib.parseFrontendVersion('<meta name="vitana-app-version" content="62498e6fe3e9" />'), '62498e6fe3e9');
  assert.equal(lib.parseFrontendVersion('<meta name="vitana-app-version" content="local" />'), null);
});

test('evaluateHttp checks status, json type, fields and body', () => {
  const t = { kind: 'http', path: '/api/v1/admin/health', expect_json: { env: 'staging' } };
  assert.equal(lib.evaluateHttp(t, { status: 200, contentType: 'application/json', json: { env: 'staging' } }).ok, true);
  assert.equal(lib.evaluateHttp(t, { status: 200, contentType: 'application/json', json: { env: 'production' } }).ok, false);
  assert.equal(lib.evaluateHttp(t, { status: 404, contentType: 'text/html', body: 'Cannot GET' }).ok, false);
  const page = { kind: 'http', target: 'frontend', path: '/', expect_body_contains: ['<div id="root"'] };
  assert.equal(lib.evaluateHttp(page, { status: 200, contentType: 'text/html', body: '<div id="root"></div>' }).ok, true);
});

test('an accepted write probe is flagged loudly', () => {
  const t = { kind: 'http', method: 'POST', path: '/api/v1/x', rejected_probe: true, expect_status: 401 };
  const r = lib.evaluateHttp(t, { status: 201, contentType: 'application/json', json: {} });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /WRITE PROBE WAS ACCEPTED/);
});

test('outcome: superseded beats everything, missing suites fail', () => {
  const plan = { missing: [], invalid: [], suites: [], legacy: [] };
  assert.equal(lib.decideOutcome({ superseded: true, results: [{ ok: false }], plan }), 'superseded');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: true }], plan }), 'passed');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: false }], plan }), 'failed');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: true }], plan: { ...plan, missing: [{}] } }), 'failed');
});

test('ready message asks the question only on a pass and lists what ships', () => {
  const base = {
    service: 'gateway',
    sha: '2cd002b2f7d6dba97fdb02b3549cda2f41b951ec',
    results: [{ suite: 'smoke', name: 'alive', ok: true, problems: [] }],
    plan: { suites: [], missing: [], invalid: [], legacy: [] },
    shipping: [{ sha: '1599333b2eaf0000000000000000000000000000', subject: 'x (VTID-04598)', author: 'a' }],
    prodStamp: '9ec2c64037afd76ce86e274894ba0af1ef135ba3',
  };
  const passed = lib.buildReadyMessage({ ...base, outcome: 'passed' });
  assert.match(passed, /ready for deployment to production\?/);
  assert.match(passed, /1599333b2eaf VTID-04598|`1599333b2eaf` VTID-04598/);
  assert.match(passed, /9ec2c64037af/);
  const failed = lib.buildReadyMessage({ ...base, outcome: 'failed', results: [{ suite: 'smoke', name: 'alive', ok: false, problems: ['status 500'] }] });
  assert.doesNotMatch(failed, /ready for deployment to production\?/);
  assert.match(failed, /FAILED/);
  assert.match(failed, /status 500/);
});

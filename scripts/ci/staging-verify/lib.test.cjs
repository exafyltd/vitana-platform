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
  for (const u of ['https://VITANALAND.COM', 'https://vitanaland.com:8443/x', 'https://vitanaland.com./', 'https://gateway.vitanaland.com?x=1']) {
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

test('existing suites may set only allowlisted, non-production env (staging-verify-runner-fix)', () => {
  const base = { kind: 'existing', ref: 'npm run bundle', cwd: 'apps/mobile', reason: 'the native bundle still builds' };
  assert.equal(ok([{ ...base, env: { APP_PROFILE: 'development' } }]).ok, true);
  assert.equal(ok([{ ...base, env: { APP_PROFILE: 'test-g1' } }]).ok, true);
  assert.equal(ok([{ ...base, env: { APP_PROFILE: 'production' } }]).ok, false);
  assert.equal(ok([{ ...base, env: { APP_PROFILE: 'development', GITHUB_TOKEN: 'x' } }]).ok, false);
  assert.equal(ok([{ ...base, env: { NODE_OPTIONS: '--require=/tmp/x.js' } }]).ok, false);
  assert.equal(ok([{ ...base, env: ['APP_PROFILE=development'] }]).ok, false);
  assert.equal(ok([{ ...base, env: 'APP_PROFILE=development' }]).ok, false);
  assert.deepEqual(lib.existingEnv({ ...base, env: { APP_PROFILE: 'development' } }), { APP_PROFILE: 'development' });
  assert.deepEqual(lib.existingEnv(base), {});
  assert.deepEqual(lib.existingEnv({ ...base, env: { APP_PROFILE: 'production' } }), {});
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

test('VTID-05236: commit-coverage maps a no-VTID commit onto a covering suite', () => {
  const SHA = 'a'.repeat(40);
  const { coverage, errors } = lib.parseCommitCoverage({
    covers: [
      { sha: SHA, vtid: 'VTID-00007', reason: 'covers it', approved_by: 'owner' },
      { sha: 'abc123', vtid: 'VTID-00007', reason: 'r', approved_by: 'o' },
      { sha: 'b'.repeat(40), vtid: 'VTID-00007', reason: '', approved_by: 'o' },
    ],
  });
  assert.deepEqual(coverage, { [SHA]: 'VTID-00007' });
  assert.equal(errors.length, 2, 'short sha and missing reason are rejected');
  const manifests = { 'VTID-00007': { vtid: 'VTID-00007', service: 'gateway', tests: [{ kind: 'http', path: '/alive' }] } };
  const commits = [
    { sha: SHA, date: '2026-10-18T10:00:00Z', subject: 'plan(x): no vtid', files: ['services/gateway/src/a.ts'] },
    { sha: 'c'.repeat(40), date: '2026-10-18T11:00:00Z', subject: 'also no vtid', files: ['services/gateway/src/b.ts'] },
  ];
  const plan = lib.planRange({ service: 'gateway', commits, manifests, coverage });
  assert.deepEqual(plan.suites.map((s) => s.vtid), ['VTID-00007']);
  assert.deepEqual(plan.covered.map((c) => c.sha), [SHA]);
  assert.deepEqual(plan.missing.map((m) => m.sha), ['c'.repeat(40)], 'an uncovered no-VTID commit is still missing');
  // A covering VTID without a suite is still missing, never silently passed.
  const none = lib.planRange({ service: 'gateway', commits: [commits[0]], manifests: { 'VTID-00007': null }, coverage });
  assert.equal(none.missing.length, 1);
  assert.equal(lib.parseCommitCoverage(null).errors.length, 0);
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

test('VTID-05083: a GET/HEAD rejected probe has the invalid bearer and no body', () => {
  for (const method of ['GET', 'HEAD', undefined]) {
    const init = lib.httpRequestInit({ kind: 'http', method, path: '/api/v1/x', rejected_probe: true, expect_status: 401 });
    assert.equal(init.method, method || 'GET');
    assert.equal(init.headers.authorization, 'Bearer staging-verify.invalid.probe');
    assert.equal('body' in init, false);
    assert.equal('content-type' in init.headers, false);
  }
});

test('VTID-05083: a write rejected probe keeps bearer, JSON type and {} body', () => {
  const init = lib.httpRequestInit({ kind: 'http', method: 'post', path: '/api/v1/x', rejected_probe: true, expect_status: 401 });
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer staging-verify.invalid.probe');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.body, '{}');
});

test('VTID-05083: a plain GET carries no authorization header', () => {
  const init = lib.httpRequestInit({ kind: 'http', path: '/alive' });
  assert.deepEqual(init, { method: 'GET', headers: { accept: 'application/json, text/html;q=0.9' } });
});

test('VTID-05083: an accepted read probe is flagged and names the method', () => {
  const t = { kind: 'http', method: 'GET', path: '/api/v1/x', rejected_probe: true, expect_status: 401 };
  const r = lib.evaluateHttp(t, { status: 200, contentType: 'application/json', json: {} });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /REJECTED PROBE WAS ACCEPTED — GET/);
});

// VTID-05144: "superseded beats everything" no more — an ATTRIBUTED failure
// (it ran while staging still served the commit) makes a superseded run failed.
test('outcome: superseded only when no attributed failure, missing suites fail', () => {
  const plan = { missing: [], invalid: [], suites: [], legacy: [] };
  assert.equal(lib.decideOutcome({ superseded: true, results: [{ ok: false }], plan }), 'superseded');
  assert.equal(lib.decideOutcome({ superseded: true, results: [{ ok: false, attributed: true }], plan }), 'failed');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: true }], plan }), 'passed');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: false }], plan }), 'failed');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: true }], plan: { ...plan, missing: [{}] } }), 'failed');
});

test('VTID-05144: superseded + no attributed failure → superseded (never a pass)', () => {
  const plan = { missing: [], invalid: [], suites: [], legacy: [] };
  const results = [{ ok: true, attributed: true }, { ok: true, attributed: false }];
  assert.equal(lib.decideOutcome({ superseded: true, results, plan }), 'superseded');
});

test('VTID-05144: superseded + an attributed failure → failed (a real failure is never hidden)', () => {
  const plan = { missing: [], invalid: [], suites: [], legacy: [] };
  const results = [{ ok: true, attributed: true }, { ok: false, attributed: true }, { ok: false, attributed: false }];
  assert.equal(lib.decideOutcome({ superseded: true, results, plan }), 'failed');
});

test('VTID-05144: superseded + only unattributed failures → superseded', () => {
  const plan = { missing: [], invalid: [], suites: [], legacy: [] };
  const results = [{ ok: true, attributed: true }, { ok: false, attributed: false }, { ok: false, attributed: false }];
  assert.equal(lib.decideOutcome({ superseded: true, results, plan }), 'superseded');
});

test('VTID-05144: not superseded is unchanged — every failure counts, attributed or not', () => {
  const plan = { missing: [], invalid: [], suites: [], legacy: [] };
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: false, attributed: false }], plan }), 'failed');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: true, attributed: false }], plan }), 'passed');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: true }], plan: { ...plan, invalid: [{}] } }), 'failed');
});

test('VTID-05144: attributeResults — ended before T_cut or static; the boundary is not attributed', () => {
  const tCut = Date.parse('2026-10-13T07:17:00.000Z');
  const rows = [
    { name: 'early', ok: true, ended_at: '2026-10-13T07:16:59.999Z' },
    { name: 'boundary', ok: false, ended_at: '2026-10-13T07:17:00.000Z' },
    { name: 'late', ok: false, ended_at: '2026-10-13T07:20:00.000Z' },
    { name: 'static', ok: false, static: true },
    { name: 'no end time', ok: false },
  ];
  const out = lib.attributeResults(rows, tCut);
  assert.deepEqual(out.map((r) => [r.name, r.attributed]), [['early', true], ['boundary', false], ['late', false], ['static', true], ['no end time', false]]);
  assert.equal(out[0].ended_at, rows[0].ended_at, 'rows keep their fields');
  assert.equal('attributed' in rows[0], false, 'input rows are not mutated');
  // An ISO cutoff is accepted too.
  assert.equal(lib.attributeResults([{ ok: true, ended_at: '2026-10-13T07:00:00Z' }], '2026-10-13T07:17:00Z')[0].attributed, true);
});

test('VTID-05144: deployCutoff — earliest relevant deploy run, clamped to runStart', () => {
  const runStart = Date.parse('2026-10-13T07:14:00.000Z');
  const iso = (m) => new Date(runStart + m * 60_000).toISOString();
  // A deploy created 3 min into the run.
  assert.equal(lib.deployCutoff([{ created_at: iso(3), updated_at: iso(9), status: 'completed', conclusion: 'success' }], runStart), runStart + 3 * 60_000);
  // Earliest of several; failed/cancelled count (they may have rolled tasks).
  assert.equal(lib.deployCutoff([
    { created_at: iso(20), updated_at: iso(26), status: 'completed', conclusion: 'success' },
    { created_at: iso(8), updated_at: iso(10), status: 'completed', conclusion: 'failure' },
    { created_at: iso(12), updated_at: iso(13), status: 'completed', conclusion: 'cancelled' },
  ], runStart), runStart + 8 * 60_000);
});

test('VTID-05144: deployCutoff — skipped and completed-before-runStart-minus-5-min runs are excluded', () => {
  const runStart = Date.parse('2026-10-13T07:14:00.000Z');
  const iso = (m) => new Date(runStart + m * 60_000).toISOString();
  const later = { created_at: iso(10), updated_at: iso(16), status: 'completed', conclusion: 'success' };
  assert.equal(lib.deployCutoff([{ created_at: iso(2), updated_at: iso(2), status: 'completed', conclusion: 'skipped' }, later], runStart), runStart + 10 * 60_000);
  assert.equal(lib.deployCutoff([{ created_at: iso(-30), updated_at: iso(-6), status: 'completed', conclusion: 'success' }, later], runStart), runStart + 10 * 60_000);
  // Completed 4 min before the run: its rollout may still be draining → counts, clamped to runStart.
  assert.equal(lib.deployCutoff([{ created_at: iso(-12), updated_at: iso(-4), status: 'completed', conclusion: 'success' }, later], runStart), runStart);
  // Created more than 6 h before the run → ignored.
  assert.equal(lib.deployCutoff([{ created_at: iso(-7 * 60), updated_at: iso(1), status: 'in_progress', conclusion: null }, later], runStart), runStart + 10 * 60_000);
});

test('VTID-05144: deployCutoff — a deploy in progress at run start → runStart', () => {
  const runStart = Date.parse('2026-10-13T07:14:00.000Z');
  const iso = (m) => new Date(runStart + m * 60_000).toISOString();
  assert.equal(lib.deployCutoff([{ created_at: iso(-2), updated_at: iso(-1), status: 'in_progress', conclusion: null }], runStart), runStart);
});

test('VTID-05144: deployCutoff — lookup error or no runs → runStart (fail closed: nothing attributed)', () => {
  const runStart = Date.parse('2026-10-13T07:14:00.000Z');
  assert.equal(lib.deployCutoff(null, runStart), runStart);
  assert.equal(lib.deployCutoff(undefined, runStart), runStart);
  assert.equal(lib.deployCutoff([], runStart), runStart);
  assert.equal(lib.deployCutoff('{"message":"Bad credentials"}', runStart), runStart);
  // The margins are the planned ones.
  assert.equal(lib.DEPLOY_COMPLETED_MARGIN_MS, 5 * 60_000);
  assert.equal(lib.DEPLOY_LOOKBACK_MS, 6 * 60 * 60_000);
});

test('VTID-05144: superseded message names the new stamp, T_cut, attributed counts and unattributed failures', () => {
  const sha = 'a837b4194c0000000000000000000000000000aa';
  const newer = '2541b523a00000000000000000000000000000bb';
  const results = [
    { suite: 'smoke', name: 'alive', ok: true, problems: [], attributed: true },
    { suite: 'VTID-04999', name: 'route', ok: true, problems: [], attributed: true },
    { suite: 'VTID-05000', name: 'late probe', ok: false, problems: ['fetch failed'], attributed: false },
    { suite: 'VTID-05001', name: 'late ok', ok: true, problems: [], attributed: false },
  ];
  const msg = lib.buildReadyMessage({
    service: 'gateway', sha, outcome: 'superseded', results,
    plan: { suites: [], missing: [], invalid: [], legacy: [] }, shipping: [], prodStamp: null,
    supersededBy: newer, attributionCutoff: '2026-10-13T07:17:30.000Z',
  });
  assert.match(msg, /superseded/);
  assert.match(msg, /2541b523a000/);
  assert.match(msg, /Attribution cutoff: 2026-10-13T07:17:30\.000Z/);
  assert.match(msg, /2 passed, 0 failed; not attributed: 2/);
  assert.match(msg, /Not attributed — staging was redeploying:\n- VTID-05000 › late probe: fetch failed/);
  assert.doesNotMatch(msg, /\nFailed:/);
  assert.doesNotMatch(msg, /ready for deployment to production\?/);
});

test('VTID-05144: superseded run with an attributed failure reads as FAILED and lists it under Failed', () => {
  const results = [
    { suite: 'smoke', name: 'alive', ok: false, problems: ['status 500'], attributed: true },
    { suite: 'VTID-05000', name: 'late probe', ok: false, problems: ['fetch failed'], attributed: false },
  ];
  const msg = lib.buildReadyMessage({
    service: 'gateway', sha: 'a'.repeat(40), outcome: 'failed', results,
    plan: { suites: [], missing: [], invalid: [], legacy: [] }, shipping: [], prodStamp: null,
    supersededBy: 'b'.repeat(40), attributionCutoff: '2026-10-13T07:17:30.000Z',
  });
  assert.match(msg, /FAILED/);
  assert.match(msg, /Failed:\n- smoke › alive: status 500/);
  assert.match(msg, /Not attributed — staging was redeploying:\n- VTID-05000 › late probe/);
  assert.match(msg, /0 passed, 1 failed; not attributed: 1/);
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

// VTID-04688: the 2.5 MB Command Hub app.js carries code past the first MB;
// a check for it must see the whole body, not the first 1,000,000 characters.
test('a body check finds code served past the first megabyte', () => {
  const marker = 'function classifyHealthProbe(httpStatus, body)';
  const text = 'x'.repeat(1_197_000) + marker + 'y'.repeat(1_300_000);
  const { body, truncated } = lib.clipBody(text);
  assert.equal(truncated, false);
  const r = lib.evaluateHttp(
    { kind: 'http', path: '/command-hub/app.js?v=1', expect_body_contains: marker },
    { status: 200, contentType: 'application/javascript', body, truncated },
  );
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('the body cap is large enough for every Command Hub asset', () => {
  assert.ok(lib.MAX_HTTP_BODY_CHARS >= 8_000_000, `cap ${lib.MAX_HTTP_BODY_CHARS} is too small`);
});

test('a body past the cap is reported as cut off, not as a plain miss', () => {
  const { body, truncated } = lib.clipBody('a'.repeat(lib.MAX_HTTP_BODY_CHARS + 10) + 'needle');
  assert.equal(truncated, true);
  assert.equal(body.length, lib.MAX_HTTP_BODY_CHARS);
  const r = lib.evaluateHttp({ kind: 'http', path: '/x', expect_body_contains: 'needle' }, { status: 200, contentType: 'text/plain', body, truncated });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /only the first \d+ characters were read/);
});

test('the runner reads response bodies through clipBody, never a fixed slice', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'run.mjs'), 'utf8');
  assert.match(src, /lib\.clipBody\(await res\.text\(\)\)/);
  assert.doesNotMatch(src, /\.text\(\)\)\.slice\(/);
});

// VTID-04715 — the 2026-09-28 case: staging pinned to a4adbbe while
// production already ran 72e8e2f (23 commits later). That is not a
// divergence and must not list a4adbbe as "what would ship".
test('production already past the verified commit is its own failed state', () => {
  const sha = 'a4adbbea580f7389ce00529a675e9a5d59000a1e';
  const prod = '72e8e2f2088cff47479e550a055918fb16948e6b';
  const b = lib.describeBaseline({ sha, prodStamp: prod, prodSha: prod, prodIsAncestor: false, shaIsAncestorOfProd: true });
  assert.equal(b.state, 'ahead');
  assert.equal(b.rangeFrom, null);
  assert.equal(b.check, 'production is behind the verified commit');
  assert.match(b.problem, /production already runs 72e8e2f2088c, which contains a4adbbea580f/);
  assert.match(b.problem, /roll production back/);
  assert.doesNotMatch(b.problem, /diverged/);
});

test('every other baseline state keeps its meaning', () => {
  const sha = 'a'.repeat(40);
  const prod = 'b'.repeat(40);
  assert.deepEqual(lib.describeBaseline({ sha, prodStamp: prod, prodSha: prod, prodIsAncestor: true, shaIsAncestorOfProd: false }), { state: 'behind', rangeFrom: prod, check: null, problem: null });
  assert.deepEqual(lib.describeBaseline({ sha, prodStamp: sha, prodSha: sha, prodIsAncestor: false, shaIsAncestorOfProd: false }), { state: 'same', rangeFrom: null, check: null, problem: null });
  const diverged = lib.describeBaseline({ sha, prodStamp: prod, prodSha: prod, prodIsAncestor: false, shaIsAncestorOfProd: false });
  assert.equal(diverged.state, 'diverged');
  assert.match(diverged.problem, /diverged histories — cannot list what would ship/);
  const unknown = lib.describeBaseline({ sha, prodStamp: null, prodSha: null });
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.problem, /could not be read/);
  const missing = lib.describeBaseline({ sha, prodStamp: 'deadbeef', prodSha: null });
  assert.equal(missing.state, 'missing');
  assert.match(missing.problem, /not in this repository's history/);
  for (const b of [diverged, unknown, missing]) assert.equal(b.check, 'production baseline known');
});

test('VTID-04949: the nightly full run covers every valid suite of the service once', () => {
  const ok = (vtid, service = 'community-app') => ({ vtid, service, tests: [{ kind: 'existing', ref: 'npm run test:gate', reason: 'a valid reason here' }] });
  const manifests = {
    'VTID-00003': ok('VTID-00003'),
    'VTID-00001': ok('VTID-00001'),
    'VTID-00002': ok('VTID-00002', 'gateway'),
    'VTID-00004': { __parseError: 'Unexpected token' },
    'VTID-00005': { vtid: 'VTID-00005', service: 'community-app', tests: [] },
    'VTID-00006': null,
  };
  const r = lib.planFullRun({ service: 'community-app', manifests, alreadyRun: ['VTID-00003'] });
  assert.deepEqual(r.suites.map((s) => s.vtid), ['VTID-00001']);
  assert.deepEqual(r.invalid.map((i) => i.vtid), ['VTID-00004', 'VTID-00005']);
});

// VTID-05075: a pnpm-lock.yaml-only commit has a subject that cannot be fixed
// after the fact (a later "tag" commit does not change it), so it needs no
// change suite of its own — but it is never hidden, and nothing wider is exempt.
const LOCK = 'services/gateway/pnpm-lock.yaml';
const lockCommit = (files, subject = 'chore(gateway): sync pnpm-lock.yaml', extra = {}) => ({ sha: 'l1', date: '2026-10-12T08:00:00Z', subject, files, ...extra });

test('isLockfileOnlyCommit: only pnpm-lock.yaml counts, other files outside the build are ignored', () => {
  assert.equal(lib.isLockfileOnlyCommit([LOCK], 'gateway'), true);
  assert.equal(lib.isLockfileOnlyCommit([LOCK, 'services/gateway/sub/pnpm-lock.yaml'], 'gateway'), true, 'two lockfiles and nothing else');
  assert.equal(lib.isLockfileOnlyCommit([LOCK, 'docs/validation/VTID-05072/outputs/pr-body.md'], 'gateway'), true, 'evidence docs are outside the build');
  assert.equal(lib.isLockfileOnlyCommit([LOCK, 'services/gateway/src/x.ts'], 'gateway'), false, 'a source file makes it an ordinary commit');
  assert.equal(lib.isLockfileOnlyCommit([LOCK, 'services/gateway/package.json'], 'gateway'), false);
  assert.equal(lib.isLockfileOnlyCommit([], 'gateway'), false);
  assert.equal(lib.isLockfileOnlyCommit(['docs/x.md'], 'gateway'), false, 'a docs-only commit is not in the build at all');
  assert.equal(lib.isLockfileOnlyCommit(['package-lock.json'], 'community-app'), false, 'community-app lockfiles are not exempt');
  assert.equal(lib.isLockfileOnlyCommit(['bun.lock'], 'community-app'), false);
});

test('planRange: the real shape of 9358d991 (lockfile + two evidence docs) is lockfile-only, not missing', () => {
  const plan = lib.planRange({
    service: 'gateway',
    commits: [lockCommit([LOCK, 'docs/validation/VTID-05072/outputs/pnpm-lock-update.log', 'docs/validation/VTID-05072/outputs/pr-body.md'], 'chore(gateway): sync pnpm-lock.yaml with acorn 8.15.0 devDependency', { sha: '9358d991' })],
    manifests: {},
  });
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.legacy, []);
  assert.deepEqual(plan.lockfileOnly.map((m) => m.sha), ['9358d991']);
  assert.equal(plan.relevant.length, 1, 'still counted as part of the build');
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: true }], plan }), 'passed');
});

test('planRange: a lockfile commit that also changes source, or any other no-VTID commit, is still missing', () => {
  const plan = lib.planRange({
    service: 'gateway',
    commits: [
      lockCommit([LOCK, 'services/gateway/src/x.ts'], 'chore: lock and code', { sha: 'm1' }),
      { sha: 'm2', date: '2026-10-12T09:00:00Z', subject: 'no vtid at all', files: ['services/gateway/src/y.ts'] },
      lockCommit([LOCK], 'chore: lock only', { sha: 'ok' }),
    ],
    manifests: {},
  });
  assert.deepEqual(plan.missing.map((m) => m.sha), ['m1', 'm2']);
  assert.deepEqual(plan.lockfileOnly.map((m) => m.sha), ['ok']);
  assert.equal(lib.decideOutcome({ superseded: false, results: [{ ok: true }], plan }), 'failed');
});

test('planRange: a lockfile-only commit that names a VTID without a manifest is still reported', () => {
  const plan = lib.planRange({ service: 'gateway', commits: [lockCommit([LOCK], 'chore(VTID-05999): lock', { sha: 'v1' })], manifests: { 'VTID-05999': null } });
  assert.deepEqual(plan.missing.map((m) => m.vtid), ['VTID-05999']);
  assert.deepEqual(plan.lockfileOnly, []);
});

test('planRange: community-app package-lock.json / bun.lock commits without a VTID are still missing', () => {
  const plan = lib.planRange({
    service: 'community-app',
    commits: [
      { sha: 'c1', date: '2026-10-12T08:00:00Z', subject: 'chore: lock', files: ['package-lock.json'] },
      { sha: 'c2', date: '2026-10-12T08:01:00Z', subject: 'chore: bun', files: ['bun.lock'] },
    ],
    manifests: {},
  });
  assert.deepEqual(plan.missing.map((m) => m.sha), ['c1', 'c2']);
  assert.deepEqual(plan.lockfileOnly, []);
});

test('ready message names lockfile-only commits in a passing and in a failing run, and keeps the approval line', () => {
  const base = {
    service: 'gateway',
    sha: 'c6100f8001227c8b4e1e8fd2c148be537b838339',
    results: [{ suite: 'smoke', name: 'alive', ok: true, problems: [] }],
    plan: { suites: [], missing: [], invalid: [], legacy: [], lockfileOnly: [{ sha: '9358d9912074aaaa', subject: 'chore(gateway): sync pnpm-lock.yaml' }] },
    shipping: [],
    prodStamp: 'c69d521d4f02bbbb',
  };
  const passed = lib.buildReadyMessage({ ...base, outcome: 'passed' });
  assert.match(passed, /Lockfile-only changes \(no change suite; smoke tests only\):/);
  assert.match(passed, /`9358d9912074` chore\(gateway\): sync pnpm-lock\.yaml/);
  assert.match(passed, /A "yes" promotes exactly this commit via PUBLISH/);
  const failed = lib.buildReadyMessage({ ...base, outcome: 'failed', plan: { ...base.plan, missing: [{ sha: 'abcdef123456zzzz', subject: 'no vtid', vtid: null }] } });
  assert.match(failed, /Lockfile-only changes/);
  assert.match(failed, /Missing change suite/);
  assert.doesNotMatch(failed, /ready for deployment to production\?/);
  // callers that predate the field keep working
  assert.doesNotMatch(lib.buildReadyMessage({ ...base, outcome: 'passed', plan: { suites: [], missing: [], invalid: [], legacy: [] } }), /Lockfile-only/);
});

test('run.mjs records and logs the lockfile-only commits (audit trail)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'run.mjs'), 'utf8');
  assert.match(src, /lockfile_only: plan\.lockfileOnly/);
  assert.match(src, /lockfileOnly=\$\{plan\.lockfileOnly\.length\}/);
});

// ── VTID-05076: commitsBetween walks the first-parent chain ─────────────────
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-range-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const commit = (rel, text, subject) => { write(rel, text); run(['add', '-A']); run(['commit', '-q', '-m', subject]); return run(['rev-parse', 'HEAD']); };
  run(['init', '-q', '-b', 'main']);
  const base = commit('README.md', 'x', 'VTID-00001: base');
  const git = (args) => { try { return run(args); } catch { return null; } };
  return { dir, run, commit, base, git, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const MANIFEST = { 'VTID-09001': { vtid: 'VTID-09001', service: 'gateway', tests: [{ kind: 'existing', ref: 'npm run test:operator', cwd: 'services/gateway', reason: 'covers the gateway change' }] } };
const AFTER_ENFORCE = (commits) => commits.map((c) => ({ ...c, date: '2099-01-01T00:00:00Z' }));

test('VTID-05076: squash history lists every commit with its own files, as before', () => {
  const r = tempRepo();
  try {
    const a = r.commit('services/gateway/src/a.ts', '1', 'VTID-09001: change a (#1)');
    const b = r.commit('services/gateway/src/b.ts', '1', 'VTID-09001: change b (#2)');
    const got = lib.commitsBetween(r.git, r.base, b);
    assert.deepEqual(got.map((c) => c.sha), [a, b]);
    assert.deepEqual(got.map((c) => c.files), [['services/gateway/src/a.ts'], ['services/gateway/src/b.ts']]);
    assert.deepEqual(got.map((c) => c.branchCommits), [0, 0]);
  } finally { r.cleanup(); }
});

test('VTID-05076: a merge-committed PR is judged by its merge commit; its untagged branch commit is not listed', () => {
  const r = tempRepo();
  try {
    r.run(['checkout', '-q', '-b', 'feature']);
    r.commit('services/gateway/src/x.ts', '1', 'VTID-09001: add x');
    r.commit('services/gateway/package.json', '{}', 'chore(gateway): sync deps');
    r.run(['checkout', '-q', 'main']);
    r.run(['merge', '-q', '--no-ff', '-m', 'VTID-09001: feature (#3)', 'feature']);
    const head = r.run(['rev-parse', 'HEAD']);
    const got = lib.commitsBetween(r.git, r.base, head);
    assert.equal(got.length, 1);
    assert.equal(got[0].sha, head);
    assert.equal(got[0].subject, 'VTID-09001: feature (#3)');
    assert.deepEqual(got[0].files.sort(), ['services/gateway/package.json', 'services/gateway/src/x.ts']);
    assert.equal(got[0].branchCommits, 2);
    const plan = lib.planRange({ service: 'gateway', commits: AFTER_ENFORCE(got), manifests: MANIFEST });
    assert.equal(plan.missing.length, 0);
    assert.deepEqual(plan.suites.map((s) => s.vtid), ['VTID-09001']);
    const msg = lib.buildReadyMessage({ service: 'gateway', sha: head, outcome: 'passed', results: [], plan, shipping: got, prodStamp: r.base, runUrl: 'https://example.invalid/run' });
    assert.match(msg, /VTID-09001: feature \(#3\).*\(2 branch commits\)/);
  } finally { r.cleanup(); }
});

test('VTID-05076: a direct push without a VTID still fails rule 47', () => {
  const r = tempRepo();
  try {
    const c = r.commit('services/gateway/src/y.ts', '1', 'fix gateway thing');
    const got = lib.commitsBetween(r.git, r.base, c);
    const plan = lib.planRange({ service: 'gateway', commits: AFTER_ENFORCE(got), manifests: MANIFEST });
    assert.deepEqual(plan.missing.map((m) => m.sha), [c]);
  } finally { r.cleanup(); }
});

test('VTID-05076: a merge commit whose subject has no VTID fails rule 47', () => {
  const r = tempRepo();
  try {
    r.run(['checkout', '-q', '-b', 'feature']);
    r.commit('services/gateway/src/z.ts', '1', 'VTID-09001: add z');
    r.run(['checkout', '-q', 'main']);
    r.run(['merge', '-q', '--no-ff', '-m', 'Merge branch feature', 'feature']);
    const head = r.run(['rev-parse', 'HEAD']);
    const got = lib.commitsBetween(r.git, r.base, head);
    const plan = lib.planRange({ service: 'gateway', commits: AFTER_ENFORCE(got), manifests: MANIFEST });
    assert.deepEqual(plan.missing.map((m) => m.sha), [head]);
  } finally { r.cleanup(); }
});

test('VTID-05146 (C4): autopilot merges and auto-reverts get their own section in the ready message', () => {
  assert.equal(lib.isAutopilotCommit('Dev Autopilot auto-merge: execution 1a2b3c4d'), true);
  assert.equal(lib.isAutopilotCommit('Revert: auto-fix 1a2b3c4d failed deploy verification'), true);
  assert.equal(lib.isAutopilotCommit('VTID-05146: Dev Autopilot Phase C (#4100)'), false);
  const shipping = [
    { sha: 'aaaaaaaaaaaa1111', subject: 'VTID-05146: Phase C (#4100)', author: 'exafyltd' },
    { sha: 'bbbbbbbbbbbb2222', subject: 'Dev Autopilot auto-merge: execution 1a2b3c4d', author: 'exafyltd' },
    { sha: 'cccccccccccc3333', subject: 'Revert: auto-fix 1a2b3c4d failed deploy verification', author: 'exafyltd' },
  ];
  const msg = lib.buildReadyMessage({
    service: 'gateway', sha: 'cccccccccccc3333', outcome: 'passed', results: [{ ok: true }], plan: { suites: [], missing: [], invalid: [], legacy: [] },
    shipping, prodStamp: 'ffffffffffff', runUrl: 'https://example.invalid/run',
  });
  assert.match(msg, /3 commit\(s\)\):/);
  const [people, autopilot] = msg.split('Dev Autopilot changes in this range (2,');
  assert.ok(autopilot, 'autopilot section present');
  assert.match(people, /VTID-05146: Phase C/);
  assert.doesNotMatch(people, /auto-merge: execution/);
  assert.match(autopilot, /auto-merge: execution 1a2b3c4d/);
  assert.match(autopilot, /Revert: auto-fix 1a2b3c4d/);
  const none = lib.buildReadyMessage({
    service: 'gateway', sha: 'aaaaaaaaaaaa1111', outcome: 'passed', results: [{ ok: true }], plan: { suites: [], missing: [], invalid: [], legacy: [] },
    shipping: shipping.slice(0, 1), prodStamp: 'ffffffffffff', runUrl: '',
  });
  assert.doesNotMatch(none, /Dev Autopilot changes in this range/);
});

// ── VTID-05129 ────────────────────────────────────────────────────────────
const SHA = 'bcae4d0af10b63163b71ca71dde88f22ae07585b';

test('VTID-05129: a dropped stamp sample is unknown, not a mismatch', () => {
  const short = SHA.slice(0, 12);
  assert.deepEqual(lib.evaluateStampSamples('community-app', [short, null, short, short, short], SHA), { state: 'match' });
  assert.deepEqual(lib.evaluateStampSamples('community-app', [short, short, short, short, short], SHA), { state: 'match' });
  assert.deepEqual(lib.evaluateStampSamples('community-app', [short, 'aaaaaaaaaaaa', short], SHA), { state: 'mismatch', other: 'aaaaaaaaaaaa' });
  assert.deepEqual(lib.evaluateStampSamples('community-app', [null, null, null, null, null], SHA), { state: 'unknown' });
  // fewer than half readable is not enough to call it a match
  assert.deepEqual(lib.evaluateStampSamples('community-app', [short, null, null, null, null], SHA), { state: 'unknown' });
  assert.deepEqual(lib.evaluateStampSamples('gateway', [SHA, null, SHA], SHA), { state: 'match' });
});

test('VTID-05129: only dropped connections are retried', () => {
  const net = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  for (const c of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(lib.isRetriableFetchError(net(c)), true, c);
  }
  assert.equal(lib.isRetriableFetchError(net('CERT_HAS_EXPIRED')), false);
  assert.equal(lib.isRetriableFetchError(net('ENOTFOUND')), false);
  assert.equal(lib.isRetriableFetchError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })), false);
  assert.equal(lib.isRetriableFetchError(new DOMException('timeout', 'TimeoutError')), false);
  assert.equal(lib.isRetriableFetchError(null), false);
});

test('VTID-05129: a dropped connection hidden in an AggregateError or a closed socket is retried, and named', () => {
  const net = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
  for (const c of ['UND_ERR_CLOSED', 'UND_ERR_HEADERS_TIMEOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH']) {
    assert.equal(lib.isRetriableFetchError(net({ code: c })), true, c);
  }
  const agg = (codes) => Object.assign(new AggregateError(codes.map((code) => Object.assign(new Error(code), { code }))), {});
  assert.equal(lib.isRetriableFetchError(net(agg(['ENETUNREACH', 'ETIMEDOUT']))), true);
  // one non-transient member (a TLS error) keeps the whole thing a real failure
  assert.equal(lib.isRetriableFetchError(net(agg(['ETIMEDOUT', 'CERT_HAS_EXPIRED']))), false);
  assert.equal(lib.isRetriableFetchError(net(agg([]))), false);
  assert.match(lib.describeFetchError(net(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }))), /fetch failed \(UND_ERR_SOCKET: other side closed\)/);
  assert.match(lib.describeFetchError(net(agg(['ENETUNREACH', 'ETIMEDOUT']))), /\[ENETUNREACH, ETIMEDOUT\]/);
  assert.equal(lib.describeFetchError(new Error('plain')), 'plain');
});

test('VTID-05129: a guard failure keeps the blocked requests in its summary', () => {
  const out = [
    '  ✘  1 tests/e2e/staging/x.staging.spec.ts:3:1 › page (4.8s)',
    '    Error: staging-guard aborted 2 request(s) — staging writes reach production data, and a staging build must not call production:',
    '      POST https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/profile_posts',
    '      PATCH https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/daily_matches?id=eq.1',
    '  1 failed',
  ].join('\n');
  const s = lib.summarizeFailure(out);
  assert.match(s, /staging-guard aborted 2/);
  assert.match(s, /blocked: POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/profile_posts ; PATCH /);
  // other failures are summarised as before
  assert.equal(lib.summarizeFailure('a\n  Error: boom\nb'), 'Error: boom');
  assert.equal(lib.summarizeFailure('GET https://x.example/ only\nError: no guard'), 'Error: no guard');
});

test('VTID-05129: the shared tolerated-abort list is exact, capped and never covers a real write or production', () => {
  assert.ok(lib.DEFAULT_ALLOWED_ABORTS.length <= lib.DEFAULT_ALLOWED_ABORTS_CAP);
  assert.equal(lib.DEFAULT_ALLOWED_ABORTS.length, 10, 'list changed — review each new entry, then update this count');
  const S = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
  const G = 'https://preview-aws-gateway.vitanaland.com';
  for (const ok of [
    `POST ${G}/api/v1/rum/beacon`,
    `POST ${G}/api/v1/analytics/events/batch`,
    `POST ${G}/api/v1/orb/live/session/prewarm`,
    `POST ${S}/rest/v1/thread_presence?on_conflict=user_id`,
    `POST ${S}/rest/v1/rpc/get_role_preference`,
    `POST ${S}/rest/v1/rpc/get_user_profile_by_identifier`,
    `POST ${S}/rest/v1/rpc/health_compute_vitana_index`,
    `POST ${S}/functions/v1/generate-daily-matches`,
    `POST ${S}/functions/v1/list_my_memberships`,
  ]) assert.equal(lib.isToleratedAbort(ok), true, ok);
  for (const bad of [
    `POST ${S}/rest/v1/profile_posts`,
    `PATCH ${S}/rest/v1/daily_matches?id=eq.1`,
    `POST ${S}/rest/v1/rpc/get_role_preference_and_write`,
    `POST ${G}/api/v1/orb/live/session/start`,
    `POST ${G}/api/v1/orb/live/session/prewarm/x`,
    `DELETE ${S}/rest/v1/thread_presence`,
    `POST https://gateway.vitanaland.com/api/v1/rum/beacon (production host)`,
    `POST ${G}/api/v1/rum/beacon (production host)`,
  ]) assert.equal(lib.isToleratedAbort(bad), false, bad);
  // a spec's own allowance still adds to the list
  assert.equal(lib.isToleratedAbort(`PATCH ${S}/rest/v1/daily_matches?id=eq.1`, [/rest\/v1\/daily_matches/]), true);
});

test('VTID-05129: staging-guard.ts mirrors the shared list exactly', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'staging-guard.ts'), 'utf8');
  const block = /const DEFAULT_ALLOWED_ABORTS: RegExp\[\] = \[\n([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, 'DEFAULT_ALLOWED_ABORTS block missing in staging-guard.ts');
  const literals = block[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/^'));
  const fromGuard = literals.map((l) => l.replace(/,$/, ''));
  assert.deepEqual(fromGuard, lib.DEFAULT_ALLOWED_ABORTS.map((r) => r.toString()));
  assert.match(src, /!DEFAULT_ALLOWED_ABORTS\.some\(\(r\) => r\.test\(b\)\) && !allow\.some/);
});
// VTID-05272 (plan kiro-autonomy-fallback §5 H): per-lane attribution of a STAGING-VERIFY run.
test('VTID-05272: summarizeByVtid names the lane whose suite failed', () => {
  const ok = (suite, name = 't') => ({ suite, name, ok: true });
  const bad = (suite, name = 't') => ({ suite, name, ok: false, problems: ['x'] });
  assert.deepEqual(lib.summarizeByVtid([ok('smoke'), ok('VTID-00001'), bad('VTID-00002'), ok('VTID-00002', 'u')]),
    { smoke: 'passed', 'VTID-00001': 'passed', 'VTID-00002': 'failed' });
});
test('VTID-05272: summarizeByVtid fails every VTID when smoke or a deploy row failed', () => {
  assert.deepEqual(lib.summarizeByVtid([bad0('smoke'), { suite: 'VTID-00001', name: 't', ok: true }], ['VTID-00002']),
    { smoke: 'failed', 'VTID-00001': 'failed', 'VTID-00002': 'failed' });
  assert.deepEqual(lib.summarizeByVtid([{ suite: 'smoke', name: 's', ok: true }, { ...bad0('deploy'), static: true }, { suite: 'VTID-00001', name: 't', ok: true }]),
    { smoke: 'failed', 'VTID-00001': 'failed' });
  function bad0(suite) { return { suite, name: 'x', ok: false, problems: ['down'] }; }
});
test('VTID-05272: summarizeByVtid marks unattributed suites and leaves the outcome rule alone', () => {
  const results = [
    { suite: 'smoke', name: 's', ok: true },
    { suite: 'VTID-00001', name: 'late', ok: false, problems: ['x'], attributed: false },
  ];
  assert.deepEqual(lib.summarizeByVtid(results, ['VTID-00001', 'VTID-00003', 'not-a-vtid']),
    { smoke: 'passed', 'VTID-00001': 'not_attributed', 'VTID-00003': 'not_attributed' });
  assert.deepEqual(lib.summarizeByVtid([], []), { smoke: 'not_run' });
  // decideOutcome is untouched: a failed row still fails a non-superseded run.
  assert.equal(lib.decideOutcome({ superseded: false, results, plan: { missing: [], invalid: [] } }), 'failed');
});
test('VTID-05272: run.mjs writes record.per_vtid from summarizeByVtid', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'run.mjs'), 'utf8');
  assert.match(src, /per_vtid: lib\.summarizeByVtid\(results, /);
  assert.match(src, /const outcome = lib\.decideOutcome\(\{ superseded, results, plan \}\);/);
});

// quality-checks/staging-manifest-bom: eight vitana-v1 commits (e.g. 36d702bfd) only removed a UTF-8 BOM that made
// STAGING-VERIFY reject a valid staging-tests.json as invalid JSON. The manifest reader removes one leading BOM.
test('quality-checks: parseJsonText reads a manifest with a leading UTF-8 BOM as the same object', () => {
  const text = JSON.stringify({ vtid: 'VTID-00001', service: 'community-app', tests: [{ kind: 'http', url: '/alive' }] });
  assert.deepEqual(lib.parseJsonText('\uFEFF' + text), JSON.parse(text));
  assert.deepEqual(lib.parseJsonText(text), JSON.parse(text));
});

test('quality-checks: parseJsonText still rejects invalid JSON, empty input and a BOM that is not leading', () => {
  assert.throws(() => lib.parseJsonText('\uFEFF{"a":'), SyntaxError);
  assert.throws(() => lib.parseJsonText(''), SyntaxError);
  assert.throws(() => lib.parseJsonText('\uFEFF'), SyntaxError);
  assert.throws(() => lib.parseJsonText('\uFEFF\uFEFF{}'), SyntaxError);
  assert.throws(() => lib.parseJsonText('{"a":1}\uFEFF'), SyntaxError);
});

test('quality-checks: a commit-coverage.json with a leading BOM gives the same coverage as without', () => {
  const sha = 'a'.repeat(40);
  const text = JSON.stringify({ covers: [{ sha, vtid: 'VTID-00001', reason: 'merge commit without a VTID', approved_by: 'owner' }] });
  const withBom = lib.parseCommitCoverage(lib.parseJsonText('\uFEFF' + text));
  assert.deepEqual(withBom, { coverage: { [sha]: 'VTID-00001' }, errors: [] });
  assert.deepEqual(withBom, lib.parseCommitCoverage(JSON.parse(text)));
});

test('quality-checks: run.mjs loadManifest reads a BOM staging-tests.json from disk and still flags invalid JSON', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadManifest } = await import('./run.mjs');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qc-bom-'));
  const write = (vtid, text) => {
    fs.mkdirSync(path.join(root, 'docs', 'validation', vtid), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'validation', vtid, 'staging-tests.json'), text, 'utf8');
  };
  const manifest = { vtid: 'VTID-00001', service: 'community-app', tests: [] };
  write('VTID-00001', '\uFEFF' + JSON.stringify(manifest));
  write('VTID-00002', '{"vtid":');
  try {
    assert.deepEqual(loadManifest(root, 'VTID-00001'), manifest);
    assert.equal(typeof loadManifest(root, 'VTID-00002').__parseError, 'string');
    assert.equal(loadManifest(root, 'VTID-00003'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

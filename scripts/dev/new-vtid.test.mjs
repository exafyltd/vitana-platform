// VTID-05800 — scripts/dev/new-vtid.mjs: one command allocates a VTID from anywhere. Run: node --test scripts/dev/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, gatewayList, requestBody, requestHeaders, allocateOnGateway, allocateViaWorkflow, allocateVtid, main,
  STAGING_GATEWAY, PRODUCTION_GATEWAY,
} from './new-vtid.mjs';

const reply = (status, json) => async () => ({ status, json: async () => json });

test('every argument is optional; the title may be positional words', () => {
  assert.deepEqual(parseArgs([]), { title: '', module: 'TASK', layer: 'DEV', source: 'cli', gateway: '', json: false, workflow: true });
  const o = parseArgs(['Gateway:', 'fix', 'the', 'thing', '--module', 'GW', '--json']);
  assert.equal(o.title, 'Gateway: fix the thing');
  assert.equal(o.module, 'GW');
  assert.equal(o.json, true);
  assert.throws(() => parseArgs(['--module']), /needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('gateways: explicit first, then env, then staging and production, no duplicates', () => {
  assert.deepEqual(gatewayList({ gateway: '' }, {}), [STAGING_GATEWAY, PRODUCTION_GATEWAY]);
  assert.deepEqual(gatewayList({ gateway: 'https://x.test/' }, { VTID_GATEWAY_URL: STAGING_GATEWAY }), ['https://x.test', STAGING_GATEWAY, PRODUCTION_GATEWAY]);
});

test('no credential is needed; one is sent only when it is set', () => {
  assert.deepEqual(requestHeaders({}), { 'Content-Type': 'application/json' });
  const h = requestHeaders({ GATEWAY_SERVICE_TOKEN: 'tok', VTID_ALLOC_SECRET: 'sec' });
  assert.equal(h.Authorization, 'Bearer tok');
  assert.equal(h['X-VTID-Alloc-Secret'], 'sec');
  assert.deepEqual(requestBody({ title: '  ', module: 'TASK', layer: 'DEV', source: 'cli' }), { source: 'cli', layer: 'DEV', module: 'TASK' });
  assert.equal(requestBody({ title: 'A: b', source: 'cli' }).title, 'A: b');
});

test('a gateway that allocates wins; anything else is a reason, never a throw', async () => {
  assert.deepEqual(await allocateOnGateway('https://g', {}, { fetchImpl: reply(201, { ok: true, vtid: 'VTID-05801' }) }), { ok: true, vtid: 'VTID-05801' });
  assert.deepEqual(await allocateOnGateway('https://g', {}, { fetchImpl: reply(401, { ok: false, error: 'missing bearer token' }) }), { ok: false, reason: 'HTTP 401 missing bearer token' });
  assert.equal((await allocateOnGateway('https://g', {}, { fetchImpl: reply(201, { ok: true, vtid: 'nope' }) })).ok, false);
  const boom = await allocateOnGateway('https://g', {}, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(boom, { ok: false, reason: 'ECONNREFUSED' });
});

test('falls through to the next gateway, sending the token to each', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.Authorization]);
    return url.startsWith(STAGING_GATEWAY)
      ? { status: 401, json: async () => ({ ok: false, error: 'missing bearer token' }) }
      : { status: 201, json: async () => ({ ok: true, vtid: 'VTID-05802' }) };
  };
  const r = await allocateVtid({ title: 't', workflow: false }, { fetchImpl, env: { GATEWAY_SERVICE_TOKEN: 'tok' } });
  assert.equal(r.ok, true);
  assert.equal(r.vtid, 'VTID-05802');
  assert.equal(r.via, PRODUCTION_GATEWAY);
  assert.deepEqual(seen.map((s) => s[1]), ['Bearer tok', 'Bearer tok']);
});

test('when no gateway allocates, the VTID-ALLOCATE workflow does, matched by its request id', async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args.includes('-X')) return '';
    if (args[0] === 'api') {
      return JSON.stringify({ workflow_runs: [
        { id: 7, display_title: 'VTID-ALLOCATE other', status: 'completed', conclusion: 'success', created_at: new Date().toISOString() },
        { id: 8, display_title: 'VTID-ALLOCATE req-1', status: 'completed', conclusion: 'success', created_at: new Date().toISOString() },
      ] });
    }
    return 'allocate\tAllocate VTID\t2026-11-15T08:00:00Z VTID_RESULT=VTID-05803\n';
  };
  const r = await allocateVtid({ title: 't' }, { fetchImpl: reply(503, { ok: false }), env: {}, gh, sleep: async () => {}, requestId: 'req-1' });
  assert.equal(r.ok, true);
  assert.equal(r.vtid, 'VTID-05803');
  assert.match(r.via, /run 8/);
  assert.ok(calls[0].includes('inputs[request_id]=req-1'));
  assert.ok(calls.some((c) => c.startsWith('run view 8 ')));
});

test('a failed workflow run is reported, and main exits 1 without a VTID', async () => {
  const gh = (args) => (args.includes('-X') ? '' : args[0] === 'api'
    ? JSON.stringify({ workflow_runs: [{ id: 9, display_title: 'VTID-ALLOCATE req-2', status: 'completed', conclusion: 'failure', created_at: new Date().toISOString() }] })
    : '');
  const w = await allocateViaWorkflow({}, { gh, sleep: async () => {}, requestId: 'req-2' });
  assert.deepEqual(w, { ok: false, reason: 'workflow run 9 ended failure' });
  const errors = [];
  const origError = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.equal(await main(['--no-workflow'], { fetchImpl: reply(500, {}), env: {} }), 1);
  } finally {
    console.error = origError;
  }
  assert.match(errors.join('\n'), /no VTID allocated/);
  assert.equal(await main(['--bad']), 2);
});

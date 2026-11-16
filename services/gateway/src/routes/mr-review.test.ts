// MOCK-ONLY route test: a fake router records the registration; no Express, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMrReviewRouter, callerAuthorizer } from './mr-review';

const TOKEN = 'x'.repeat(40);

function fakeRouter() {
  const routes: Record<string, (req: any, res: any) => Promise<void>> = {};
  return { routes, post(path: string, h: (req: any, res: any) => Promise<void>) { routes[path] = h; return this; } };
}
function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  return { out, status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
}

test('the route registers POST /mr-review on the injected router', () => {
  const r = fakeRouter();
  createMrReviewRouter(() => r, () => null);
  assert.ok(r.routes['/mr-review']);
});

test('unconfigured: the route answers 503, it does not guess', async () => {
  const r = fakeRouter();
  createMrReviewRouter(() => r, () => null);
  const res = fakeRes();
  await r.routes['/mr-review']({ headers: {}, body: {} }, res);
  assert.equal(res.out.status, 503);
});

test('configured: the handler result is returned as-is (401 without credentials)', async () => {
  const r = fakeRouter();
  const deps: any = { authorize: () => false, readerFor: () => ({}), runPass: async () => ({ ok: true, review: { summary: '', findings: [] } }), signer: {}, project: 'p', reviewer: 'r', model: 'm', now: () => new Date() };
  createMrReviewRouter(() => r, () => deps);
  const res = fakeRes();
  await r.routes['/mr-review']({ headers: {}, body: { mr_iid: 1, expected_head_sha: 'a'.repeat(40) } }, res);
  assert.equal(res.out.status, 401);
});

test('a thrown error becomes 502 with no detail leaked', async () => {
  const r = fakeRouter();
  const deps: any = { authorize: () => true, readerFor: () => { throw new Error('secret internal detail'); }, runPass: async () => ({ ok: true, review: { summary: '', findings: [] } }), signer: {}, project: 'p', reviewer: 'r', model: 'm', now: () => new Date() };
  createMrReviewRouter(() => r, () => deps);
  const res = fakeRes();
  await r.routes['/mr-review']({ headers: { authorization: 'Bearer z' }, body: { mr_iid: 1, expected_head_sha: 'a'.repeat(40) } }, res);
  assert.equal(res.out.status, 502);
  assert.equal(JSON.stringify(res.out.body).includes('secret'), false);
});

test('caller authorizer: unset or short credential refuses everything', () => {
  assert.equal(callerAuthorizer(undefined)('Bearer ' + TOKEN), false);
  assert.equal(callerAuthorizer('short')('Bearer short'), false);
});

test('caller authorizer: exact bearer only; other schemes and wrong tokens are refused', () => {
  const auth = callerAuthorizer(TOKEN);
  assert.equal(auth(`Bearer ${TOKEN}`), true);
  assert.equal(auth(`bearer ${TOKEN}`), true);
  assert.equal(auth(`Bearer ${'y'.repeat(40)}`), false);
  assert.equal(auth(`Basic ${TOKEN}`), false);
  assert.equal(auth(undefined), false);
  assert.equal(auth(`Bearer ${TOKEN}x`), false);
});

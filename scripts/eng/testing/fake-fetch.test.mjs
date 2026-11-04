// Tests of the recording fake fetch (plan eng-gitlab-m2 §3.7, lane gitlab-client).
// The fake is the base of every other lane's tests, so its own behaviour is pinned here: what it records, how a route is
// chosen, what an unmatched or exhausted call does, and how it fails on purpose (hang, network error).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from './fake-fetch.mjs';

const API = 'https://gitlab.test/api/v4';

test('records method, url, path, query, lower-cased headers and a parsed JSON body', async () => {
  const f = fakeFetch().route('POST', '/api/v4/x', { status: 201, json: { id: 1 } });
  const res = await f(`${API}/x?a=1&b[]=2&b[]=3`, {
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': 'tok', 'Content-Type': 'application/json' },
    body: '{"k":"v"}',
    redirect: 'manual',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: 1 });
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.n, 0);
  assert.equal(c.method, 'POST');
  assert.equal(c.url, `${API}/x?a=1&b[]=2&b[]=3`);
  assert.equal(c.path, '/api/v4/x');
  assert.deepEqual(c.query, { a: ['1'], 'b[]': ['2', '3'] });
  assert.equal(c.headers['private-token'], 'tok');
  assert.deepEqual(c.body, { k: 'v' });
  assert.equal(c.redirect, 'manual', 'the redirect mode is recorded so a client test can assert it');
});

test('method defaults to GET; a non-JSON body is kept as text; no body is undefined', async () => {
  const f = fakeFetch().route('GET', '/api/v4/a', { json: [] }).route('PUT', '/api/v4/b', { status: 204 });
  await f(`${API}/a`);
  await f(`${API}/b`, { method: 'put', body: 'plain text' });
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].body, undefined);
  assert.equal(f.calls[1].method, 'PUT');
  assert.equal(f.calls[1].body, 'plain text');
});

test('route match by exact path, by RegExp and by function; the query of the URL is not part of the path', async () => {
  const f = fakeFetch()
    .route('GET', '/api/v4/exact', { json: 'exact' })
    .route('GET', /^\/api\/v4\/projects\/\d+\/jobs$/, { json: 'regex' })
    .route('GET', (call) => call.path.endsWith('/fn') && call.query.flag?.[0] === 'yes', { json: 'fn' });
  assert.equal(await (await f(`${API}/exact?x=1`)).json(), 'exact');
  assert.equal(await (await f(`${API}/projects/7/jobs`)).json(), 'regex');
  assert.equal(await (await f(`${API}/anything/fn?flag=yes`)).json(), 'fn');
  await assert.rejects(f(`${API}/anything/fn?flag=no`), /no route for GET \/api\/v4\/anything\/fn/);
});

test('a route can require a subset of the query; the method must match too', async () => {
  const f = fakeFetch()
    .route('GET', '/api/v4/items', { json: ['page1'] }, { query: { page: '1' } })
    .route('GET', '/api/v4/items', { json: ['page2'] }, { query: { page: '2', per_page: '100' } });
  assert.deepEqual(await (await f(`${API}/items?page=1&per_page=100`)).json(), ['page1']);
  assert.deepEqual(await (await f(`${API}/items?per_page=100&page=2`)).json(), ['page2']);
  await assert.rejects(f(`${API}/items?page=3`), /no route/);
  await assert.rejects(f(`${API}/items?page=1`, { method: 'POST' }), /no route for POST/);
});

test('the most recently registered matching route wins, so a test can override a default', async () => {
  const f = fakeFetch().route('GET', '/api/v4/u', { json: 'default' });
  assert.equal(await (await f(`${API}/u`)).json(), 'default');
  f.route('GET', '/api/v4/u', { json: 'override' });
  assert.equal(await (await f(`${API}/u`)).json(), 'override');
});

test('a response can be a function of the call', async () => {
  const f = fakeFetch().route('POST', '/api/v4/echo', (call) => ({ status: 201, json: { got: call.body, n: call.n } }));
  const res = await f(`${API}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.deepEqual(await res.json(), { got: { a: 1 }, n: 0 });
});

test('a sequence answers in order and an exhausted sequence fails loudly instead of repeating', async () => {
  const f = fakeFetch().route('GET', '/api/v4/s', [{ status: 503 }, { status: 429, headers: { 'Retry-After': '2' } }, { json: { ok: true } }]);
  assert.equal((await f(`${API}/s`)).status, 503);
  const second = await f(`${API}/s`);
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('retry-after'), '2');
  assert.deepEqual(await (await f(`${API}/s`)).json(), { ok: true });
  await assert.rejects(f(`${API}/s`), /exhausted after 3 calls/);
});

test('a sequence can end with a response that repeats', async () => {
  const f = fakeFetch().route('GET', '/api/v4/s', [{ status: 500 }, { json: 'fine' }], { repeatLast: true });
  assert.equal((await f(`${API}/s`)).status, 500);
  for (let i = 0; i < 3; i++) assert.equal(await (await f(`${API}/s`)).json(), 'fine');
});

test('an unmatched call throws an error that names the method and path; lenient mode answers 404 JSON', async () => {
  const strict = fakeFetch();
  await assert.rejects(strict(`${API}/nope`, { method: 'DELETE' }), (e) => e.name === 'FakeFetchError' && /no route for DELETE \/api\/v4\/nope/.test(e.message));
  assert.equal(strict.calls.length, 1, 'the unmatched call is still recorded');
  const lenient = fakeFetch({ strict: false });
  const res = await lenient(`${API}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { message: '404 Not Found (fake)' });
});

test('response helpers: json sets the content type, text, empty 204 has no body, headers are readable', async () => {
  const f = fakeFetch()
    .route('GET', '/api/v4/j', { json: { a: 1 } })
    .route('GET', '/api/v4/t', { text: 'hello', headers: { 'content-type': 'text/plain' } })
    .route('DELETE', '/api/v4/n', { status: 204 })
    .route('GET', '/api/v4/h', { json: [], headers: { 'X-Next-Page': '' , 'X-Total': '0' } });
  const j = await f(`${API}/j`);
  assert.match(j.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await j.json(), { a: 1 });
  assert.equal(await (await f(`${API}/t`)).text(), 'hello');
  const n = await f(`${API}/n`, { method: 'DELETE' });
  assert.equal(n.status, 204);
  assert.equal(await n.text(), '');
  const h = await f(`${API}/h`);
  assert.equal(h.headers.get('x-total'), '0');
  assert.equal(h.headers.get('x-next-page'), '');
});

test('a status that cannot carry a body is answered without one even if the spec has json or text', async () => {
  const f = fakeFetch().route('DELETE', '/api/v4/n', { status: 204, json: { ignored: true } }).route('GET', '/api/v4/m', { status: 304, text: 'ignored' });
  const a = await f(`${API}/n`, { method: 'DELETE' });
  assert.equal(a.status, 204);
  assert.equal(await a.text(), '');
  const b = await f(`${API}/m`);
  assert.equal(b.status, 304);
  assert.equal(await b.text(), '');
});

test('writes() lists the calls that are not GET or HEAD; mark() and since() look at part of the history', async () => {
  const f = fakeFetch().route('GET', '/api/v4/r', { json: 1 }).route('PUT', '/api/v4/w', { json: 1 }).route('POST', '/api/v4/w', { json: 1 });
  await f(`${API}/r`);
  const m = f.mark();
  assert.equal(m, 1);
  await f(`${API}/r`);
  f.assertNoWrites(m);
  await f(`${API}/w`, { method: 'PUT' });
  await f(`${API}/w`, { method: 'POST' });
  await f(`${API}/r`, { method: 'HEAD' }).catch(() => {});
  assert.deepEqual(f.writes().map((c) => c.method), ['PUT', 'POST']);
  assert.deepEqual(f.since(m).map((c) => `${c.method} ${c.path}`), ['GET /api/v4/r', 'PUT /api/v4/w', 'POST /api/v4/w', 'HEAD /api/v4/r']);
  assert.throws(() => f.assertNoWrites(m), /2 write call\(s\) since call 1: PUT \/api\/v4\/w, POST \/api\/v4\/w/);
  assert.deepEqual(f.writes(f.mark()), []);
});

test('hang never answers until the abort signal fires, then rejects with an AbortError', async () => {
  const f = fakeFetch().route('GET', '/api/v4/slow', { hang: true });
  const ac = new AbortController();
  const p = f(`${API}/slow`, { signal: ac.signal });
  let settled = false;
  p.catch(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(settled, false, 'still waiting');
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const already = new AbortController();
  already.abort();
  await assert.rejects(f(`${API}/slow`, { signal: already.signal }), (e) => e.name === 'AbortError');
});

test('networkError rejects like Node fetch does: a TypeError whose cause carries the code', async () => {
  const f = fakeFetch().route('GET', '/api/v4/down', { networkError: 'ECONNRESET' });
  await assert.rejects(f(`${API}/down`), (e) => e instanceof TypeError && e.message === 'fetch failed' && e.cause.code === 'ECONNRESET');
});

test('reset() clears calls and routes; the fake is a plain function usable as the fetch of any client', async () => {
  const f = fakeFetch().route('GET', '/api/v4/a', { json: 1 });
  await f(`${API}/a`);
  f.reset();
  assert.equal(f.calls.length, 0);
  await assert.rejects(f(`${API}/a`), /no route/);
  assert.equal(typeof f, 'function');
  assert.equal(f.route('GET', '/api/v4/a', { json: 2 }), f, 'route() chains');
});

test('input may be a URL object or a Request-like with a url property', async () => {
  const f = fakeFetch().route('GET', '/api/v4/u', { json: 'u' });
  assert.equal(await (await f(new URL(`${API}/u`))).json(), 'u');
  assert.equal(await (await f({ url: `${API}/u` })).json(), 'u');
  assert.equal(f.calls.length, 2);
});

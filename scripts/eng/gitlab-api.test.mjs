// Tests of the GitLab API client (plan eng-gitlab-m2 §3.7, lane gitlab-client).
// Every test runs against the recording fake fetch: no network, no token, no real waiting (sleep is injected; only the
// timeout tests use a real 20 ms timer). The properties pinned here are the ones the settings sync, the merge bot, the
// metrics job and the rehearsal rely on: pagination, retry that never repeats a write by accident, errors that carry
// status, method and path, and a token that is sent to one origin only and appears in no error, log line or message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, GitLabApiError, projectId, redact } from './gitlab-api.mjs';
import { fakeFetch } from './testing/fake-fetch.mjs';

const TOKEN = 'glpat-ABCDEFGHIJKLMNOPQRSTUV';
const API = '/api/v4';

function setup(overrides = {}) {
  const fetch = fakeFetch();
  const sleeps = [];
  const logs = [];
  const client = createClient({
    baseUrl: 'https://gitlab.test',
    token: TOKEN,
    fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 1, // no jitter reduction: a delay equals its exponential value
    log: (e) => logs.push(e),
    ...overrides,
  });
  return { fetch, client, sleeps, logs };
}

/** Everything an error exposes to a reader or a logger. */
function surfaces(e) {
  return [e.message, e.stack, String(e), JSON.stringify(e), e.bodyExcerpt ?? '', e.path ?? '', e.method ?? '', JSON.stringify(Object.entries(e))].join('\n');
}
async function failure(promise) {
  try { await promise; } catch (e) { return e; }
  assert.fail('expected the call to fail');
}

// ------------------------------------------------------------ request basics
test('request: the token goes in the PRIVATE-TOKEN header only; the URL is under /api/v4 and has no credential', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/user`, { json: { id: 1, username: 'root' } });
  assert.deepEqual(await client.request('GET', '/user'), { id: 1, username: 'root' });
  const c = fetch.calls[0];
  assert.equal(c.method, 'GET');
  assert.equal(c.url, 'https://gitlab.test/api/v4/user');
  assert.equal(c.headers['private-token'], TOKEN);
  assert.equal(c.headers.accept, 'application/json');
  assert.match(c.headers['user-agent'], /^vitana-eng-gitlab-client\//);
  assert.equal(c.headers.authorization, undefined);
  assert.equal(c.url.includes(TOKEN), false);
  assert.equal(c.body, undefined);
});

test('a base URL with a trailing slash or with /api/v4 already in it gives the same requests', async () => {
  for (const baseUrl of ['https://gitlab.test', 'https://gitlab.test/', 'https://gitlab.test/api/v4', 'https://gitlab.test/api/v4/']) {
    const { fetch, client } = setup({ baseUrl });
    fetch.route('GET', `${API}/version`, { json: { version: '19.5.3-ee' } });
    await client.request('GET', '/version');
    assert.equal(fetch.calls[0].url, 'https://gitlab.test/api/v4/version', baseUrl);
  }
});

test('a base URL on a sub path keeps the sub path', async () => {
  const { fetch, client } = setup({ baseUrl: 'https://gitlab.test/gitlab' });
  fetch.route('GET', '/gitlab/api/v4/user', { json: {} });
  await client.request('GET', '/user');
  assert.equal(fetch.calls[0].url, 'https://gitlab.test/gitlab/api/v4/user');
});

test('query: arrays become key[]=v, null and undefined are skipped, numbers, booleans and dates are written as text', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/jobs`, { json: [] });
  await client.request('GET', '/jobs', {
    query: { scope: ['pending', 'running'], 'state[]': ['a'], page: 2, active: false, skip: undefined, none: null, since: new Date('2026-11-04T20:00:00.000Z'), q: 'a b&c' },
  });
  const q = fetch.calls[0].query;
  assert.deepEqual(q['scope[]'], ['pending', 'running']);
  assert.deepEqual(q['state[]'], ['a']);
  assert.deepEqual(q.page, ['2']);
  assert.deepEqual(q.active, ['false']);
  assert.deepEqual(q.since, ['2026-11-04T20:00:00.000Z']);
  assert.deepEqual(q.q, ['a b&c'], 'special characters survive a round trip');
  assert.equal('skip' in q, false);
  assert.equal('none' in q, false);
});

test('a query value that is an object is refused instead of being sent as [object Object]', async () => {
  const { client } = setup();
  const e = await failure(client.request('GET', '/jobs', { query: { filter: { a: 1 } } }));
  assert.ok(e instanceof GitLabApiError);
  assert.equal(e.code, 'bad_request');
});

test('a JSON body is serialised with its content type; POST, PUT and DELETE shortcuts use the right method', async () => {
  const { fetch, client } = setup();
  fetch.route('POST', `${API}/projects/1/notes`, { status: 201, json: { id: 5 } });
  fetch.route('PUT', `${API}/projects/1`, { json: { id: 1 } });
  fetch.route('DELETE', `${API}/projects/1/hooks/9`, { status: 204 });
  fetch.route('GET', `${API}/projects/1`, { json: { id: 1 } });
  assert.deepEqual(await client.post('/projects/1/notes', { body: { body: 'hello' } }), { id: 5 });
  await client.put('/projects/1', { body: { visibility: 'private' } });
  assert.equal(await client.del('/projects/1/hooks/9'), null);
  await client.get('/projects/1');
  assert.deepEqual(fetch.calls.map((c) => c.method), ['POST', 'PUT', 'DELETE', 'GET']);
  assert.deepEqual(fetch.calls[0].body, { body: 'hello' });
  assert.match(fetch.calls[0].headers['content-type'], /^application\/json/);
  assert.equal(fetch.calls[2].headers['content-type'], undefined, 'no content type without a body');
});

test('a GET with a body is refused: the caller made a mistake', async () => {
  const { client, fetch } = setup();
  const e = await failure(client.request('GET', '/user', { body: { a: 1 } }));
  assert.equal(e.code, 'bad_request');
  assert.equal(fetch.calls.length, 0);
});

test('a caller cannot replace the token header or add another credential; other headers pass through', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/user`, { json: {} });
  await client.request('GET', '/user', {
    headers: { 'private-token': 'evil', 'PRIVATE-TOKEN': 'evil2', Authorization: 'Bearer other', 'Job-Token': 'j', 'Deploy-Token': 'd', Cookie: 'a=b', Host: 'evil.test', 'Content-Length': '99', 'X-Request-Id': 'r1' },
  });
  const h = fetch.calls[0].headers;
  assert.equal(h['private-token'], TOKEN);
  for (const name of ['authorization', 'job-token', 'deploy-token', 'cookie', 'host', 'content-length']) assert.equal(h[name], undefined, name);
  assert.equal(h['x-request-id'], 'r1');
});

test('projectId encodes a path with slashes for use in a URL', () => {
  assert.equal(projectId('vitana/vitana-platform'), 'vitana%2Fvitana-platform');
  assert.equal(projectId(42), '42');
  assert.throws(() => projectId(''), GitLabApiError);
});

// ------------------------------------------------------------ bodies
test('empty bodies: 204 and an empty 200 give null; a non-JSON success body is an error, not a crash', async () => {
  const { fetch, client } = setup();
  fetch.route('DELETE', `${API}/a`, { status: 204 });
  fetch.route('GET', `${API}/b`, { status: 200, text: '' });
  fetch.route('GET', `${API}/c`, { status: 200, text: '<html>sign in</html>', headers: { 'content-type': 'text/html' } });
  assert.equal(await client.request('DELETE', '/a'), null);
  assert.equal(await client.request('GET', '/b'), null);
  const e = await failure(client.request('GET', '/c'));
  assert.equal(e.code, 'invalid_json');
  assert.equal(e.status, 200);
  assert.match(e.bodyExcerpt, /sign in/);
});

test('expect: "text" returns the text as it is, also when it is not JSON', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/projects/1/jobs/2/trace`, { text: 'line 1\nline 2', headers: { 'content-type': 'text/plain' } });
  assert.equal(await client.request('GET', '/projects/1/jobs/2/trace', { expect: 'text' }), 'line 1\nline 2');
});

test('raw returns status, headers and data, and does not throw for a status listed in okStatuses', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/projects/1/repository/files/x`, { status: 404, json: { message: '404 File Not Found' } });
  fetch.route('GET', `${API}/projects/1`, { json: { id: 1 }, headers: { 'X-Total': '7' } });
  const miss = await client.raw('GET', '/projects/1/repository/files/x', { okStatuses: [404] });
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.data, { message: '404 File Not Found' });
  const ok = await client.raw('GET', '/projects/1');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-total'), '7');
  const e = await failure(client.raw('GET', '/projects/1/repository/files/x'));
  assert.equal(e.status, 404);
});

test('a redirect is never followed: fetch is told not to, and a 3xx answer is an error that does not repeat the Location', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/r`, { status: 302, headers: { Location: 'https://elsewhere.test/signed?X-Amz-Signature=abc123' } }, { repeatLast: true });
  const e = await failure(client.request('GET', '/r'));
  assert.equal(e.code, 'redirect');
  assert.equal(e.status, 302);
  assert.equal(fetch.calls.length, 1, 'not retried and not followed');
  assert.equal(fetch.calls[0].redirect, 'manual');
  assert.equal(surfaces(e).includes('elsewhere.test'), false, 'the signed Location is not copied into the error');
  assert.equal(surfaces(e).includes('abc123'), false);
});

// ------------------------------------------------------------ pagination
function pagedRoute(fetch, path, pages, extra = {}) {
  fetch.route('GET', path, (call) => {
    const page = Number(call.query.page?.[0] ?? 1);
    const items = pages[page - 1];
    return { json: items, headers: { 'X-Next-Page': page < pages.length ? String(page + 1) : '', 'X-Total-Pages': String(pages.length), ...extra } };
  });
}

test('paginate: three pages in order, per_page 100, one request per page and none after the last', async () => {
  const { fetch, client } = setup();
  pagedRoute(fetch, `${API}/projects`, [[{ id: 1 }, { id: 2 }], [{ id: 3 }], [{ id: 4 }, { id: 5 }]]);
  const all = await client.paginate('/projects');
  assert.deepEqual(all.map((x) => x.id), [1, 2, 3, 4, 5]);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(fetch.calls.map((c) => c.query.page[0]), ['1', '2', '3']);
  assert.ok(fetch.calls.every((c) => c.query.per_page[0] === '100'));
});

test('paginate: perPage and other query parameters are kept on every page; an empty first page gives []', async () => {
  const { fetch, client } = setup();
  pagedRoute(fetch, `${API}/projects/1/jobs`, [[{ id: 1 }], [{ id: 2 }]]);
  await client.paginate('/projects/1/jobs', { perPage: 20, query: { scope: ['failed', 'canceled'] } });
  for (const c of fetch.calls) {
    assert.equal(c.query.per_page[0], '20');
    assert.deepEqual(c.query['scope[]'], ['failed', 'canceled']);
  }
  const empty = setup();
  pagedRoute(empty.fetch, `${API}/none`, [[]]);
  assert.deepEqual(await empty.client.paginate('/none'), []);
});

test('paginate: a page that is not an array is an error naming the path', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/user`, { json: { id: 1 } });
  const e = await failure(client.paginate('/user'));
  assert.equal(e.code, 'paginate_non_array');
  assert.equal(e.path, '/user');
});

test('paginate: a server that never stops is cut off at maxPages', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/loop`, (call) => ({ json: [{ n: call.n }], headers: { 'X-Next-Page': String(Number(call.query.page[0]) + 1) } }));
  const e = await failure(client.paginate('/loop', { maxPages: 4 }));
  assert.equal(e.code, 'too_many_pages');
  assert.equal(fetch.calls.length, 4);
});

test('paginate: follows a keyset Link header on the same origin when there is no X-Next-Page', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/projects`, [
    { json: [{ id: 1 }], headers: { Link: '<https://gitlab.test/api/v4/projects?pagination=keyset&per_page=100&id_after=1>; rel="next"' } },
    { json: [{ id: 2 }] },
  ]);
  assert.deepEqual((await client.paginate('/projects')).map((x) => x.id), [1, 2]);
  assert.equal(fetch.calls[1].url, 'https://gitlab.test/api/v4/projects?pagination=keyset&per_page=100&id_after=1');
  assert.equal(fetch.calls[1].headers['private-token'], TOKEN);
});

test('paginate: a Link to another origin is refused and the token is never sent there', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/projects`, { json: [{ id: 1 }], headers: { Link: '<https://evil.test/api/v4/projects?id_after=1>; rel="next"' } });
  const e = await failure(client.paginate('/projects'));
  assert.equal(e.code, 'bad_link');
  assert.equal(fetch.calls.length, 1, 'the second URL was not requested');
  assert.equal(fetch.calls.some((c) => c.url.includes('evil.test')), false);
  assert.equal(surfaces(e).includes(TOKEN), false);
});

test('paginate: a Link on the same origin but outside the API path is refused too', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/projects`, { json: [{ id: 1 }], headers: { Link: '<https://gitlab.test/uploads/-/system/next>; rel="next"' } });
  const e = await failure(client.paginate('/projects'));
  assert.equal(e.code, 'bad_link');
  assert.equal(fetch.calls.length, 1);
});

test('paginate: a relative Link is read against the base URL and stays inside the API path', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/projects`, [{ json: [{ id: 1 }], headers: { Link: '</api/v4/projects?id_after=1&pagination=keyset>; rel="next"' } }, { json: [{ id: 2 }] }]);
  assert.deepEqual((await client.paginate('/projects')).map((x) => x.id), [1, 2]);
  assert.equal(fetch.calls[1].url, 'https://gitlab.test/api/v4/projects?id_after=1&pagination=keyset');
});

test('paginate: X-Next-Page wins over a Link header', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/p`, (call) => call.query.page[0] === '1'
    ? { json: [1], headers: { 'X-Next-Page': '2', Link: '<https://gitlab.test/api/v4/other>; rel="next"' } }
    : { json: [2], headers: { 'X-Next-Page': '' } });
  assert.deepEqual(await client.paginate('/p'), [1, 2]);
  assert.equal(fetch.calls.every((c) => c.path === `${API}/p`), true);
});

// ------------------------------------------------------------ retry
test('429 with Retry-After in seconds: waits that long once, then succeeds', async () => {
  const { fetch, client, sleeps } = setup();
  fetch.route('GET', `${API}/x`, [{ status: 429, headers: { 'Retry-After': '2' }, json: { message: 'Retry later' } }, { json: { ok: true } }]);
  assert.deepEqual(await client.request('GET', '/x'), { ok: true });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fetch.calls.length, 2);
});

test('Retry-After as an HTTP date is read against the injected clock; a date in the past means retry now', async () => {
  const now = () => Date.parse('2026-11-04T20:00:00Z');
  const a = setup({ now });
  a.fetch.route('GET', `${API}/x`, [{ status: 429, headers: { 'Retry-After': 'Wed, 04 Nov 2026 20:00:07 GMT' } }, { json: 1 }]);
  await a.client.request('GET', '/x');
  assert.deepEqual(a.sleeps, [7000]);
  const c = setup({ now });
  c.fetch.route('GET', `${API}/x`, [{ status: 429, headers: { 'Retry-After': 'Wed, 04 Nov 2026 19:00:00 GMT' } }, { json: 1 }]);
  await c.client.request('GET', '/x');
  assert.deepEqual(c.sleeps, [0]);
});

test('a Retry-After longer than maxDelayMs is not retried early: the error says how long to wait', async () => {
  const { fetch, client, sleeps } = setup({ maxDelayMs: 5000 });
  fetch.route('GET', `${API}/x`, { status: 429, headers: { 'Retry-After': '120' }, json: { message: 'Retry later' } }, { repeatLast: true });
  const e = await failure(client.request('GET', '/x'));
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.status, 429);
  assert.equal(e.retryAfterMs, 120_000);
  assert.match(e.message, /120 s/);
  assert.equal(fetch.calls.length, 1, 'no request while the server asked for a pause');
  assert.deepEqual(sleeps, []);
  assert.equal(JSON.parse(JSON.stringify(e)).retryAfterMs, 120_000);
  const exact = setup({ maxDelayMs: 5000 });
  exact.fetch.route('GET', `${API}/x`, [{ status: 429, headers: { 'Retry-After': '5' } }, { json: 1 }]);
  await exact.client.request('GET', '/x');
  assert.deepEqual(exact.sleeps, [5000], 'exactly maxDelayMs is still waited');
});

test('Retry-After is honoured on 503 as well as 429, and ignored on other 5xx', async () => {
  const a = setup();
  a.fetch.route('GET', `${API}/x`, [{ status: 503, headers: { 'Retry-After': '3' } }, { json: 1 }]);
  await a.client.request('GET', '/x');
  assert.deepEqual(a.sleeps, [3000]);
  const b = setup();
  b.fetch.route('GET', `${API}/x`, [{ status: 500, headers: { 'Retry-After': '3' } }, { json: 1 }]);
  await b.client.request('GET', '/x');
  assert.deepEqual(b.sleeps, [500]);
});

test('a malformed Retry-After is not a delay of zero: the client backs off instead', async () => {
  for (const value of ['-5', '+5', '5.', '1,5', '1 2', 'abc', '', '   ', 'NaN']) {
    const { fetch, client, sleeps } = setup();
    fetch.route('GET', `${API}/x`, [{ status: 429, headers: { 'Retry-After': value } }, { json: 1 }]);
    await client.request('GET', '/x');
    assert.deepEqual(sleeps, [500], JSON.stringify(value));
  }
});

test('back-off without Retry-After doubles from baseDelayMs, is capped by maxDelayMs, and jitter halves it at most', async () => {
  const a = setup();
  a.fetch.route('GET', `${API}/x`, [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { json: 'up' }]);
  assert.equal(await a.client.request('GET', '/x'), 'up');
  assert.deepEqual(a.sleeps, [500, 1000, 2000, 4000]);
  const capped = setup({ maxDelayMs: 1500 });
  capped.fetch.route('GET', `${API}/x`, [{ status: 502 }, { status: 502 }, { status: 502 }, { status: 502 }, { json: 'up' }]);
  await capped.client.request('GET', '/x');
  assert.deepEqual(capped.sleeps, [500, 1000, 1500, 1500]);
  const jitter = setup({ random: () => 0 });
  jitter.fetch.route('GET', `${API}/x`, [{ status: 500 }, { status: 500 }, { json: 'up' }]);
  await jitter.client.request('GET', '/x');
  assert.deepEqual(jitter.sleeps, [250, 500]);
});

test('retries are capped: a server that keeps failing gives an error after retries + 1 attempts with the last status', async () => {
  const { fetch, client, sleeps } = setup();
  fetch.route('GET', `${API}/down`, { status: 503, json: { message: 'maintenance' } }, { repeatLast: true });
  const e = await failure(client.request('GET', '/down'));
  assert.ok(e instanceof GitLabApiError);
  assert.equal(e.status, 503);
  assert.equal(e.attempts, 5);
  assert.equal(fetch.calls.length, 5);
  assert.equal(sleeps.length, 4);
  const none = setup({ retries: 0 });
  none.fetch.route('GET', `${API}/down`, { status: 500 }, { repeatLast: true });
  const e0 = await failure(none.client.request('GET', '/down'));
  assert.equal(e0.attempts, 1);
  assert.equal(none.fetch.calls.length, 1);
});

test('other 4xx are not retried: one call, the status in the error', async () => {
  for (const status of [400, 401, 403, 404, 405, 409, 422]) {
    const { fetch, client, sleeps } = setup();
    fetch.route('GET', `${API}/x`, { status, json: { message: `${status} problem` } }, { repeatLast: true });
    const e = await failure(client.request('GET', '/x'));
    assert.equal(e.status, status, `status ${status}`);
    assert.equal(e.attempts, 1);
    assert.equal(fetch.calls.length, 1, `status ${status} was retried`);
    assert.equal(sleeps.length, 0);
  }
});

test('a write is not repeated by accident: POST and PATCH are retried on 429 only, not on 5xx or network errors', async () => {
  for (const method of ['POST', 'PATCH']) {
    const a = setup();
    a.fetch.route(method, `${API}/w`, [{ status: 500 }, { json: { id: 1 } }]);
    const e = await failure(a.client.request(method, '/w', { body: { a: 1 } }));
    assert.equal(e.status, 500, method);
    assert.equal(a.fetch.calls.length, 1, `${method} on 500`);
    const b = setup();
    b.fetch.route(method, `${API}/w`, { networkError: 'ECONNRESET' });
    assert.equal((await failure(b.client.request(method, '/w', { body: {} }))).code, 'network');
    assert.equal(b.fetch.calls.length, 1, `${method} on a network error`);
    const c = setup();
    c.fetch.route(method, `${API}/w`, [{ status: 429, headers: { 'Retry-After': '1' } }, { json: { id: 2 } }]);
    assert.deepEqual(await c.client.request(method, '/w', { body: {} }), { id: 2 });
    assert.equal(c.fetch.calls.length, 2, `${method} on 429`);
    assert.deepEqual(c.sleeps, [1000]);
  }
});

test('PUT and DELETE are idempotent and are retried on 5xx; GET and HEAD too', async () => {
  for (const method of ['PUT', 'DELETE', 'GET', 'HEAD']) {
    const { fetch, client } = setup();
    fetch.route(method, `${API}/i`, [{ status: 502 }, { status: 204 }]);
    assert.equal(await client.request(method, '/i', method === 'PUT' ? { body: {} } : {}), null);
    assert.equal(fetch.calls.length, 2, method);
  }
});

test('retryUnsafe: true lets a caller opt a POST into 5xx retries', async () => {
  const { fetch, client } = setup({ retryUnsafe: true });
  fetch.route('POST', `${API}/w`, [{ status: 503 }, { json: { id: 1 } }]);
  assert.deepEqual(await client.post('/w', { body: {} }), { id: 1 });
  assert.equal(fetch.calls.length, 2);
});

test('a network error on a GET is retried and then succeeds; after the cap it is an error with code network and the system code', async () => {
  const a = setup();
  a.fetch.route('GET', `${API}/n`, [{ networkError: 'ECONNRESET' }, { json: 'back' }]);
  assert.equal(await a.client.request('GET', '/n'), 'back');
  const b = setup({ retries: 2 });
  b.fetch.route('GET', `${API}/n`, { networkError: 'ENOTFOUND' }, { repeatLast: true });
  const e = await failure(b.client.request('GET', '/n'));
  assert.equal(e.code, 'network');
  assert.equal(e.status, 0);
  assert.equal(e.networkCode, 'ENOTFOUND');
  assert.equal(e.attempts, 3);
});

test('an error thrown by fetch that is not a network error is a bug of the caller: rethrown unchanged, not retried', async () => {
  const boom = new RangeError('programming error');
  let calls = 0;
  const { client } = setup({ fetch: async () => { calls++; throw boom; } });
  const e = await failure(client.request('GET', '/x'));
  assert.equal(e, boom);
  assert.equal(calls, 1);
});

test('a timeout becomes an error with code timeout, not a hang; a GET is retried after a timeout, a POST is not', async () => {
  const get = setup({ timeoutMs: 20, retries: 1 });
  get.fetch.route('GET', `${API}/slow`, { hang: true }, { repeatLast: true });
  const e = await failure(get.client.request('GET', '/slow'));
  assert.equal(e.code, 'timeout');
  assert.equal(e.status, 0);
  assert.equal(e.attempts, 2);
  assert.equal(get.fetch.calls.length, 2);
  assert.equal(get.sleeps.length, 1);
  const post = setup({ timeoutMs: 20, retries: 3 });
  post.fetch.route('POST', `${API}/slow`, { hang: true }, { repeatLast: true });
  const p = await failure(post.client.post('/slow', { body: {} }));
  assert.equal(p.code, 'timeout');
  assert.equal(post.fetch.calls.length, 1);
});

test('a per-call timeoutMs overrides the client default; the abort signal reaches fetch', async () => {
  const { fetch, client } = setup({ timeoutMs: 60_000, retries: 0 });
  fetch.route('GET', `${API}/slow`, { hang: true });
  const t0 = Date.now();
  const e = await failure(client.request('GET', '/slow', { timeoutMs: 20 }));
  assert.equal(e.code, 'timeout');
  assert.ok(Date.now() - t0 < 5000, 'returned long before the client default');
  assert.ok(fetch.calls[0].signal, 'fetch got a signal');
});

// ------------------------------------------------------------ errors never carry the token
test('the error carries status, method and path without the query string, and the GitLab message', async () => {
  const { fetch, client } = setup();
  fetch.route('PUT', `${API}/projects/9/protected_branches`, { status: 422, json: { message: { name: ['has already been taken'] } } });
  const e = await failure(client.request('PUT', '/projects/9/protected_branches', { query: { secret_looking: 'x' }, body: { name: 'main' } }));
  assert.ok(e instanceof GitLabApiError && e instanceof Error);
  assert.equal(e.name, 'GitLabApiError');
  assert.equal(e.status, 422);
  assert.equal(e.method, 'PUT');
  assert.equal(e.path, '/projects/9/protected_branches');
  assert.equal(e.code, 'http');
  assert.match(e.message, /PUT/);
  assert.match(e.message, /\/projects\/9\/protected_branches/);
  assert.match(e.message, /422/);
  assert.match(e.message, /has already been taken/);
  assert.equal(e.message.includes('secret_looking'), false, 'the query string is not in the message');
});

test('the token appears nowhere: not in messages, stacks, JSON, excerpts or log lines, also when the server echoes it', async () => {
  const echo = `bad token ${TOKEN} and glrt-ZZZZZZZZZZZZZZZZZZZZZZ and Bearer abc.def.ghi`;
  const cases = [
    { route: { status: 401, json: { message: echo } }, method: 'GET', path: '/user' },
    { route: { status: 500, text: echo, headers: { 'content-type': 'text/plain' } }, method: 'GET', path: '/user' },
    { route: { status: 200, text: echo }, method: 'GET', path: '/user' },
    { route: { status: 403, json: { error: echo, message: { nested: [echo] } } }, method: 'POST', path: '/user', body: { x: 1 } },
  ];
  for (const k of cases) {
    const { fetch, client, logs } = setup({ retries: 1 });
    fetch.route(k.method, `${API}${k.path}`, k.route, { repeatLast: true });
    const e = await failure(client.request(k.method, k.path, k.body ? { body: k.body } : {}));
    for (const text of [surfaces(e), JSON.stringify(logs)]) {
      assert.equal(text.includes(TOKEN), false, 'the token leaked');
      assert.equal(text.includes('glrt-ZZZZZZ'), false, 'a runner token leaked');
      assert.equal(/Bearer abc/.test(text), false, 'a bearer token leaked');
    }
  }
});

test('a token without a GitLab shape (the 20-character bootstrap token) is redacted too, in errors and in excerpts', async () => {
  const plain = 'a1b2c3d4e5f6a7b8c9d0';
  const { fetch, client, logs } = setup({ token: plain, retries: 1 });
  fetch.route('GET', `${API}/user`, [{ status: 503, text: `upstream saw ${plain}` }, { status: 401, json: { message: `invalid token ${plain}` } }]);
  const e = await failure(client.request('GET', '/user'));
  assert.equal(e.status, 401);
  assert.equal(surfaces(e).includes(plain), false);
  assert.equal(JSON.stringify(logs).includes(plain), false);
  assert.match(e.message, /invalid token \[redacted\]/);
  assert.equal(redact(`x ${plain} y`, plain), 'x [redacted] y');
  assert.equal(redact('short', 'short'), 'short', 'a token shorter than 8 characters is not used as a redaction key');
});

test('redact removes the configured token and any GitLab token shape, and keeps the rest', () => {
  const r = redact(`x ${TOKEN} y glpat-1234567890abcdefghij z glrt-abcdefghijklmnopqrstu w gldt-abcdefghijklmnopqrstu Bearer sometoken.value-1 end`, TOKEN);
  assert.equal(r, 'x [redacted] y [redacted] z [redacted] w [redacted] [redacted] end');
  assert.equal(redact('nothing secret here', TOKEN), 'nothing secret here');
  assert.equal(redact(undefined, TOKEN), '');
});

test('a long body is cut to a short excerpt', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/big`, { status: 500, text: 'x'.repeat(5000) }, { repeatLast: true });
  const e = await failure(client.request('GET', '/big'));
  assert.ok(e.bodyExcerpt.length <= 300, `excerpt ${e.bodyExcerpt.length}`);
  assert.ok(e.message.length <= 500, `message ${e.message.length}`);
});

test('log receives retry events with method, path without the query, status, attempt and delay, and nothing else', async () => {
  const { fetch, client, logs } = setup();
  fetch.route('GET', `${API}/x`, [{ status: 503 }, { status: 429, headers: { 'Retry-After': '3' } }, { json: 1 }]);
  await client.request('GET', '/x', { query: { token_like: 'abc' } });
  assert.equal(logs.length, 2);
  assert.deepEqual(logs[0], { event: 'retry', method: 'GET', path: '/x', status: 503, code: 'http', attempt: 1, delayMs: 500 });
  assert.deepEqual(logs[1], { event: 'retry', method: 'GET', path: '/x', status: 429, code: 'http', attempt: 2, delayMs: 3000 });
});

test('log events for network errors and timeouts carry exactly method, path, status 0, code, attempt and delay', async () => {
  const a = setup();
  a.fetch.route('GET', `${API}/n`, [{ networkError: 'ECONNRESET' }, { json: 1 }]);
  await a.client.request('GET', '/n', { query: { a: 'b' }, headers: { 'X-Request-Id': 'r' } });
  assert.deepEqual(a.logs, [{ event: 'retry', method: 'GET', path: '/n', status: 0, code: 'network', attempt: 1, delayMs: 500 }]);
  const b = setup({ timeoutMs: 20, retries: 1 });
  b.fetch.route('GET', `${API}/t`, [{ hang: true }, { json: 1 }]);
  await b.client.request('GET', '/t');
  assert.deepEqual(b.logs, [{ event: 'retry', method: 'GET', path: '/t', status: 0, code: 'timeout', attempt: 1, delayMs: 500 }]);
});

test('request has no okStatuses option and says so; raw accepts the statuses it is given, and checks them before sending', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/missing`, { status: 404, json: { message: '404 Not found' } }, { repeatLast: true });
  const e = await failure(client.request('GET', '/missing', { okStatuses: [404] }));
  assert.equal(e.code, 'bad_request');
  assert.match(e.message, /use raw\(\)/);
  assert.equal(fetch.calls.length, 0, 'nothing was sent');
  assert.equal((await client.raw('GET', '/missing', { okStatuses: [404] })).status, 404);
  for (const okStatuses of [500, '404', ['404'], [99], [600], [404.5], [null]]) {
    const bad = await failure(client.raw('POST', '/w', { body: {}, okStatuses }));
    assert.equal(bad.code, 'bad_request', JSON.stringify(okStatuses));
  }
  assert.equal(fetch.calls.length, 1, 'only the valid raw call went out');
});

// ------------------------------------------------------------ review round: path, options, retries, timers, bodies, pagination
test('encoded dot segments cannot climb out of /api/v4; ordinary dots and encoded slashes are fine', async () => {
  const { fetch, client } = setup();
  for (const path of ['/%2e%2e/%2e%2e/oauth/token', '/.%2e/x', '/%2E./x', '/a/%2E', '/a/%2e%2E/b', '/projects/1/%2e%2e/%2e%2e/%2e%2e/uploads/x', '/..', '/.', '/a/.', '/a/..']) {
    const e = await failure(client.request('GET', path));
    assert.equal(e.code, 'bad_path', path);
  }
  assert.equal(fetch.calls.length, 0, 'nothing was sent');
  fetch.route('GET', /.*/, { json: 1 }, { repeatLast: true });
  for (const path of ['/a.b', '/..foo', '/foo..', '/projects/1/repository/files/.gitlab-ci.yml', '/%2e%2e%2e/x', '/%252e%252e/x', '/projects/vitana%2Fvitana-platform']) {
    await client.request('GET', path);
    const url = new URL(fetch.calls.at(-1).url);
    assert.ok(url.pathname.startsWith('/api/v4/'), `${path} stays under /api/v4: ${url.pathname}`);
  }
});

test('options are checked before anything is sent: okStatuses, expect, retries, maxBodyBytes and timeoutMs per call', async () => {
  const { fetch, client } = setup();
  const cases = [
    { expect: 'txt' }, { expect: 5 }, { retries: -1 }, { retries: 11 }, { retries: 1.5 }, { maxBodyBytes: 0 }, { timeoutMs: 0 }, { timeoutMs: 3_000_000_000 },
  ];
  for (const extra of cases) {
    const e = await failure(client.request('POST', '/w', { body: {}, ...extra }));
    assert.equal(e.code, 'bad_request', JSON.stringify(extra));
  }
  assert.equal(fetch.calls.length, 0, 'a write with a bad option was never sent');
});

test('credentials cannot be put in the query string, and more routing headers are dropped', async () => {
  const { fetch, client } = setup();
  for (const key of ['private_token', 'access_token', 'job_token', 'PRIVATE_TOKEN', 'private-token']) {
    const e = await failure(client.request('GET', '/projects', { query: { [key]: 'x' } }));
    assert.equal(e.code, 'bad_request', key);
  }
  assert.equal(fetch.calls.length, 0);
  fetch.route('GET', `${API}/user`, { json: {} });
  await client.request('GET', '/user', {
    headers: { 'Proxy-Authorization': 'Basic x', 'X-HTTP-Method-Override': 'DELETE', 'X-Method-Override': 'DELETE', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-For': '1.2.3.4', Forwarded: 'for=1.2.3.4', 'X-Keep': 'yes' },
  });
  const h = fetch.calls[0].headers;
  for (const name of ['proxy-authorization', 'x-http-method-override', 'x-method-override', 'x-forwarded-host', 'x-forwarded-for', 'forwarded']) assert.equal(h[name], undefined, name);
  assert.equal(h['x-keep'], 'yes');
});

test('per-call retries: 0 stops a PUT that is an action (merge) from being repeated; a larger value allows more attempts', async () => {
  const merge = setup();
  merge.fetch.route('PUT', `${API}/projects/1/merge_requests/7/merge`, [{ status: 503 }, { json: { state: 'merged' } }]);
  const e = await failure(merge.client.put('/projects/1/merge_requests/7/merge', { body: { sha: 'abc' }, retries: 0 }));
  assert.equal(e.status, 503);
  assert.equal(e.attempts, 1);
  assert.equal(merge.fetch.calls.length, 1);
  assert.deepEqual(merge.sleeps, []);
  const more = setup({ retries: 0 });
  more.fetch.route('GET', `${API}/x`, [{ status: 503 }, { status: 503 }, { json: 'ok' }]);
  assert.equal(await more.client.request('GET', '/x', { retries: 2 }), 'ok');
  assert.equal(more.fetch.calls.length, 3);
});

test('a retried PUT sends the same body and headers again, after a 5xx and after a network error', async () => {
  for (const first of [{ status: 502 }, { networkError: 'ECONNRESET' }]) {
    const { fetch, client } = setup();
    fetch.route('PUT', `${API}/p`, [first, { json: { ok: true } }]);
    await client.put('/p', { body: { a: [1, 2], b: 'x' }, headers: { 'X-Request-Id': 'r9' } });
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(fetch.calls[1].body, { a: [1, 2], b: 'x' });
    assert.deepEqual(fetch.calls[1].body, fetch.calls[0].body);
    assert.deepEqual(fetch.calls[1].headers, fetch.calls[0].headers);
    assert.equal(fetch.calls[1].headers['x-request-id'], 'r9');
  }
});

test('501 Not Implemented is not retried; other 5xx are', async () => {
  const a = setup();
  a.fetch.route('GET', `${API}/x`, { status: 501 }, { repeatLast: true });
  assert.equal((await failure(a.client.request('GET', '/x'))).status, 501);
  assert.equal(a.fetch.calls.length, 1);
  for (const status of [500, 502, 503, 504, 599]) {
    const b = setup();
    b.fetch.route('GET', `${API}/x`, [{ status }, { json: 1 }]);
    await b.client.request('GET', '/x');
    assert.equal(b.fetch.calls.length, 2, String(status));
  }
});

test('retryUnsafe: true also covers network errors and timeouts of a POST', async () => {
  const a = setup({ retryUnsafe: true });
  a.fetch.route('POST', `${API}/w`, [{ networkError: 'ECONNRESET' }, { json: { id: 1 } }]);
  assert.deepEqual(await a.client.post('/w', { body: {} }), { id: 1 });
  assert.equal(a.fetch.calls.length, 2);
  const b = setup({ retryUnsafe: true, timeoutMs: 20 });
  b.fetch.route('POST', `${API}/w`, [{ hang: true }, { json: { id: 2 } }]);
  assert.deepEqual(await b.client.post('/w', { body: {} }), { id: 2 });
  assert.equal(b.fetch.calls.length, 2);
});

test('the shortcuts use their own method', async () => {
  const { fetch, client } = setup();
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) fetch.route(m, `${API}/s`, { json: m });
  assert.equal(await client.get('/s'), 'GET');
  assert.equal(await client.post('/s', { body: {} }), 'POST');
  assert.equal(await client.put('/s', { body: {} }), 'PUT');
  assert.equal(await client.patch('/s', { body: {} }), 'PATCH');
  assert.equal(await client.del('/s'), 'DELETE');
  assert.deepEqual(fetch.calls.map((c) => c.method), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
});

test('every common network failure code is a network error; a code that is not one is rethrown unchanged', async () => {
  const codes = ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_SSL_PROTOCOL_ERROR', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
  for (const code of codes) {
    const { client } = setup({ retries: 0, fetch: async () => { throw Object.assign(new Error('socket problem'), { code }); } });
    const e = await failure(client.request('GET', '/x'));
    assert.equal(e.code, 'network', code);
    assert.equal(e.networkCode, code);
  }
  const eacces = Object.assign(new Error('permission'), { code: 'EACCES' });
  const { client } = setup({ retries: 0, fetch: async () => { throw eacces; } });
  assert.equal(await failure(client.request('GET', '/x')), eacces);
});

test('the token is trimmed before use', async () => {
  const { fetch, client } = setup({ token: `  ${TOKEN}\n` });
  fetch.route('GET', `${API}/user`, { json: {} });
  await client.request('GET', '/user');
  assert.equal(fetch.calls[0].headers['private-token'], TOKEN);
});

test('3xx answers are redirect errors across the whole band, and none is retried', async () => {
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    const { fetch, client } = setup();
    fetch.route('GET', `${API}/r`, { status, headers: { Location: 'https://elsewhere.test/x' } }, { repeatLast: true });
    const e = await failure(client.request('GET', '/r'));
    assert.equal(e.code, 'redirect', String(status));
    assert.equal(fetch.calls.length, 1);
  }
});

test('the excerpt collapses whitespace and the message detail comes from message, error or error_description', async () => {
  const a = setup();
  a.fetch.route('GET', `${API}/x`, { status: 400, text: 'a\n\n   b\t c' });
  const e = await failure(a.client.request('GET', '/x'));
  assert.equal(e.bodyExcerpt, 'a b c');
  const b = setup();
  b.fetch.route('GET', `${API}/x`, { status: 401, json: { error: 'invalid_token', error_description: 'Token expired' } });
  assert.match((await failure(b.client.request('GET', '/x'))).message, /invalid_token/);
});

// timers and bodies
function timers() { return process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length; }

test('the deadline timer is cleared after a success, after an HTTP error and after a network error', async () => {
  const before = timers();
  const { fetch, client } = setup({ timeoutMs: 60_000, retries: 0 });
  fetch.route('GET', `${API}/ok`, { json: 1 });
  fetch.route('GET', `${API}/bad`, { status: 404, json: {} });
  fetch.route('GET', `${API}/down`, { networkError: 'ECONNRESET' });
  await client.request('GET', '/ok');
  await failure(client.request('GET', '/bad'));
  await failure(client.request('GET', '/down'));
  assert.equal(timers(), before, 'no 60 s timer is left running');
});

test('a body that stalls after the headers ends as a timeout, not a hang', async () => {
  const { fetch, client } = setup({ timeoutMs: 30, retries: 0 });
  fetch.route('GET', `${API}/stall`, { status: 200, text: '[1,', hangBody: true });
  const t0 = Date.now();
  const e = await failure(client.request('GET', '/stall'));
  assert.equal(e.code, 'timeout');
  assert.ok(Date.now() - t0 < 5000);
});

test('a timeout is enforced even when the injected fetch ignores the abort signal', async () => {
  const { client } = setup({ timeoutMs: 30, retries: 0, fetch: () => new Promise(() => {}) });
  const e = await failure(client.request('GET', '/x'));
  assert.equal(e.code, 'timeout');
  const slowBody = setup({ timeoutMs: 30, retries: 0, fetch: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 200 }) });
  assert.equal((await failure(slowBody.client.request('GET', '/x'))).code, 'timeout');
});

test('a connection cut while the body is read: the error says the request may have been processed and a POST is not repeated', async () => {
  const post = setup();
  post.fetch.route('POST', `${API}/w`, { status: 201, text: '{"id":', cutBody: 'UND_ERR_SOCKET' }, { repeatLast: true });
  const e = await failure(post.client.post('/w', { body: { a: 1 } }));
  assert.equal(e.code, 'network');
  assert.equal(e.status, 0);
  assert.equal(e.responseStatus, 201);
  assert.equal(e.networkCode, 'UND_ERR_SOCKET');
  assert.match(e.message, /may have been processed/);
  assert.match(e.message, /HTTP 201/);
  assert.equal(post.fetch.calls.length, 1);
  const get = setup();
  get.fetch.route('GET', `${API}/r`, [{ status: 200, text: '[1,', cutBody: 'UND_ERR_SOCKET' }, { json: [1, 2] }]);
  assert.deepEqual(await get.client.request('GET', '/r'), [1, 2]);
  assert.equal(get.fetch.calls.length, 2);
  const noResponse = setup({ retries: 0 });
  noResponse.fetch.route('GET', `${API}/r`, { networkError: 'ECONNRESET' });
  const n = await failure(noResponse.client.request('GET', '/r'));
  assert.equal(n.responseStatus, undefined);
  assert.match(n.message, /could not be reached/);
});

test('a success body larger than maxBodyBytes is refused as soon as the limit is passed, without waiting for the rest', async () => {
  const { fetch, client } = setup({ maxBodyBytes: 100, timeoutMs: 60_000, retries: 2 });
  fetch.route('GET', `${API}/big`, { status: 200, text: 'x'.repeat(5000), hangBody: true });
  const t0 = Date.now();
  const e = await failure(client.request('GET', '/big'));
  assert.equal(e.code, 'body_too_large');
  assert.equal(e.status, 200);
  assert.equal(fetch.calls.length, 1, 'not retried');
  assert.ok(Date.now() - t0 < 5000, 'did not wait for the stalled rest of the body');
  const ok = setup({ maxBodyBytes: 100 });
  ok.fetch.route('GET', `${API}/small`, { json: { ok: 'x'.repeat(50) } });
  assert.ok(await ok.client.request('GET', '/small'));
  const perCall = setup();
  perCall.fetch.route('GET', `${API}/big`, { text: 'y'.repeat(500) });
  assert.equal((await failure(perCall.client.request('GET', '/big', { maxBodyBytes: 100 }))).code, 'body_too_large');
});

test('an error body is read only up to 64 KiB: a huge or endless error page gives the error at once', async () => {
  const { fetch, client } = setup({ timeoutMs: 60_000, retries: 0 });
  fetch.route('GET', `${API}/err`, { status: 500, text: 'z'.repeat(200_000), hangBody: true });
  const t0 = Date.now();
  const e = await failure(client.request('GET', '/err'));
  assert.equal(e.status, 500);
  assert.ok(e.bodyExcerpt.length <= 300);
  assert.ok(Date.now() - t0 < 5000, 'did not wait for the end of the error body');
});

// pagination
test('paginate: a single page of 150 000 items is returned whole (no argument-spread limit)', async () => {
  const { fetch, client } = setup();
  const big = Array.from({ length: 150_000 }, (_, i) => i);
  fetch.route('GET', `${API}/many`, { json: big });
  const all = await client.paginate('/many');
  assert.equal(all.length, 150_000);
  assert.equal(all[149_999], 149_999);
});

test('paginate: an X-Next-Page that is not a number or does not move forward stops with bad_pagination after one repeat, not 1000 requests', async () => {
  for (const value of ['abc', '1', '0', '-2', '1.5', '2x']) {
    const { fetch, client } = setup();
    fetch.route('GET', `${API}/p`, { json: [1], headers: { 'X-Next-Page': value } }, { repeatLast: true });
    const e = await failure(client.paginate('/p'));
    assert.equal(e.code, 'bad_pagination', value);
    assert.equal(fetch.calls.length, 1, value);
  }
});

test('paginate: rel="next" is found wherever it stands among the Link parameters and entries', async () => {
  for (const link of [
    '<https://gitlab.test/api/v4/p?id_after=1>; title="more"; rel="next"',
    '<https://gitlab.test/api/v4/p?id_after=1>; rel=next',
    '<https://gitlab.test/api/v4/p?page=1>; rel="prev", <https://gitlab.test/api/v4/p?id_after=1>; rel="next", <https://gitlab.test/api/v4/p?page=9>; rel="last"',
    '<https://gitlab.test/api/v4/p?id_after=1>; REL="Next"',
  ]) {
    const { fetch, client } = setup();
    fetch.route('GET', `${API}/p`, [{ json: [1], headers: { Link: link } }, { json: [2] }]);
    assert.deepEqual(await client.paginate('/p'), [1, 2], link);
    assert.equal(fetch.calls[1].url, 'https://gitlab.test/api/v4/p?id_after=1', link);
  }
  const noNext = setup();
  noNext.fetch.route('GET', `${API}/p`, { json: [1], headers: { Link: '<https://gitlab.test/api/v4/p?page=1>; rel="prev", <https://gitlab.test/api/v4/p?page=9>; rel="last"' } });
  assert.deepEqual(await noNext.client.paginate('/p'), [1]);
});

test('paginate: a Link with credentials, or with a path that only starts like the API path, is refused', async () => {
  for (const link of ['https://user:pass@gitlab.test/api/v4/p?x=1', '/api/v4evil/p', 'https://gitlab.test/api/v4evil/p', 'https://gitlab.test:8443/api/v4/p', 'http://gitlab.test/api/v4/p']) {
    const { fetch, client } = setup();
    fetch.route('GET', `${API}/p`, { json: [1], headers: { Link: `<${link}>; rel="next"` } });
    const e = await failure(client.paginate('/p'));
    assert.equal(e.code, 'bad_link', link);
    assert.equal(fetch.calls.length, 1, link);
  }
});

test('paginate passes caller headers, the timeout and the retry count to every page, not only the first', async () => {
  const a = setup();
  pagedRoute(a.fetch, `${API}/q`, [[1], [2], [3]]);
  await a.client.paginate('/q', { headers: { 'X-Request-Id': 'r5' } });
  assert.deepEqual(a.fetch.calls.map((c) => c.headers['x-request-id']), ['r5', 'r5', 'r5']);
  const b = setup({ retries: 3 });
  b.fetch.route('GET', `${API}/q`, (call) => (call.query.page[0] === '1' ? { json: [1], headers: { 'X-Next-Page': '2' } } : { hang: true }), { repeatLast: true });
  const e = await failure(b.client.paginate('/q', { timeoutMs: 20, retries: 0 }));
  assert.equal(e.code, 'timeout');
  assert.equal(b.fetch.calls.length, 2, 'page 2 had the per-call timeout and no retry');
  const c = setup();
  c.fetch.route('GET', `${API}/q`, (call) => (call.query.page[0] === '1' ? { json: [1], headers: { 'X-Next-Page': '2' } } : { status: 503 }), { repeatLast: true });
  await failure(c.client.paginate('/q', { retries: 1 }));
  assert.equal(c.fetch.calls.length, 3, 'page 1, then page 2 and its one retry');
});

test('paginate refuses bad options before sending anything', async () => {
  const { fetch, client } = setup();
  for (const o of [{ perPage: 0 }, { perPage: 101 }, { perPage: 1.5 }, { maxPages: 0 }, { maxPages: 1.5 }, { retries: 99 }, { timeoutMs: 0 }, { query: { private_token: 'x' } }]) {
    const e = await failure(client.paginate('/p', o));
    assert.equal(e.code, 'bad_request', JSON.stringify(o));
  }
  assert.equal(fetch.calls.length, 0);
});

test('a path must be a string: an array or an object that prints as a path is refused, not coerced', async () => {
  const { fetch, client } = setup();
  for (const path of [['/a'], { toString: () => '/a' }, 5, null, undefined, new String('/a')]) {
    const e = await failure(client.request('GET', path));
    assert.equal(e.code, 'bad_path', String(path));
  }
  assert.equal(fetch.calls.length, 0);
});

test('maxBodyBytes: a body of exactly the limit is accepted and one byte more is refused', async () => {
  const { fetch, client } = setup({ maxBodyBytes: 10 });
  fetch.route('GET', `${API}/t`, [{ text: '0123456789' }, { text: '0123456789A' }]);
  assert.equal(await client.request('GET', '/t', { expect: 'text' }), '0123456789');
  const e = await failure(client.request('GET', '/t', { expect: 'text' }));
  assert.equal(e.code, 'body_too_large');
});

test('a TypeError "fetch failed" is a network error whatever its cause: no cause, or a code not in the list', async () => {
  const noCause = setup({ retries: 0, fetch: async () => { throw new TypeError('fetch failed'); } });
  const a = await failure(noCause.client.request('GET', '/x'));
  assert.equal(a.code, 'network');
  assert.equal(a.networkCode, 'FETCH_FAILED');
  const odd = setup({ retries: 0, fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ESOMETHINGELSE' }) }); } });
  const b = await failure(odd.client.request('GET', '/x'));
  assert.equal(b.code, 'network');
  assert.equal(b.networkCode, 'ESOMETHINGELSE');
  const other = setup({ retries: 0, fetch: async () => { throw new TypeError('something else'); } });
  assert.equal((await failure(other.client.request('GET', '/x'))).constructor, TypeError, 'any other TypeError is rethrown unchanged');
});

test('a HEAD request with a body is refused like a GET', async () => {
  const { fetch, client } = setup();
  const e = await failure(client.request('HEAD', '/x', { body: {} }));
  assert.equal(e.code, 'bad_request');
  assert.equal(fetch.calls.length, 0);
});

test('projectId: whole numbers and non-empty paths only', () => {
  assert.equal(projectId(0), '0');
  assert.equal(projectId('  a/b  '), 'a%2Fb');
  for (const bad of [-1, 1.5, Number.NaN, Infinity, '', '   ', null, undefined, {}, [], true]) {
    assert.throws(() => projectId(bad), GitLabApiError, String(bad));
  }
});

test('paginate: rel is matched as a whole word in a space-separated list; a lookalike is not a next link', async () => {
  const follows = setup();
  follows.fetch.route('GET', `${API}/p`, [{ json: [1], headers: { Link: '<https://gitlab.test/api/v4/p?id_after=1>; rel="prev next"' } }, { json: [2] }]);
  assert.deepEqual(await follows.client.paginate('/p'), [1, 2]);
  for (const rel of ['nextpage', 'prevnext', 'nex', 'next-page', 'xnext']) {
    const { fetch, client } = setup();
    fetch.route('GET', `${API}/p`, { json: [1], headers: { Link: `<https://gitlab.test/api/v4/p?id_after=1>; rel="${rel}"` } });
    assert.deepEqual(await client.paginate('/p'), [1], rel);
    assert.equal(fetch.calls.length, 1, `${rel} is not a next link`);
  }
});

test('paginate passes the per-call body limit to every page', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/p`, (call) => (call.query.page[0] === '1'
    ? { json: [1], headers: { 'X-Next-Page': '2' } }
    : { json: ['x'.repeat(500)] }), { repeatLast: true });
  const e = await failure(client.paginate('/p', { maxBodyBytes: 100 }));
  assert.equal(e.code, 'body_too_large');
  assert.equal(fetch.calls.length, 2);
});

// ------------------------------------------------------------ validation
test('configuration is checked when the client is created', () => {
  const bad = (o, code = 'bad_config') => assert.throws(() => createClient({ baseUrl: 'https://gitlab.test', token: TOKEN, fetch: fakeFetch(), ...o }), (e) => e instanceof GitLabApiError && e.code === code, JSON.stringify(Object.keys(o)));
  bad({ token: undefined });
  bad({ token: '' });
  bad({ token: '   ' });
  bad({ token: 'has space' });
  bad({ token: 'short' });
  bad({ token: '1234567' });
  bad({ token: 'ab"cd\\ef/gh12' }); // characters a JSON or URL echo would change
  bad({ token: 'abcdefgh+/==' });
  bad({ token: 'abcdefgh\u00e9' });
  bad({ token: 'line\nbreak' });
  bad({ baseUrl: undefined });
  bad({ baseUrl: 'not a url' });
  bad({ baseUrl: 'http://gitlab.test' }, 'bad_config');
  bad({ baseUrl: 'ftp://gitlab.test' });
  bad({ baseUrl: 'https://user:pass@gitlab.test' });
  bad({ baseUrl: 'https://gitlab.test/?x=1' });
  bad({ retries: -1 });
  bad({ retries: 1.5 });
  bad({ timeoutMs: 0 });
  bad({ timeoutMs: 3_000_000_000 }); // setTimeout would fire after 1 ms
  bad({ maxDelayMs: 3_000_000_000 });
  bad({ baseDelayMs: 3_000_000_000 });
  bad({ baseDelayMs: -1 });
  bad({ maxDelayMs: -1 });
  bad({ baseDelayMs: Number.NaN });
  bad({ maxBodyBytes: 0 });
  bad({ retryUnsafe: 'yes' });
  bad({ random: 'x' });
  bad({ now: 5 });
  bad({ log: 'x' });
  bad({ sleep: 'x' });
  bad({ fetch: 'nope' });
  assert.throws(() => createClient({ baseUrl: 'https://gitlab.test', token: TOKEN, fetch: fakeFetch(), sleep: 5 }), GitLabApiError);
});

test('plain http is allowed only for the machine itself (the settings sync runs on the GitLab host)', () => {
  for (const baseUrl of ['http://127.0.0.1', 'http://localhost', 'http://localhost:8080', 'http://[::1]']) {
    assert.doesNotThrow(() => createClient({ baseUrl, token: TOKEN, fetch: fakeFetch() }), baseUrl);
  }
  for (const baseUrl of ['http://10.0.0.5', 'http://gitlab.vitanaland.com', 'http://127.0.0.1.evil.test']) {
    assert.throws(() => createClient({ baseUrl, token: TOKEN, fetch: fakeFetch() }), (e) => e.code === 'bad_config', baseUrl);
  }
});

test('a path must start with one slash and must not be a URL: the token cannot be pointed at another host', async () => {
  const { fetch, client } = setup();
  for (const path of ['user', '', '//evil.test/x', 'https://evil.test/x', 'https:/evil.test/x', 'http:/evil.test/x', 'https:evil.test/x', 'evil.test/x', '/x/../../y', '/a\\b', '/a b', '/x\n', '/x?y=1', '/x#frag', '/x\t', '/x\u0000', '/\u00e9']) {
    const e = await failure(client.request('GET', path));
    assert.equal(e.code, 'bad_path', JSON.stringify(path));
  }
  assert.equal(fetch.calls.length, 0, 'nothing was sent');
  // A path that merely contains a URL is a sub-path of the API on the same origin, not a URL the token could be sent to.
  fetch.route('GET', '/api/v4/https://evil.test/x', { json: 'same origin' });
  assert.equal(await client.request('GET', '/https://evil.test/x'), 'same origin');
  assert.equal(new URL(fetch.calls[0].url).origin, 'https://gitlab.test');
});

test('the method must be one of the HTTP methods the client knows', async () => {
  const { client, fetch } = setup();
  const e = await failure(client.request('FETCH', '/user'));
  assert.equal(e.code, 'bad_request');
  assert.equal(fetch.calls.length, 0);
});

test('clients do not share state: two clients with different tokens send their own', async () => {
  const f = fakeFetch().route('GET', `${API}/user`, { json: {} }, { repeatLast: true });
  const a = createClient({ baseUrl: 'https://gitlab.test', token: 'glpat-AAAAAAAAAAAAAAAAAAAA', fetch: f, sleep: async () => {} });
  const b = createClient({ baseUrl: 'https://gitlab.test', token: 'glpat-BBBBBBBBBBBBBBBBBBBB', fetch: f, sleep: async () => {} });
  await Promise.all([a.request('GET', '/user'), b.request('GET', '/user'), a.request('GET', '/user')]);
  assert.deepEqual(f.calls.map((c) => c.headers['private-token'][6]).sort(), ['A', 'A', 'B']);
});

test('the client object does not expose the token', () => {
  const { client } = setup();
  assert.equal(JSON.stringify(client).includes(TOKEN), false);
  assert.equal(String(Object.values(client).filter((v) => typeof v === 'string')).includes(TOKEN), false);
  assert.equal(client.baseUrl, 'https://gitlab.test/api/v4');
});

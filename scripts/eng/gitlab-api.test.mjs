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

test('Retry-After as an HTTP date is read against the injected clock, and is capped by maxDelayMs', async () => {
  const now = () => Date.parse('2026-11-04T20:00:00Z');
  const a = setup({ now });
  a.fetch.route('GET', `${API}/x`, [{ status: 429, headers: { 'Retry-After': 'Wed, 04 Nov 2026 20:00:07 GMT' } }, { json: 1 }]);
  await a.client.request('GET', '/x');
  assert.deepEqual(a.sleeps, [7000]);
  const b = setup({ now, maxDelayMs: 5000 });
  b.fetch.route('GET', `${API}/x`, [{ status: 429, headers: { 'Retry-After': '120' } }, { json: 1 }]);
  await b.client.request('GET', '/x');
  assert.deepEqual(b.sleeps, [5000]);
  const c = setup({ now });
  c.fetch.route('GET', `${API}/x`, [{ status: 429, headers: { 'Retry-After': 'Wed, 04 Nov 2026 19:00:00 GMT' } }, { json: 1 }]);
  await c.client.request('GET', '/x');
  assert.deepEqual(c.sleeps, [0], 'a date in the past means retry now');
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
  for (const method of ['PUT', 'DELETE', 'GET']) {
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

test('request never returns the body of a status it did not accept, even if okStatuses is passed; raw does accept it', async () => {
  const { fetch, client } = setup();
  fetch.route('GET', `${API}/missing`, { status: 404, json: { message: '404 Not found' } }, { repeatLast: true });
  const e = await failure(client.request('GET', '/missing', { okStatuses: [404] }));
  assert.equal(e.status, 404);
  assert.equal((await client.raw('GET', '/missing', { okStatuses: [404] })).status, 404);
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
  for (const path of ['user', '', '//evil.test/x', 'https://evil.test/x', '/x/../../y', '/a\\b', '/a b', '/x\n', '/x?y=1', '/x#frag']) {
    const e = await failure(client.request('GET', path));
    assert.equal(e.code, 'bad_path', JSON.stringify(path));
  }
  assert.equal(fetch.calls.length, 0, 'nothing was sent');
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

// Recording fake fetch for the GitLab tools' tests (plan eng-gitlab-m2 §3.7, lane gitlab-client).
//
//   const f = fakeFetch()
//     .route('GET', '/api/v4/user', { json: { id: 1 } })                       // exact path
//     .route('GET', /^\/api\/v4\/projects\/\d+\/jobs$/, (call) => ({ json: [] })) // RegExp, response from the call
//     .route('GET', '/api/v4/items', { json: [1] }, { query: { page: '1' } })   // required query parameters
//     .route('POST', '/api/v4/w', [{ status: 503 }, { status: 201, json: {} }]) // a sequence, answered in order
//   const client = createClient({ baseUrl: 'https://gitlab.test', token, fetch: f, sleep: async () => {} });
//   f.calls            every call: { n, method, url, path, query, headers, body, signal, redirect }
//   f.writes(mark)     the calls that are not GET or HEAD   f.assertNoWrites(mark)   "the second apply made no write"
//   f.mark() / f.since(mark)   look at part of the history
//
// A response spec is { status = 200, json | text, headers, hang, networkError }. The most recently registered matching
// route wins, so a test can override a default. An unmatched call, or a sequence used up, throws FakeFetchError (never
// a quiet 404), so a test fails on a call it did not expect; fakeFetch({ strict: false }) answers 404 JSON instead.
// Dependency-free Node 20; it builds real Response objects, so a client under test uses the standard fetch API.

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const NO_BODY_STATUS = new Set([204, 205, 304]);

export class FakeFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FakeFetchError';
  }
}

function headerEntries(raw) {
  if (!raw) return [];
  if (typeof Headers !== 'undefined' && raw instanceof Headers) return [...raw.entries()];
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw);
}

function describe(n, input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (!url) throw new FakeFetchError('fakeFetch: the request has no url');
  const parsed = new URL(url);
  const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
  const query = {};
  for (const [k, v] of parsed.searchParams) (query[k] ??= []).push(v);
  const headers = {};
  for (const [k, v] of headerEntries(init.headers ?? input?.headers)) headers[String(k).toLowerCase()] = String(v);
  let body = init.body;
  if (typeof body === 'string' && /json/i.test(headers['content-type'] ?? '')) {
    try { body = JSON.parse(body); } catch { /* keep the text */ }
  }
  return { n, method, url: String(url), path: parsed.pathname, query, headers, body, signal: init.signal, redirect: init.redirect };
}

function routeMatches(r, call) {
  if (r.method !== '*' && r.method !== call.method) return false;
  if (typeof r.match === 'string') {
    if (call.path !== r.match) return false;
  } else if (r.match instanceof RegExp) {
    r.match.lastIndex = 0;
    if (!r.match.test(call.path)) return false;
  } else if (typeof r.match === 'function') {
    if (!r.match(call)) return false;
  }
  if (r.query) {
    for (const [k, v] of Object.entries(r.query)) {
      const want = (Array.isArray(v) ? v : [v]).map(String);
      const got = call.query[k] ?? [];
      if (want.length !== got.length || want.some((w, i) => w !== got[i])) return false;
    }
  }
  return true;
}

function toResponse(spec) {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers ?? {});
  let body = null;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  } else if (spec.text !== undefined) {
    body = String(spec.text);
  }
  if (NO_BODY_STATUS.has(status)) body = null;
  return new Response(body, { status, headers });
}

export function fakeFetch({ strict = true } = {}) {
  const calls = [];
  const routes = [];

  async function fetchImpl(input, init = {}) {
    const call = describe(calls.length, input, init);
    calls.push(call);
    const route = [...routes].reverse().find((r) => routeMatches(r, call));
    if (!route) {
      if (strict) throw new FakeFetchError(`fakeFetch: no route for ${call.method} ${call.path}`);
      return toResponse({ status: 404, json: { message: '404 Not Found (fake)' } });
    }
    let spec = route.response;
    if (Array.isArray(spec)) {
      const i = route.used++;
      if (i < spec.length) {
        spec = spec[i];
      } else if (route.repeatLast) {
        spec = spec[spec.length - 1];
      } else {
        throw new FakeFetchError(`fakeFetch: responses for ${call.method} ${call.path} exhausted after ${spec.length} calls`);
      }
    }
    if (typeof spec === 'function') spec = spec(call);
    if (spec.networkError) {
      const cause = Object.assign(new Error(String(spec.networkError)), { code: String(spec.networkError) });
      throw Object.assign(new TypeError('fetch failed'), { cause });
    }
    if (spec.hang) {
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return; // never settles, like a server that never answers
        const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    return toResponse(spec);
  }

  fetchImpl.calls = calls;
  fetchImpl.route = (method, match, response, { query, repeatLast = false } = {}) => {
    routes.push({ method: String(method).toUpperCase(), match, query, response, repeatLast, used: 0 });
    return fetchImpl;
  };
  fetchImpl.mark = () => calls.length;
  fetchImpl.since = (mark = 0) => calls.slice(mark);
  fetchImpl.writes = (mark = 0) => calls.slice(mark).filter((c) => !SAFE_METHODS.has(c.method));
  fetchImpl.assertNoWrites = (mark = 0) => {
    const w = fetchImpl.writes(mark);
    if (w.length) throw new FakeFetchError(`fakeFetch: ${w.length} write call(s) since call ${mark}: ${w.map((c) => `${c.method} ${c.path}`).join(', ')}`);
  };
  fetchImpl.reset = () => {
    calls.length = 0;
    routes.length = 0;
  };
  return fetchImpl;
}

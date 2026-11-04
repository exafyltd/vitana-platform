// GitLab REST API client for the engineering tools (plan eng-gitlab-m2 §3.7, lane gitlab-client).
//
//   const client = createClient({ baseUrl: 'https://gitlab.vitanaland.com', token });
//   await client.request('GET', '/user');                                    // parsed JSON, null for an empty body
//   await client.get('/projects/' + projectId('vitana/vitana-platform') + '/merge_requests', { query: { state: 'opened' } });
//   await client.paginate('/projects/1/jobs', { query: { scope: ['failed'] } });  // every item of every page
//   await client.raw('GET', '/projects/1/repository/files/x', { okStatuses: [404] }); // { status, headers, data }
//
// What the callers (settings sync, merge bot, metrics job, rehearsal) can rely on:
//  - The token goes in the PRIVATE-TOKEN header to one origin only. A path must be a plain path, never a URL; a pagination
//    Link to another origin is refused; redirects are never followed (Node's fetch would carry the header to the new host).
//  - The token is not in any error, message, stack, JSON dump, body excerpt or log line: bodies are redacted (the token
//    itself, any GitLab token shape, bearer tokens) and the error carries the path without its query string.
//  - Retry with back-off, capped (default 4 retries). 429 honours Retry-After. Safe and idempotent methods (GET, HEAD,
//    OPTIONS, PUT, DELETE) are retried on 5xx, network errors and timeouts. POST and PATCH are retried on 429 only,
//    because a 5xx or a lost connection may have been processed and a repeat would post a second comment or create a
//    second object; pass retryUnsafe: true to opt a client in. Other 4xx are never retried.
//  - paginate() uses X-Next-Page (offset pagination) first and a keyset Link header second. GitLab builds Link URLs from its
//    external_url, so a client that talks to http://127.0.0.1 gets a Link on another origin and refuses it (code 'bad_link');
//    use offset pagination there, or the external URL as baseUrl.
//  - A timeout is an error (code 'timeout'), not a hang. An empty body is null; a non-JSON success body is an error.
//  - sleep, random, now and fetch are injectable, so tests need no network, no real waiting and no token.
// Dependency-free Node 20 (UNIT.yml runs scripts/**/*.test.mjs with no install).

const API_PREFIX = '/api/v4';
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_HEADERS = new Set(['private-token', 'authorization', 'job-token', 'deploy-token', 'cookie', 'host', 'content-length']);
const PATH_OK = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const EXCERPT_MAX = 300;
const DETAIL_MAX = 200;
const TOKEN_SHAPE = /\b(?:glpat|glrt|gldt|glptt|glft|glcbt|glimt|glagent|gloas|glsoat|glffct|glrtr)-[A-Za-z0-9_-]{10,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const NETWORK_CODE = /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO)/;
const USER_AGENT = 'vitana-eng-gitlab-client/1';

export class GitLabApiError extends Error {
  constructor(message, { code = 'http', status = 0, method, path, attempts = 1, bodyExcerpt = '', networkCode } = {}) {
    super(message);
    this.name = 'GitLabApiError';
    this.code = code;
    this.status = status;
    this.method = method;
    this.path = path;
    this.attempts = attempts;
    this.bodyExcerpt = bodyExcerpt;
    if (networkCode) this.networkCode = networkCode;
  }

  toJSON() {
    const { name, message, code, status, method, path, attempts, networkCode } = this;
    return { name, message, code, status, method, path, attempts, ...(networkCode ? { networkCode } : {}) };
  }
}

/** Removes the configured token, every GitLab token shape and bearer tokens from text that may reach a log or an error. */
export function redact(text, token) {
  if (text === undefined || text === null) return '';
  let s = String(text);
  if (token && String(token).length >= 8) s = s.split(String(token)).join('[redacted]');
  return s.replace(TOKEN_SHAPE, '[redacted]').replace(BEARER, '[redacted]');
}

/** A project id for a URL path: a number as it is, a "group/project" path URL-encoded. */
export function projectId(idOrPath) {
  if (typeof idOrPath === 'number' && Number.isInteger(idOrPath) && idOrPath >= 0) return String(idOrPath);
  if (typeof idOrPath === 'string' && idOrPath.trim() !== '') return encodeURIComponent(idOrPath.trim());
  throw new GitLabApiError('projectId needs a number or a non-empty "group/project" path', { code: 'bad_request' });
}

const bad = (message, code = 'bad_config') => new GitLabApiError(message, { code });
const isFn = (v) => typeof v === 'function';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkNumber(name, value, { min, max, integer = false }) {
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= min && (max === undefined || value <= max) && (!integer || Number.isInteger(value));
  if (!ok) throw bad(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}${max === undefined ? '' : ` and <= ${max}`}`);
  return value;
}

function apiRootOf(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw bad('baseUrl is required');
  let u;
  try { u = new URL(baseUrl.trim()); } catch { throw bad('baseUrl is not a URL'); }
  const local = u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !local) throw bad('baseUrl must be https (plain http is allowed only for localhost, 127.0.0.1 and ::1)');
  if (u.username || u.password) throw bad('baseUrl must not carry credentials');
  if (u.search || u.hash) throw bad('baseUrl must not have a query or a fragment');
  let p = u.pathname.replace(/\/+$/, '');
  if (!p.endsWith(API_PREFIX)) p += API_PREFIX;
  return `${u.origin}${p}`;
}

function checkPath(method, path) {
  if (typeof path !== 'string' || !PATH_OK.test(path) || path.startsWith('//') || /(^|\/)\.\.?(\/|$)/.test(path)) {
    throw new GitLabApiError('the path must be a plain path that starts with one "/" and is not a URL; use the query option for parameters', { code: 'bad_path', method });
  }
}

function serializeQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const k = key.endsWith('[]') ? key : `${key}[]`;
      for (const v of value) params.append(k, scalar(key, v));
    } else {
      params.append(key, scalar(key, value));
    }
  }
  return params.toString();
}
function scalar(key, v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new GitLabApiError(`query parameter "${key}" must be a string, number, boolean, date or an array of those`, { code: 'bad_request' });
}

function parseRetryAfter(value, now) {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const v = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const when = Date.parse(v);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now());
}

function networkInfo(err) {
  if (!(err instanceof Error)) return null;
  const code = err.cause?.code ?? err.code;
  if (err instanceof TypeError && err.message === 'fetch failed') return { code: typeof code === 'string' ? code : 'FETCH_FAILED' };
  if (typeof code === 'string' && NETWORK_CODE.test(code)) return { code };
  return null;
}

function nextLink(headerValue) {
  if (!headerValue) return null;
  const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(headerValue);
  return m ? m[1] : null;
}

export function createClient(options = {}) {
  const {
    baseUrl, token, fetch = globalThis.fetch, sleep = defaultSleep, random = Math.random, now = Date.now, log,
    retries = 4, baseDelayMs = 500, maxDelayMs = 30_000, timeoutMs = 30_000, retryUnsafe = false,
  } = options;
  if (typeof token !== 'string' || !/^[\x21-\x7E]{8,}$/.test(token.trim())) {
    // 8 characters is the shortest token that can be redacted from text without mangling ordinary words
    throw bad('token must be at least 8 characters, without spaces or control characters');
  }
  const secret = token.trim();
  const apiRoot = apiRootOf(baseUrl);
  const origin = new URL(apiRoot).origin;
  const rootPath = new URL(apiRoot).pathname;
  if (!isFn(fetch)) throw bad('fetch must be a function');
  if (!isFn(sleep)) throw bad('sleep must be a function');
  if (!isFn(random)) throw bad('random must be a function');
  if (!isFn(now)) throw bad('now must be a function');
  if (log !== undefined && !isFn(log)) throw bad('log must be a function');
  checkNumber('retries', retries, { min: 0, max: 10, integer: true });
  checkNumber('baseDelayMs', baseDelayMs, { min: 0 });
  checkNumber('maxDelayMs', maxDelayMs, { min: 0 });
  checkNumber('timeoutMs', timeoutMs, { min: 1 });

  const clean = (text) => redact(text, secret);
  const excerptOf = (text) => clean(text).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);

  function backoff(attempt) {
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp * (0.5 + 0.5 * random()));
  }

  function failureFor(method, path, res, text, attempts) {
    const status = res.status;
    if (status >= 300 && status < 400) {
      return new GitLabApiError(`GitLab API ${method} ${path} answered with a redirect (${status}); redirects are not followed`, { code: 'redirect', status, method, path, attempts });
    }
    let detail = '';
    try {
      const j = JSON.parse(text);
      const m = j?.message ?? j?.error ?? j?.error_description;
      if (m !== undefined && m !== null) detail = typeof m === 'string' ? m : JSON.stringify(m);
    } catch { detail = text; }
    detail = clean(detail).replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);
    const tries = attempts > 1 ? ` after ${attempts} attempts` : '';
    return new GitLabApiError(`GitLab API ${method} ${path} failed with ${status}${tries}${detail ? `: ${detail}` : ''}`, {
      code: 'http', status, method, path, attempts, bodyExcerpt: excerptOf(text),
    });
  }

  /** One logical request: build, send with a timeout, retry what may be retried, and return { status, headers, text }. */
  async function execute({ method, url, path, body, headers: extra, timeoutMs: perCall, okStatuses }) {
    const limit = perCall === undefined ? timeoutMs : checkNumber('timeoutMs', perCall, { min: 1 });
    const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = String(v);
    }
    headers['private-token'] = secret;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    for (let attempt = 1; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), limit);
      let res; let text; let problem;
      try {
        res = await fetch(url, { method, headers, body: payload, signal: ac.signal, redirect: 'manual' });
        text = await res.text();
      } catch (err) {
        if (ac.signal.aborted) {
          problem = new GitLabApiError(`GitLab API ${method} ${path} timed out after ${limit} ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`, { code: 'timeout', method, path, attempts: attempt });
        } else {
          const net = networkInfo(err);
          if (!net) throw err; // not a network failure: a bug of the caller or of a test double; do not hide it
          problem = new GitLabApiError(`GitLab API ${method} ${path} could not be reached (${net.code})${attempt > 1 ? ` after ${attempt} attempts` : ''}`, { code: 'network', method, path, attempts: attempt, networkCode: net.code });
        }
      } finally {
        clearTimeout(timer);
      }

      if (problem) {
        if (attempt <= retries && (retryUnsafe || IDEMPOTENT.has(method))) {
          const delayMs = backoff(attempt);
          log?.({ event: 'retry', method, path, status: 0, code: problem.code, attempt, delayMs });
          await sleep(delayMs);
          continue;
        }
        throw problem;
      }

      const { status } = res;
      const ok = (status >= 200 && status < 300) || okStatuses.includes(status);
      if (ok) return { status, headers: res.headers, text };

      const rateLimited = status === 429;
      const serverSide = status >= 500 && status !== 501;
      if (attempt <= retries && (rateLimited || (serverSide && (retryUnsafe || IDEMPOTENT.has(method))))) {
        const retryAfter = rateLimited ? parseRetryAfter(res.headers.get('retry-after'), now) : undefined;
        const delayMs = retryAfter === undefined ? backoff(attempt) : Math.min(maxDelayMs, retryAfter);
        log?.({ event: 'retry', method, path, status, code: 'http', attempt, delayMs });
        await sleep(delayMs);
        continue;
      }
      throw failureFor(method, path, res, text, attempt);
    }
  }

  function decode(method, path, status, text, expect) {
    if (expect === 'text') return text;
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GitLabApiError(`GitLab API ${method} ${path} returned a body that is not JSON (HTTP ${status})`, {
        code: 'invalid_json', status, method, path, bodyExcerpt: excerptOf(text),
      });
    }
  }

  function prepare(methodIn, path, opts = {}) {
    const method = String(methodIn ?? '').toUpperCase();
    if (!METHODS.has(method)) throw new GitLabApiError(`unsupported method "${String(methodIn).slice(0, 20)}"`, { code: 'bad_request' });
    checkPath(method, path);
    if (opts.body !== undefined && (method === 'GET' || method === 'HEAD')) {
      throw new GitLabApiError(`${method} ${path} cannot have a body`, { code: 'bad_request', method, path });
    }
    const qs = serializeQuery(opts.query);
    const url = `${apiRoot}${path}${qs ? `?${qs}` : ''}`;
    return { method, url, path };
  }

  async function raw(methodIn, path, opts = {}) {
    const { method, url } = prepare(methodIn, path, opts);
    const okStatuses = opts.okStatuses ?? [];
    const res = await execute({ method, url, path, body: opts.body, headers: opts.headers, timeoutMs: opts.timeoutMs, okStatuses });
    return { status: res.status, headers: res.headers, data: decode(method, path, res.status, res.text, opts.expect ?? 'json') };
  }

  async function request(method, path, opts = {}) {
    return (await raw(method, path, { ...opts, okStatuses: [] })).data;
  }

  async function paginate(path, opts = {}) {
    const { query = {}, perPage = 100, maxPages = 1000, method = 'GET', headers, timeoutMs: perCall } = opts;
    checkNumber('perPage', perPage, { min: 1, max: 100, integer: true });
    checkNumber('maxPages', maxPages, { min: 1, integer: true });
    const items = [];
    let target = prepare(method, path, { query: { ...query, per_page: perPage, page: 1 } });
    for (let pages = 0; pages < maxPages; pages++) {
      const res = await execute({ method: target.method, url: target.url, path, headers, timeoutMs: perCall, okStatuses: [] });
      const data = decode(target.method, path, res.status, res.text, 'json');
      if (!Array.isArray(data)) {
        throw new GitLabApiError(`GitLab API ${target.method} ${path} did not return a list, so it cannot be paginated`, { code: 'paginate_non_array', status: res.status, method: target.method, path });
      }
      items.push(...data);
      const nextPage = res.headers.get('x-next-page');
      if (nextPage && nextPage.trim() !== '') {
        target = prepare(method, path, { query: { ...query, per_page: perPage, page: Number(nextPage) } });
        continue;
      }
      const link = nextLink(res.headers.get('link'));
      if (!link) return items;
      let next;
      try { next = new URL(link, `${origin}/`); } catch { next = null; }
      if (!next || next.origin !== origin || !next.pathname.startsWith(rootPath)) {
        throw new GitLabApiError(`GitLab API ${target.method} ${path}: the pagination Link points to another origin or path and was not followed`, { code: 'bad_link', method: target.method, path });
      }
      target = { method: target.method, url: next.href, path };
    }
    throw new GitLabApiError(`GitLab API ${method} ${path} still has more pages after ${maxPages} pages; stopped`, { code: 'too_many_pages', method, path });
  }

  return {
    baseUrl: apiRoot,
    request,
    raw,
    paginate,
    get: (path, opts) => request('GET', path, opts),
    post: (path, opts) => request('POST', path, opts),
    put: (path, opts) => request('PUT', path, opts),
    patch: (path, opts) => request('PATCH', path, opts),
    del: (path, opts) => request('DELETE', path, opts),
  };
}

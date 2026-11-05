// GitLab REST API client for the engineering tools (plan eng-gitlab-m2 §3.7, lane gitlab-client).
//
//   const client = createClient({ baseUrl: 'https://gitlab.vitanaland.com', token });
//   await client.request('GET', '/user');                                    // parsed JSON, null for an empty body
//   await client.get('/projects/' + projectId('vitana/vitana-platform') + '/merge_requests', { query: { state: 'opened' } });
//   await client.paginate('/projects/1/jobs', { query: { scope: ['failed'] } });  // every item of every page
//   await client.raw('GET', '/projects/1/repository/files/x', { okStatuses: [404] }); // { status, headers, data }
//   await client.put('/projects/1/merge_requests/7/merge', { body, retries: 0 });     // an action: never repeat it
//
// What the callers (settings sync, merge bot, metrics job, rehearsal) can rely on:
//  - The token goes in the PRIVATE-TOKEN header to one origin only, and only to paths under /api/v4. A path must be a plain
//    path, never a URL, with no dot segments (also not %2e); the final URL is checked again after it is built. A pagination
//    Link to another origin or outside the API path is refused. Redirects are never followed (Node's fetch would carry the
//    header to the new host). A caller cannot set PRIVATE-TOKEN, Authorization or other credential headers, and cannot put a
//    token in the query.
//  - The token is not in any error, message, stack, JSON dump, body excerpt or log line: bodies are redacted (the token
//    itself, any GitLab token shape, bearer tokens) and the error carries the path without its query string. A token may
//    contain only [A-Za-z0-9_.~=-], so no JSON or URL escaping can hide it from the redaction.
//  - Retry with back-off, capped (default 4 retries, at most 10). 429 and 503 honour Retry-After; a Retry-After longer than
//    maxDelayMs is not retried early but ends in a 'rate_limited' error that carries retryAfterMs. GET, HEAD, PUT and DELETE
//    are retried on 5xx (not 501), network errors and timeouts. POST and PATCH are retried on 429 only, because a 5xx or a
//    lost connection may have been processed and a repeat would post a second comment or create a second object; pass
//    retryUnsafe: true to opt a client in. A PUT that is an action (merge, rebase) must pass retries: 0 for that call. Other
//    4xx are never retried.
//  - A timeout is an error (code 'timeout'), not a hang, also when the injected fetch ignores the abort signal. A response
//    that is cut while its body is read is an error (code 'network') that says the request may have been processed. A body
//    is read as a stream and refused past maxBodyBytes (default 16 MiB); an error body is read only up to 64 KiB.
//  - An empty body is null; a non-JSON success body is an error.
//  - paginate() uses X-Next-Page (offset pagination) first and a keyset Link header second. GitLab builds Link URLs from its
//    external_url, so a client that talks to http://127.0.0.1 gets a Link on another origin and refuses it (code 'bad_link');
//    use offset pagination there, or the external URL as baseUrl.
//  - sleep, random, now and fetch are injectable, so tests need no network, no real waiting and no token.
// Options are validated before anything is sent. Dependency-free Node 20 (UNIT.yml runs scripts/**/*.test.mjs with no install).

const API_PREFIX = '/api/v4';
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_HEADERS = new Set([
  'private-token', 'authorization', 'proxy-authorization', 'job-token', 'deploy-token', 'cookie', 'host', 'content-length',
  'x-http-method-override', 'x-http-method', 'x-method-override', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
]);
const FORBIDDEN_QUERY = new Set(['private_token', 'access_token', 'job_token', 'private-token', 'job-token']);
const PATH_OK = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const DOT_SEGMENT = /(^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;
const TOKEN_OK = /^[A-Za-z0-9_.~=-]{8,}$/;
const EXCERPT_MAX = 300;
const DETAIL_MAX = 200;
const ERROR_BODY_MAX = 64 * 1024;
const DEFAULT_BODY_MAX = 16 * 1024 * 1024;
const TIMER_MAX = 2_147_483_647; // setTimeout fires after 1 ms for anything larger
const TOKEN_SHAPE = /\b(?:glpat|glrt|gldt|glptt|glft|glcbt|glimt|glagent|gloas|glsoat|glffct|glrtr)-[A-Za-z0-9_-]{10,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const NETWORK_CODE = /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO)/;
const USER_AGENT = 'vitana-eng-gitlab-client/1';
const EXPECTS = new Set(['json', 'text']);

export class GitLabApiError extends Error {
  constructor(message, { code = 'http', status = 0, method, path, attempts = 1, bodyExcerpt = '', networkCode, responseStatus, retryAfterMs } = {}) {
    super(message);
    this.name = 'GitLabApiError';
    this.code = code;
    this.status = status;
    this.method = method;
    this.path = path;
    this.attempts = attempts;
    this.bodyExcerpt = bodyExcerpt;
    if (networkCode) this.networkCode = networkCode;
    if (responseStatus !== undefined) this.responseStatus = responseStatus;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  toJSON() {
    const { name, message, code, status, method, path, attempts, networkCode, responseStatus, retryAfterMs } = this;
    return {
      name, message, code, status, method, path, attempts,
      ...(networkCode ? { networkCode } : {}), ...(responseStatus !== undefined ? { responseStatus } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
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
const badRequest = (message, method, path) => new GitLabApiError(message, { code: 'bad_request', method, path });
const isFn = (v) => typeof v === 'function';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkNumber(name, value, { min, max, integer = false }, make = bad) {
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= min && (max === undefined || value <= max) && (!integer || Number.isInteger(value));
  if (!ok) throw make(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}${max === undefined ? '' : ` and <= ${max}`}`);
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
  if (typeof path !== 'string' || !PATH_OK.test(path) || path.startsWith('//') || DOT_SEGMENT.test(path)) {
    throw new GitLabApiError('the path must be a plain path that starts with one "/" and is not a URL; use the query option for parameters', { code: 'bad_path', method });
  }
}

function serializeQuery(query, method, path) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (FORBIDDEN_QUERY.has(key.toLowerCase())) throw badRequest(`query parameter "${key}" would put a credential in the URL; the client sends its token in a header`, method, path);
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const k = key.endsWith('[]') ? key : `${key}[]`;
      for (const v of value) params.append(k, scalar(key, v, method, path));
    } else {
      params.append(key, scalar(key, value, method, path));
    }
  }
  return params.toString();
}
function scalar(key, v, method, path) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw badRequest(`query parameter "${key}" must be a string, number, boolean, date or an array of those`, method, path);
}

/** Milliseconds from a Retry-After value: seconds, or an HTTP date read against `now`. Anything else is undefined. */
function parseRetryAfter(value, now) {
  if (value === null || value === undefined) return undefined;
  const v = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  if (!/[A-Za-z]/.test(v)) return undefined; // Date.parse reads "-5", "5." and "1,5" as past dates: not a delay
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

/** The URL of the rel="next" entry of a Link header, wherever rel stands among the parameters. */
function nextLink(headerValue) {
  if (!headerValue) return null;
  for (const part of String(headerValue).split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]*)>\s*((?:;[^;]*)*)\s*$/.exec(part);
    if (!m) continue;
    const rel = /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(m[2]);
    if (rel && rel[1].toLowerCase().split(/\s+/).includes('next')) return m[1];
  }
  return null;
}

/** Reads a body as a stream and stops at maxBytes: { text, truncated }. A cut or failing stream rejects. */
async function readBody(res, maxBytes) {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

export function createClient(options = {}) {
  const {
    baseUrl, token, fetch = globalThis.fetch, sleep = defaultSleep, random = Math.random, now = Date.now, log,
    retries = 4, baseDelayMs = 500, maxDelayMs = 30_000, timeoutMs = 30_000, retryUnsafe = false, maxBodyBytes = DEFAULT_BODY_MAX,
  } = options;
  if (typeof token !== 'string' || !TOKEN_OK.test(token.trim())) {
    // 8 characters is the shortest token that can be redacted from text without mangling ordinary words; the characters are
    // those GitLab tokens use, so that no JSON or URL escaping can change a token into something the redaction misses
    throw bad('token must be at least 8 characters of letters, digits and _ . ~ = -');
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
  checkNumber('baseDelayMs', baseDelayMs, { min: 0, max: TIMER_MAX });
  checkNumber('maxDelayMs', maxDelayMs, { min: 0, max: TIMER_MAX });
  checkNumber('timeoutMs', timeoutMs, { min: 1, max: TIMER_MAX });
  checkNumber('maxBodyBytes', maxBodyBytes, { min: 1, integer: true });
  if (typeof retryUnsafe !== 'boolean') throw bad('retryUnsafe must be true or false');

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

  /** One logical request: send with a timeout, retry what may be retried, return { status, headers, text }. */
  async function execute({ method, url, path, body, headers: extra, timeoutMs: limit, okStatuses, retries: maxRetries, maxBodyBytes: bodyLimit }) {
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
      let timer;
      // The deadline is raced against the call, so it also ends a call whose fetch ignores the abort signal.
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new DOMException('The operation timed out', 'AbortError'));
        }, limit);
      });
      deadline.catch(() => {});
      let res; let text; let problem;
      try {
        res = await Promise.race([fetch(url, { method, headers, body: payload, signal: ac.signal, redirect: 'manual' }), deadline]);
        const ok = (res.status >= 200 && res.status < 300) || okStatuses.includes(res.status);
        const read = await Promise.race([readBody(res, ok ? bodyLimit : ERROR_BODY_MAX), deadline]);
        if (read.truncated && ok) {
          throw new GitLabApiError(`GitLab API ${method} ${path} answered with more than ${bodyLimit} bytes; refused`, { code: 'body_too_large', status: res.status, method, path, attempts: attempt });
        }
        text = read.text;
      } catch (err) {
        if (err instanceof GitLabApiError) throw err;
        if (ac.signal.aborted) {
          problem = new GitLabApiError(`GitLab API ${method} ${path} timed out after ${limit} ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`, { code: 'timeout', method, path, attempts: attempt });
        } else {
          const net = networkInfo(err);
          if (!net) throw err; // not a network failure: a bug of the caller or of a test double; do not hide it
          const cut = res ? ` while reading the response (HTTP ${res.status}); the request may have been processed` : '';
          problem = new GitLabApiError(`GitLab API ${method} ${path} ${res ? 'lost the connection' : 'could not be reached'} (${net.code})${cut}${attempt > 1 ? `, attempt ${attempt}` : ''}`, {
            code: 'network', method, path, attempts: attempt, networkCode: net.code, ...(res ? { responseStatus: res.status } : {}),
          });
        }
      } finally {
        clearTimeout(timer);
      }

      if (problem) {
        if (attempt <= maxRetries && (retryUnsafe || IDEMPOTENT.has(method))) {
          const delayMs = backoff(attempt);
          log?.({ event: 'retry', method, path, status: 0, code: problem.code, attempt, delayMs });
          await sleep(delayMs);
          continue;
        }
        throw problem;
      }

      const { status } = res;
      if ((status >= 200 && status < 300) || okStatuses.includes(status)) return { status, headers: res.headers, text };

      const rateLimited = status === 429;
      const unavailable = status === 503;
      const serverSide = status >= 500 && status !== 501;
      if (attempt <= maxRetries && (rateLimited || (serverSide && (retryUnsafe || IDEMPOTENT.has(method))))) {
        const retryAfter = rateLimited || unavailable ? parseRetryAfter(res.headers.get('retry-after'), now) : undefined;
        if (retryAfter !== undefined && retryAfter > maxDelayMs) {
          throw new GitLabApiError(`GitLab API ${method} ${path} asks to wait ${Math.round(retryAfter / 1000)} s before trying again (HTTP ${status}); not retried now`, {
            code: 'rate_limited', status, method, path, attempts: attempt, retryAfterMs: retryAfter, bodyExcerpt: excerptOf(text),
          });
        }
        const delayMs = retryAfter === undefined ? backoff(attempt) : retryAfter;
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

  /** Validates everything the caller passed before anything is sent, and builds the URL. */
  function prepare(methodIn, path, opts = {}) {
    const method = String(methodIn ?? '').toUpperCase();
    if (!METHODS.has(method)) throw new GitLabApiError(`unsupported method "${String(methodIn).slice(0, 20)}"`, { code: 'bad_request' });
    checkPath(method, path);
    if (opts.body !== undefined && (method === 'GET' || method === 'HEAD')) throw badRequest(`${method} ${path} cannot have a body`, method, path);
    const okStatuses = opts.okStatuses ?? [];
    if (!Array.isArray(okStatuses) || okStatuses.some((s) => !Number.isInteger(s) || s < 100 || s > 599)) throw badRequest('okStatuses must be a list of HTTP status numbers', method, path);
    const expect = opts.expect ?? 'json';
    if (!EXPECTS.has(expect)) throw badRequest('expect must be "json" or "text"', method, path);
    const make = (m) => badRequest(m, method, path);
    const perCall = {
      timeoutMs: opts.timeoutMs === undefined ? timeoutMs : checkNumber('timeoutMs', opts.timeoutMs, { min: 1, max: TIMER_MAX }, make),
      retries: opts.retries === undefined ? retries : checkNumber('retries', opts.retries, { min: 0, max: 10, integer: true }, make),
      maxBodyBytes: opts.maxBodyBytes === undefined ? maxBodyBytes : checkNumber('maxBodyBytes', opts.maxBodyBytes, { min: 1, integer: true }, make),
    };
    const qs = serializeQuery(opts.query, method, path);
    const url = `${apiRoot}${path}${qs ? `?${qs}` : ''}`;
    // The URL parser removes dot segments the checks above might not have seen: look at what will really be requested.
    const u = new URL(url);
    if (u.origin !== origin || !(u.pathname === rootPath || u.pathname.startsWith(`${rootPath}/`))) {
      throw new GitLabApiError('the request would leave the API path', { code: 'bad_path', method });
    }
    return { method, url, path, okStatuses, expect, ...perCall };
  }

  async function raw(methodIn, path, opts = {}) {
    const p = prepare(methodIn, path, opts);
    const res = await execute({ ...p, body: opts.body, headers: opts.headers });
    return { status: res.status, headers: res.headers, data: decode(p.method, path, res.status, res.text, p.expect) };
  }

  /** The body of a 2xx answer. It has no okStatuses option: a status other than 2xx is an error here; use raw() to accept one. */
  async function request(method, path, opts = {}) {
    if (opts.okStatuses !== undefined) {
      throw badRequest('request() does not take okStatuses (a non-2xx answer is an error); use raw() to accept a status', String(method).toUpperCase(), path);
    }
    return (await raw(method, path, opts)).data;
  }

  async function paginate(path, opts = {}) {
    const { query = {}, perPage = 100, maxPages = 1000, method = 'GET', headers } = opts;
    checkNumber('perPage', perPage, { min: 1, max: 100, integer: true }, (m) => badRequest(m, method, path));
    checkNumber('maxPages', maxPages, { min: 1, integer: true }, (m) => badRequest(m, method, path));
    const common = { timeoutMs: opts.timeoutMs, retries: opts.retries, maxBodyBytes: opts.maxBodyBytes };
    const items = [];
    let page = 1;
    let target = prepare(method, path, { ...common, query: { ...query, per_page: perPage, page } });
    for (let pages = 0; pages < maxPages; pages++) {
      const res = await execute({ ...target, headers });
      const data = decode(target.method, path, res.status, res.text, 'json');
      if (!Array.isArray(data)) {
        throw new GitLabApiError(`GitLab API ${target.method} ${path} did not return a list, so it cannot be paginated`, { code: 'paginate_non_array', status: res.status, method: target.method, path });
      }
      for (const item of data) items.push(item);
      const nextPage = res.headers.get('x-next-page');
      if (nextPage && nextPage.trim() !== '') {
        const n = Number(nextPage);
        if (!/^\d+$/.test(nextPage.trim()) || n <= page) {
          throw new GitLabApiError(`GitLab API ${target.method} ${path} sent an X-Next-Page that does not move forward; stopped`, { code: 'bad_pagination', method: target.method, path });
        }
        page = n;
        target = prepare(method, path, { ...common, query: { ...query, per_page: perPage, page } });
        continue;
      }
      const link = nextLink(res.headers.get('link'));
      if (!link) return items;
      let next;
      try { next = new URL(link, `${origin}/`); } catch { next = null; }
      if (!next || next.origin !== origin || next.username || next.password || !(next.pathname === rootPath || next.pathname.startsWith(`${rootPath}/`))) {
        throw new GitLabApiError(`GitLab API ${target.method} ${path}: the pagination Link points to another origin or path and was not followed`, { code: 'bad_link', method: target.method, path });
      }
      target = { ...target, url: next.href };
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

#!/usr/bin/env node
// GitHub bridge on the trusted GitLab host (plan agentic-delivery §3.13, lane github-bridge, VTID-05548).
//
//   node scripts/eng/github-bridge.mjs run [--dry-run] [options]           one tick; vitana-github-bridge.timer runs it every minute
//   node scripts/eng/github-bridge.mjs assist-push --repo <owner/name> --branch <branch> --commit <sha> --from-ref <GitLab ref>
//   options: --state-dir (/var/lib/vitana/github-bridge) --github-token-file (/etc/vitana/github-bridge-token)
//            --gitlab-token-file (/etc/vitana/gitlab-bridge-token) --gitlab-url (https://gitlab.vitanaland.com)
//            --github-api-url (https://api.github.com) --github-git-base (https://github.com) --gitlab-git-base (= --gitlab-url)
//
// One tick, for exafyltd/vitana-platform → vitana/vitana-platform and exafyltd/vitana-v1 → vitana/vitana-v1:
//  - Branches. Every kiro/* and claude/* branch of GitHub is copied to GitLab; never main, assist/*, pm-agent/* or any other
//    name. One writer per branch (plan §3.1 principle 1): GitLab branch missing → created; GitLab head = the head the bridge
//    pushed last → the GitHub head is copied (a force-push too); GitLab head = the GitHub head or one of its ancestors (the
//    same history, for example the M1 mirror's copy) → adopted and fast-forwarded; anything else → refused: nothing is
//    pushed and it is reported once per GitLab head (log event branch_refused). The merge bot is not another writer: its
//    clean merges of main on top of the bridge's copy (eng-gitlab-m2 §3.4, plan §3.5) keep the branch bridged, and a new
//    GitHub head is copied over them. A head that landed (its merge request merged, GitLab removed the source branch) is
//    not copied again; a new head on GitHub is.
//  - Pull requests. One merge request per open pull request into main from a bridged branch of the same repository (a fork
//    is ignored), with the same title (a draft PR is a GitLab draft) and body (CRLF as LF, quick actions disarmed), source
//    branch = head branch, target main; updated when the title or the body change (only one the bridge opened); closed when
//    the pull request closes or leaves main without landing, once GitHub confirms no open pull request from that branch
//    into main is left.
//  - Statuses. One commit status gitlab/<job> per job result of the merge request's head pipeline (of the pull request head,
//    or of it with the bot's merges of main), on the GitHub commit; never a status equal to the latest one of its context on
//    that commit. A landing gate job (lane-scope, change-suite, gate) is success only when it passed, as the merge bot reads
//    it; while the head pipeline runs without a gate result, gitlab/gate is pending until the result replaces it. GitHub's
//    content write limits: at most 60 status writes a tick and 450 in any hour. In each tick the gate results that are not
//    success go first, over every pull request, then the other gate results, then the rest, so a red or running pipeline
//    never shows only success while writes wait; the next tick starts with the pull request left without a turn; a rate
//    limit pauses every GitHub write.
//  - Landing. When the merge request of the pull request head (also with the bot's merges of main) is merged, the pull
//    request is closed with one comment that links the landed commit.
// An API or git error changes nothing for that branch in that tick (a read that every branch of a repository needs: nothing
// for that repository); it is retried at the next tick and the other branches go on. --dry-run reads but writes nothing
// anywhere (no git push or fetch, no API write, no state write) and prints the planned actions. Log lines are JSON on
// stdout and are redacted. Tokens are read from files, never from argv; git gets a token only through GIT_CONFIG_*
// environment entries (http.<origin>/.extraHeader) for its own host, never in a URL or an argument. State:
// <state-dir>/state.json (branch ownership, status cache, write budget); git objects: <state-dir>/cache/, which a dry run
// and an assist push only read (through a throw-away repository), so they may run as another user. assist-push takes its
// commit only from a protected assist ref (refs/heads/assist/*). Exit: 0 done, 1 a tick with errors, 2 usage or
// configuration, 3 an assist push refused. Dependency-free Node 20; GitLab calls go through scripts/eng/gitlab-api.mjs
// (M2), GitHub calls through the small client below (one origin, no redirects, redaction).
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, projectId, redact as redactGitLab } from './gitlab-api.mjs';

export const BRIDGE_REPOS = Object.freeze([
  Object.freeze({ github: 'exafyltd/vitana-platform', gitlab: 'vitana/vitana-platform' }),
  Object.freeze({ github: 'exafyltd/vitana-v1', gitlab: 'vitana/vitana-v1' }),
]);
const TARGET = 'main';
const STATE_SCHEMA = 'vitana.github-bridge-state/v1';
const DEFAULTS = Object.freeze({
  stateDir: '/var/lib/vitana/github-bridge', githubTokenFile: '/etc/vitana/github-bridge-token', gitlabTokenFile: '/etc/vitana/gitlab-bridge-token',
  gitlabUrl: 'https://gitlab.vitanaland.com', githubApiUrl: 'https://api.github.com', githubGitBase: 'https://github.com',
});
const SHA = /^[0-9a-f]{40}$/;
const TOKEN_OK = /^[A-Za-z0-9_.~=-]{8,}$/;
const TITLE_MAX = 255;
const LS_REMOTE_TIMEOUT_MS = 60_000;

class BridgeError extends Error {
  constructor(message, code = 'bridge') {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}
const messageOf = (e) => String(e?.message ?? e);

// ------------------------------------------------------------------------------------------------- names and mappings
/** A branch the bridge copies: kiro/<name> or claude/<name>, a valid git branch name of plain characters. */
export function isBridgedBranch(name) {
  if (typeof name !== 'string' || name.length > 200 || !/^(?:kiro|claude)\/[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((seg) => seg !== '' && !seg.startsWith('.') && !seg.endsWith('.lock'));
}
/** A full ref name (refs/...) of plain characters, for the source of an assist commit. */
function isPlainRef(ref) {
  if (typeof ref !== 'string' || ref.length > 250 || !/^refs\/[A-Za-z0-9._/-]+$/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.')) return false;
  return ref.split('/').every((seg) => seg !== '' && !seg.startsWith('.') && !seg.endsWith('.lock'));
}

/** The landing gate jobs (plan §8.2 step 3: the required jobs lane-scope, change-suite and gate). The merge bot lands a merge
 * request only when each of them is `success` (eng-gitlab-m2 plan §3.4: a required job that is absent, skipped, neutral or
 * still running does not pass), so GitHub shows no other result of them as success. */
export const GATE_JOBS = Object.freeze(['lane-scope', 'change-suite', 'gate']);
const GATE = new Set(GATE_JOBS);

const WAITING = new Set(['created', 'pending', 'scheduled', 'preparing', 'waiting_for_resource', 'waiting_for_callback']);
/** The GitHub commit status of a GitLab job, read the way the merge bot reads jobs (eng-gitlab-m2 plan §3.4 table); a landing
 * gate job is success only when it passed (skipped, allowed to fail and an optional manual job are success for any other job).
 * `settled` is true for a result (success, failed, canceled, skipped, manual, or a status this code does not know, which
 * fails closed as pending); only a settled job is posted, so each job result is one status (GitHub limits how much
 * content an account may create: 80 requests a minute, 500 an hour). */
export function jobToStatus(job) {
  const allowed = job?.allow_failure === true;
  const gate = GATE.has(job?.name);
  switch (job?.status) {
    case 'success': return { state: 'success', description: 'Passed on GitLab', settled: true };
    case 'failed':
      if (!allowed) return { state: 'failure', description: 'Failed on GitLab', settled: true };
      return gate ? { state: 'failure', description: 'Failed on GitLab; a landing needs this job to pass', settled: true }
        : { state: 'success', description: 'Failed on GitLab, allowed to fail', settled: true };
    case 'canceled': return { state: 'error', description: 'Canceled on GitLab', settled: true };
    case 'skipped':
      return gate ? { state: 'failure', description: 'Skipped on GitLab: an earlier job did not pass', settled: true }
        : { state: 'success', description: 'Skipped on GitLab', settled: true };
    case 'manual':
      if (!allowed) return { state: 'pending', description: 'Waiting for a manual action on GitLab', settled: true };
      return gate ? { state: 'pending', description: 'Manual job on GitLab, not run; a landing needs this job to pass', settled: true }
        : { state: 'success', description: 'Optional manual job on GitLab, not run', settled: true };
    case 'running': return { state: 'pending', description: 'Running on GitLab', settled: false };
    case 'canceling': return { state: 'pending', description: 'Being canceled on GitLab', settled: false };
    default:
      if (WAITING.has(job?.status)) return { state: 'pending', description: 'Waiting on GitLab', settled: false };
      return { state: 'pending', description: 'Unknown GitLab job status', settled: true, unknown: true }; // fails closed: never success
  }
}
/** The commit status name of a job (plan §9: gitlab/<job>); a job name is cut at 200 characters (GitLab allows 255). */
export const statusContext = (jobName) => `gitlab/${String(jobName).slice(0, 200)}`;
const GATE_CONTEXT = statusContext('gate');
const GATE_CONTEXTS = new Set(GATE_JOBS.map(statusContext));
/** The order of a tick's status writes: 0 a gate result that is not success, 1 a gate result that is success, 2 any other. */
const statusTier = (context, s) => (GATE_CONTEXTS.has(context) ? (s.state === 'success' ? 1 : 0) : 2);
const FINISHED_PIPELINE = new Set(['success', 'failed', 'canceled', 'skipped']);

/** The merge request title: the pull request title; a draft pull request becomes a GitLab draft, which cannot be merged. */
export function mrTitle(pr) {
  const t = `${pr?.draft ? 'Draft: ' : ''}${String(pr?.title ?? '')}`;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}
/** The pull request body for GitLab: CRLF as LF, and a line that starts with "/" (a GitLab quick action) gets a backslash,
 * so an agent-written body cannot label, assign, approve, retarget or merge anything. Markdown shows the same text. */
export function mrDescription(body) {
  return String(body ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/^(\s*)\//, '$1\\/')).join('\n');
}
// GitLab strips leading and trailing white space of a description, so the comparison does too (no update every tick).
const sameText = (a, b) => String(a ?? '').replace(/\r\n?/g, '\n').trim() === String(b ?? '').replace(/\r\n?/g, '\n').trim();

// ------------------------------------------------------------------------------------------------- tokens
const GITHUB_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const BASIC = /\b(Basic)\s+[A-Za-z0-9+/]{8,}={0,2}/gi;
/** A function that removes the given tokens, their base64 and Basic-auth forms, every GitHub and GitLab token shape and
 * bearer and basic credentials from text that may reach a log line, an error or the output. */
export function makeRedactor(secrets = []) {
  const forms = new Set();
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 8) continue;
    forms.add(s);
    forms.add(Buffer.from(s).toString('base64'));
    for (const user of ['x-access-token', 'oauth2']) forms.add(Buffer.from(`${user}:${s}`).toString('base64'));
  }
  const list = [...forms].sort((a, b) => b.length - a.length);
  return (text) => {
    if (text === undefined || text === null) return '';
    let out = String(text);
    for (const f of list) out = out.split(f).join('[redacted]');
    return redactGitLab(out.replace(GITHUB_SHAPE, '[redacted]').replace(BASIC, '$1 [redacted]'));
  };
}

/** The token in a file (trimmed). An error names the file, never its content. */
export function readTokenFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new BridgeError(`token file ${file} cannot be read (${e.code ?? 'error'})`, 'config');
  }
  const token = text.trim();
  if (!TOKEN_OK.test(token)) throw new BridgeError(`token file ${file} does not hold one token (8 or more letters, digits or _ . ~ = -)`, 'config');
  return token;
}

// ------------------------------------------------------------------------------------------------- GitHub REST client
export class GitHubApiError extends Error {
  constructor(message, { code = 'http', status = 0, method, path: p, attempts = 1, bodyExcerpt = '', retryAfterMs } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.code = code;
    this.status = status;
    this.method = method;
    this.path = p;
    this.attempts = attempts;
    this.bodyExcerpt = bodyExcerpt;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  toJSON() {
    const { name, message, code, status, method, path: p, attempts } = this;
    return { name, message, code, status, method, path: p, attempts };
  }
}

const GH_PATH_OK = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const DOT_SEGMENT = /(^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;
const NETWORK_CODE = /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO)/;
const GH_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The URL of the rel="next" entry of a Link header. */
function nextLink(value) {
  if (!value) return null;
  for (const part of String(value).split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]*)>\s*((?:;[^;]*)*)\s*$/.exec(part);
    const rel = m && /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(m[2]);
    if (rel && rel[1].toLowerCase().split(/\s+/).includes('next')) return m[1];
  }
  return null;
}
/** A body read as a stream, at most `max` bytes: a larger success body is refused, a larger error body is cut. */
async function readText(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      if (res.ok) throw new GitHubApiError(`GitHub API answered with more than ${max} bytes; refused`, { code: 'body_too_large', status: res.status });
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** GitHub REST client: the token goes as a bearer header to one origin only; redirects are never followed; a path is a
 * plain path (no URL, no dot segment, no query: use the query option); a pagination link must stay on that origin. A GET
 * is retried on 5xx (not 501), network errors and timeouts; a write is never repeated (a second POST would post a second
 * status or comment); a rate limit is an error, left to the next tick. Errors carry status, method and the path without
 * its query, and never the token. fetch and sleep are injectable. */
export function createGitHubClient({ token, baseUrl = DEFAULTS.githubApiUrl, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 30_000, retries = 2, baseDelayMs = 1_000, maxBodyBytes = 16 * 1024 * 1024 } = {}) {
  const bad = (m) => new GitHubApiError(m, { code: 'bad_config' });
  if (typeof token !== 'string' || !TOKEN_OK.test(token.trim())) throw bad('token must be 8 or more letters, digits or _ . ~ = -');
  const secret = token.trim();
  let root;
  try { root = new URL(baseUrl); } catch { throw bad('baseUrl is not a URL'); }
  if (root.protocol !== 'https:' && !(root.protocol === 'http:' && LOCAL_HOSTS.has(root.hostname))) throw bad('baseUrl must be https');
  if (root.username || root.password || root.search || root.hash) throw bad('baseUrl must not carry credentials, a query or a fragment');
  if (typeof fetch !== 'function' || typeof sleep !== 'function') throw bad('fetch and sleep must be functions');
  const origin = root.origin;
  const prefix = root.pathname.replace(/\/+$/, '');
  const clean = makeRedactor([secret]);

  function urlFor(method, p, query) {
    if (typeof p !== 'string' || !GH_PATH_OK.test(p) || p.startsWith('//') || DOT_SEGMENT.test(p)) {
      throw new GitHubApiError('the path must be a plain path that starts with one "/"; use the query option for parameters', { code: 'bad_path', method });
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) qs.append(k, String(v));
    const s = qs.toString();
    const u = new URL(`${origin}${prefix}${p}${s ? `?${s}` : ''}`);
    if (u.origin !== origin || !u.pathname.startsWith(`${prefix}/`)) throw new GitHubApiError('the request would leave the API', { code: 'bad_path', method });
    return u.href;
  }
  const failure = (method, p, status, text, attempts) => {
    let detail = '';
    try { detail = String(JSON.parse(text)?.message ?? ''); } catch { detail = text; }
    detail = clean(detail).replace(/\s+/g, ' ').trim().slice(0, 200);
    return new GitHubApiError(`GitHub API ${method} ${p} failed with ${status}${detail ? `: ${detail}` : ''}`, {
      code: 'http', status, method, path: p, attempts, bodyExcerpt: clean(text).replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  };
  const backoff = (attempt) => sleep(baseDelayMs * 2 ** (attempt - 1));

  async function send(method, url, p, body) {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'vitana-github-bridge/1', authorization: `Bearer ${secret}` };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    for (let attempt = 1; ; attempt++) {
      const ac = new AbortController();
      let timer;
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(new DOMException('The operation timed out', 'AbortError')); }, timeoutMs);
      });
      deadline.catch(() => {});
      let res;
      let text;
      let problem;
      try {
        res = await Promise.race([fetch(url, { method, headers, body: payload, signal: ac.signal, redirect: 'manual' }), deadline]);
        text = await Promise.race([readText(res, res.ok ? maxBodyBytes : 64 * 1024), deadline]);
      } catch (err) {
        if (err instanceof GitHubApiError) throw Object.assign(err, { method, path: p, attempts: attempt });
        const code = err?.cause?.code ?? err?.code;
        if (ac.signal.aborted) {
          problem = new GitHubApiError(`GitHub API ${method} ${p} timed out after ${timeoutMs} ms`, { code: 'timeout', method, path: p, attempts: attempt });
        } else if ((err instanceof TypeError && err.message === 'fetch failed') || (typeof code === 'string' && NETWORK_CODE.test(code))) {
          problem = new GitHubApiError(`GitHub API ${method} ${p} could not be completed (${typeof code === 'string' ? code : 'network'})${res ? '; the request may have been processed' : ''}`, { code: 'network', method, path: p, attempts: attempt });
        } else {
          throw err;
        }
      } finally {
        clearTimeout(timer);
      }
      const mayRetry = method === 'GET' && attempt <= retries;
      if (problem) {
        if (mayRetry) { await backoff(attempt); continue; }
        throw problem;
      }
      const { status } = res;
      if (status >= 200 && status < 300) return { status, headers: res.headers, text };
      if (status >= 300 && status < 400) {
        throw new GitHubApiError(`GitHub API ${method} ${p} answered with a redirect (${status}); redirects are not followed`, { code: 'redirect', status, method, path: p, attempts: attempt });
      }
      const retryAfter = res.headers.get('retry-after');
      const secondary = status === 403 && /secondary rate limit|abuse detection/i.test(text);
      if (status === 429 || (status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || retryAfter || secondary))) {
        throw new GitHubApiError(`GitHub API ${method} ${p} is rate limited (HTTP ${status}); left to the next tick`, {
          code: 'rate_limited', status, method, path: p, attempts: attempt, ...(/^\d+$/.test(retryAfter ?? '') ? { retryAfterMs: Number(retryAfter) * 1000 } : {}),
        });
      }
      if (status >= 500 && status !== 501 && mayRetry) { await backoff(attempt); continue; }
      throw failure(method, p, status, text, attempt);
    }
  }

  const decode = (method, p, r) => {
    if (r.text.trim() === '') return null;
    try { return JSON.parse(r.text); } catch {
      throw new GitHubApiError(`GitHub API ${method} ${p} returned a body that is not JSON (HTTP ${r.status})`, { code: 'invalid_json', status: r.status, method, path: p });
    }
  };
  async function request(methodIn, p, { query, body } = {}) {
    const method = String(methodIn ?? '').toUpperCase();
    if (!GH_METHODS.has(method)) throw new GitHubApiError('unsupported method', { code: 'bad_request' });
    const url = urlFor(method, p, query);
    return decode(method, p, await send(method, url, p, body));
  }
  async function paginate(p, { query = {}, perPage = 100, maxPages = 100 } = {}) {
    const items = [];
    let url = urlFor('GET', p, { ...query, per_page: perPage });
    for (let n = 0; n < maxPages; n++) {
      const r = await send('GET', url, p);
      const data = decode('GET', p, r);
      if (!Array.isArray(data)) throw new GitHubApiError(`GitHub API GET ${p} did not return a list, so it cannot be paginated`, { code: 'paginate_non_array', method: 'GET', path: p });
      for (const item of data) items.push(item);
      const link = nextLink(r.headers.get('link'));
      if (!link) return items;
      let next = null;
      try { next = new URL(link); } catch { /* refused below */ }
      if (!next || next.origin !== origin || next.username || next.password || !next.pathname.startsWith(`${prefix}/`)) {
        throw new GitHubApiError(`GitHub API GET ${p}: the pagination link points to another origin and was not followed`, { code: 'bad_link', method: 'GET', path: p });
      }
      url = next.href;
    }
    throw new GitHubApiError(`GitHub API GET ${p} has more than ${maxPages} pages; stopped`, { code: 'too_many_pages', method: 'GET', path: p });
  }
  return {
    request,
    paginate,
    get: (p, opts) => request('GET', p, opts),
    post: (p, opts) => request('POST', p, opts),
    patch: (p, opts) => request('PATCH', p, opts),
    put: (p, opts) => request('PUT', p, opts),
    del: (p, opts) => request('DELETE', p, opts),
  };
}

// ------------------------------------------------------------------------------------------------- git
class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitError';
  }
}

/** git with a clean environment: no system or global config, no prompt, LANG=C; for an https remote the token of that
 * host only, as a GIT_CONFIG_* entry http.<origin>/.extraHeader (Basic x-access-token for GitHub, oauth2 for GitLab), never
 * in argv or a URL. Remotes are https URLs or absolute paths (the tests' bare repositories). Objects are kept in one bare
 * cache repository per GitHub repository under cacheDir; it is created on the first fetch or push. */
export function createGit({ cacheDir, credentials = [], spawnSync = nodeSpawnSync, timeoutMs = 900_000, env = process.env } = {}) {
  if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir)) throw new GitError('cacheDir must be an absolute path');
  const creds = new Map();
  for (const c of credentials) creds.set(new URL(c.url).origin, { user: c.kind === 'github' ? 'x-access-token' : 'oauth2', token: c.token });
  const clean = makeRedactor(credentials.map((c) => c.token));
  const base = {
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: env.HOME ?? cacheDir, LANG: 'C', LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  function remote(url) {
    if (typeof url === 'string' && path.isAbsolute(url)) return { url, origin: null };
    let u;
    try { u = new URL(url); } catch { throw new GitError('a git remote must be an https URL or an absolute path'); }
    if (u.username || u.password) throw new GitError('a git remote must not carry credentials; tokens come from the token files');
    if (u.protocol !== 'https:') throw new GitError('a git remote must be an https URL or an absolute path');
    if (u.search || u.hash) throw new GitError('a git remote must not have a query or a fragment');
    return { url: u.href, origin: u.origin };
  }
  function run(args, { cwd, origin = null, repo = null, timeoutMs: limit = timeoutMs } = {}) {
    const entries = [];
    if (repo) entries.push(['safe.directory', repo]);
    if (origin) entries.push(['http.lowSpeedLimit', '1000'], ['http.lowSpeedTime', '60']); // a stalled remote ends the call
    const c = origin ? creds.get(origin) : undefined;
    if (c) entries.push([`http.${origin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`${c.user}:${c.token}`).toString('base64')}`]);
    const e = { ...base, GIT_CONFIG_COUNT: String(entries.length) };
    entries.forEach(([k, v], i) => { e[`GIT_CONFIG_KEY_${i}`] = k; e[`GIT_CONFIG_VALUE_${i}`] = v; });
    return spawnSync('git', args, { cwd: cwd ?? tmpdir(), env: e, encoding: 'utf8', timeout: limit, maxBuffer: 64 * 1024 * 1024 });
  }
  function ok(args, opts) {
    const r = run(args, opts);
    if (r.error || r.status !== 0) {
      const why = r.error ? String(r.error.code ?? r.error.message) : `exit ${r.status}`;
      throw new GitError(clean(`git ${args[0]} failed (${why}): ${String(r.stderr ?? '').trim().slice(0, 600)}`));
    }
    return String(r.stdout ?? '');
  }
  const repoOf = (key) => path.join(cacheDir, `${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}.git`);
  const cacheRef = (prefix, name) => `refs/${prefix}/${name.replaceAll('/', '%2F')}`;
  function ensureRepo(key) {
    const dir = repoOf(key);
    if (!existsSync(path.join(dir, 'HEAD'))) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      ok(['init', '--bare', '--quiet', dir], { cwd: dir });
    }
    return dir;
  }

  function hasCommit(key, sha) {
    const dir = repoOf(key);
    if (!SHA.test(String(sha)) || !existsSync(path.join(dir, 'HEAD'))) return false;
    return run(['cat-file', '-e', `${sha}^{commit}`], { cwd: dir, repo: dir }).status === 0;
  }
  function fetchInto(key, url, src, dest) {
    const r = remote(url);
    const dir = ensureRepo(key);
    ok(['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', r.url, `+${src}:${dest}`], { cwd: dir, origin: r.origin, repo: dir });
    return ok(['rev-parse', '--verify', `${dest}^{commit}`], { cwd: dir, repo: dir }).trim();
  }
  function parents(key, sha) {
    if (!hasCommit(key, sha)) return null;
    const dir = repoOf(key);
    return ok(['rev-list', '--parents', '-n', '1', sha], { cwd: dir, repo: dir }).trim().split(/\s+/).slice(1);
  }
  /** true when a is an ancestor of (or equal to) b; null when b is not in the cache (only a dry run, which never fetches). */
  function isAncestorIn(key, a, b) {
    if (!hasCommit(key, b)) return null;
    if (!hasCommit(key, a)) return false; // b's whole history is in the cache, so a is not part of it
    const dir = repoOf(key);
    const r = run(['merge-base', '--is-ancestor', a, b], { cwd: dir, repo: dir });
    if (r.status === 0 || r.status === 1) return r.status === 0;
    throw new GitError(clean(`git merge-base failed: ${String(r.stderr ?? '').trim().slice(0, 300)}`));
  }
  return {
    /** branch → sha of the kiro/* and claude/* branches of a remote (other names are never returned). */
    lsRemote(url) {
      const r = remote(url);
      const heads = new Map();
      for (const line of ok(['ls-remote', r.url, 'refs/heads/kiro/*', 'refs/heads/claude/*'], { origin: r.origin, timeoutMs: LS_REMOTE_TIMEOUT_MS }).split('\n')) {
        const m = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(line.trim());
        if (m && isBridgedBranch(m[2])) heads.set(m[2], m[1]);
      }
      return heads;
    },
    /** Fetches a branch of a remote into the cache; returns the commit it points at. */
    fetchBranch(key, url, branch) {
      if (!isBridgedBranch(branch)) throw new GitError('only a bridged branch is fetched');
      return fetchInto(key, url, `refs/heads/${branch}`, cacheRef('bridge', branch));
    },
    /** Fetches any plain ref of a remote (an assist commit's source) into the cache; returns the commit it points at. */
    fetchRef(key, url, ref) {
      if (!isPlainRef(ref)) throw new GitError('not a plain ref');
      return fetchInto(key, url, ref, cacheRef('bridge-source', ref.slice('refs/'.length)));
    },
    /** Pushes sha to a branch of a remote only when the remote branch is `expect` (null: when it does not exist). */
    push(key, url, sha, branch, expect) {
      if (!SHA.test(String(sha)) || !isBridgedBranch(branch) || (expect !== null && !SHA.test(String(expect)))) throw new GitError('push needs a sha, a bridged branch and the expected head');
      const r = remote(url);
      const dir = ensureRepo(key);
      const out = ok(['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${expect ?? ''}`, r.url, `${sha}:refs/heads/${branch}`], { cwd: dir, origin: r.origin, repo: dir });
      const line = out.split('\n').find((l) => l.includes(`:refs/heads/${branch}\t`));
      if (!line || !/^[ +*=]\t/.test(line)) throw new GitError(clean(`git push of ${branch} was not accepted: ${out.trim().slice(0, 300)}`));
    },
    hasCommit,
    isAncestor: isAncestorIn,
    /**
     * A throw-away repository for one command that another user runs (assist-push as root or as the merge bot): a
     * temporary bare repository that reads this cache's objects (objects/info/alternates) and never writes the cache,
     * so the service's files keep their owner. dispose() removes it.
     */
    scratch(keys) {
      const tmp = mkdtempSync(path.join(tmpdir(), 'github-bridge-scratch-'));
      const g = createGit({ cacheDir: tmp, credentials, spawnSync, timeoutMs, env });
      for (const key of keys) {
        const objects = path.join(repoOf(key), 'objects');
        if (!existsSync(objects)) continue; // no cache yet: the scratch starts empty too
        writeFileSync(path.join(g.ensure(key), 'objects', 'info', 'alternates'), `${objects}\n`);
      }
      return Object.assign(g, { dispose: () => rmSync(tmp, { recursive: true, force: true }) });
    },
    ensure: ensureRepo,
    /** The parents of a commit in the cache, or null when it is not there. */
    parents,
    /** The head of main of a remote, or null. */
    mainHead(url) {
      const r = remote(url);
      const m = /^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(ok(['ls-remote', r.url, 'refs/heads/main'], { origin: r.origin, timeoutMs: LS_REMOTE_TIMEOUT_MS }));
      return m ? m[1] : null;
    },
    /** Fetches GitLab's copy of a branch, GitLab's main, or a merge request's head ref into the cache. */
    fetchGitLabBranch: (key, url, branch) => {
      if (!isBridgedBranch(branch)) throw new GitError('only a bridged branch is fetched');
      return fetchInto(key, url, `refs/heads/${branch}`, cacheRef('bridge-gitlab', branch));
    },
    fetchGitLabMain: (key, url) => fetchInto(key, url, 'refs/heads/main', 'refs/bridge-gitlab-main/main'),
    fetchMergeRequestHead(key, url, iid) {
      if (!Number.isInteger(iid) || iid < 1) throw new GitError('a merge request iid is a positive integer');
      return fetchInto(key, url, `refs/merge-requests/${iid}/head`, `refs/bridge-mr/${iid}`);
    },
    /**
     * `head` without the clean merges of main on top of it: following first parents, every commit that merges a commit of
     * `mainHead`'s history into its first parent and whose tree is exactly Git's automatic merge of the two (no conflict
     * resolution, no other change) is left out. That is the merge bot bringing a branch up to date before it lands it
     * (eng-gitlab-m2 §3.4, plan §3.5); such a merge adds nothing but main. Returns { base, merges }, or null when the cache
     * lacks an object (a dry run).
     */
    withoutMainMerges(key, head, mainHead, maxMerges = 20) {
      if (!hasCommit(key, head) || !hasCommit(key, mainHead)) return null;
      const dir = repoOf(key);
      let c = head;
      for (let merges = 0; merges < maxMerges; merges++) {
        const ps = parents(key, c);
        if (!ps || ps.length !== 2 || isAncestorIn(key, ps[1], mainHead) !== true) return { base: c, merges };
        const merged = run(['merge-tree', '--write-tree', ps[0], ps[1]], { cwd: dir, repo: dir });
        const tree = ok(['rev-parse', '--verify', `${c}^{tree}`], { cwd: dir, repo: dir }).trim();
        if (merged.status !== 0 || String(merged.stdout).split('\n')[0].trim() !== tree) return { base: c, merges };
        c = ps[0];
      }
      return { base: c, merges: maxMerges };
    },
  };
}

// ------------------------------------------------------------------------------------------------- state
// { schema, status_writes?: { hour, count },
//   repos: { "<owner/name>": { branches: { "<branch>": { pushed, refused?: { gitlab, github }, landed? } },
//                              prs: { "<number>": { statuses?: { sha, fp }, closed_seen? } } } } }
// `pushed` is the head the bridge last pushed or adopted: the bridge owns a branch while GitLab still has that head.
export const emptyState = () => ({ schema: STATE_SCHEMA, repos: {} });

export function loadState(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw new BridgeError(`state file ${file} cannot be read (${e.code ?? 'error'})`, 'state');
  }
  let s;
  try { s = JSON.parse(text); } catch { throw new BridgeError(`state file ${file} is not valid JSON; see the runbook before moving it away`, 'state'); }
  if (!s || s.schema !== STATE_SCHEMA || !s.repos || typeof s.repos !== 'object' || Array.isArray(s.repos)) {
    throw new BridgeError(`state file ${file} has an unknown schema (expected ${STATE_SCHEMA})`, 'state');
  }
  return s;
}

/** Writes the state atomically (a temporary file renamed over the old one), mode 0600. */
export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ------------------------------------------------------------------------------------------------- one tick
/**
 * ctx: { repos, github (createGitHubClient), gitlab (gitlab-api createClient), git (createGit), state, dryRun, log,
 * gitlabWebUrl, now?, maxStatusWritesPerTick? (60), maxStatusWritesPerHour? (450) }. log(level, event, fields).
 * Returns { state, actions, errors }: the new state (the caller saves it unless dryRun), the actions done (planned, in a
 * dry run) and the errors of this tick. Nothing here writes the state file.
 */
export async function tick(callerCtx) {
  const prev = callerCtx.state ?? emptyState();
  const { dryRun = false, log = () => {} } = callerCtx;
  const nowMs = () => (callerCtx.now?.() ?? new Date()).getTime();
  const minute = Math.floor(nowMs() / 60_000);
  // GitHub allows an account about 80 content writes a minute and 500 an hour (secondary rate limits). Statuses are by far
  // the bridge's most frequent write, so they get a budget per tick (maxStatusWritesPerTick, 60) and per sliding hour
  // (maxStatusWritesPerHour, 450, counted per minute in the state); a status over budget is posted at a later tick.
  const recent = (Array.isArray(prev.status_writes) ? prev.status_writes : []).filter(([m, n]) => Number.isInteger(m) && m > minute - 60 && Number.isInteger(n));
  const usedLastHour = recent.reduce((sum, [, n]) => sum + n, 0);
  const statusBudget = {
    left: Math.max(0, Math.min(callerCtx.maxStatusWritesPerTick ?? 60, (callerCtx.maxStatusWritesPerHour ?? 450) - usedLastHour)), used: 0,
  };
  // A GitHub rate limit pauses every GitHub write until it has passed (at least a minute; Retry-After when longer), also
  // across ticks: GitHub asks clients not to go on writing while limited.
  const pause = { until: Date.parse(prev.github_paused_until ?? '') || 0, reported: false };
  const githubPaused = () => {
    if (pause.until <= nowMs()) return false;
    if (!pause.reported) log('warn', 'github_writes_paused', { until: new Date(pause.until).toISOString(), note: 'GitHub rate limit; statuses and pull request closes wait' });
    pause.reported = true;
    return true;
  };
  const onGitHubError = (e) => {
    if (e?.code === 'rate_limited') pause.until = Math.max(pause.until, nowMs() + Math.max(60_000, Number(e.retryAfterMs) || 0));
  };
  const mainHeads = new Map(); // GitLab main of each repository, read (and fetched, in a live tick) once per tick
  const guard = (fn) => async (...args) => {
    try { return await fn(...args); } catch (e) { onGitHubError(e); throw e; }
  };
  const github = callerCtx.github && Object.fromEntries(Object.entries(callerCtx.github).map(([k, v]) => [k, typeof v === 'function' ? guard(v) : v]));
  const statusQueue = []; // the statuses every pull request of the tick needs (statusStep), posted after all repositories
  const ctx = {
    ...callerCtx, github, gitlabUserCache: undefined, statusBudget, githubPaused, onGitHubError, statusQueue,
    gitlabMain: async (r, glUrl) => {
      if (!mainHeads.has(r.github)) {
        const head = callerCtx.git.mainHead(glUrl);
        if (head && !dryRun) callerCtx.git.fetchGitLabMain(r.github, glUrl);
        mainHeads.set(r.github, head);
      }
      return mainHeads.get(r.github);
    },
  };
  const { repos = BRIDGE_REPOS } = ctx;
  const next = { schema: STATE_SCHEMA, repos: { ...prev.repos } };
  const actions = [];
  const errors = [];
  for (const r of repos) {
    const before = prev.repos[r.github];
    const queued = statusQueue.length;
    try {
      next.repos[r.github] = await syncRepo(ctx, r, structuredClone(before ?? { branches: {}, prs: {} }), actions, errors);
    } catch (e) {
      statusQueue.length = queued; // a repository skipped in this tick posts nothing either
      errors.push({ repo: r.github, message: messageOf(e) });
      log('error', 'repo_skipped', { repo: r.github, error: messageOf(e), retry: 'next tick' });
      if (before === undefined) delete next.repos[r.github];
      else next.repos[r.github] = before;
    }
  }
  await postStatuses(ctx, statusQueue, { next, errors });
  const writes = statusBudget.used ? [...recent.filter(([m]) => m !== minute), [minute, statusBudget.used + (recent.find(([m]) => m === minute)?.[1] ?? 0)]] : recent;
  if (writes.length) next.status_writes = writes;
  if (pause.until > nowMs()) next.github_paused_until = new Date(pause.until).toISOString();
  const counts = {};
  for (const a of actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
  log(errors.length ? 'warn' : 'info', 'tick_done', { dry_run: dryRun, actions: counts, errors: errors.length });
  return { state: next, actions, errors };
}

/** An open pull request the bridge serves: into main, from a bridged branch of the same repository (not a fork). */
function eligible(p, r) {
  return Boolean(p) && p.state === 'open' && p.base?.ref === TARGET && Number.isInteger(p.number) && isBridgedBranch(p.head?.ref)
    && SHA.test(String(p.head?.sha)) && String(p.head?.repo?.full_name ?? '').toLowerCase() === r.github.toLowerCase();
}
async function gitlabUser(ctx) {
  if (!ctx.gitlabUserCache) {
    const me = await ctx.gitlab.get('/user');
    if (!Number.isInteger(me?.id)) throw new BridgeError('GitLab GET /user returned no user id', 'gitlab');
    ctx.gitlabUserCache = me;
  }
  return ctx.gitlabUserCache;
}
const gitUrls = (ctx, r) => ({
  ghUrl: r.githubGitUrl ?? `${DEFAULTS.githubGitBase}/${r.github}.git`,
  glUrl: r.gitlabGitUrl ?? `${ctx.gitlabWebUrl ?? DEFAULTS.gitlabUrl}/${r.gitlab}.git`,
});

async function syncRepo(ctx, r, st, actions, errors) {
  const { github, gitlab, git, dryRun = false, log = () => {} } = ctx;
  const { ghUrl, glUrl } = gitUrls(ctx, r);
  const pid = projectId(r.gitlab);
  // Reads that every branch of this repository needs: any failure skips the repository in this tick (state unchanged).
  const ghHeads = git.lsRemote(ghUrl);
  const glHeads = git.lsRemote(glUrl);
  const pulls = await github.paginate(`/repos/${r.github}/pulls`, { query: { state: 'open', base: TARGET } });
  const mrs = await gitlab.paginate(`/projects/${pid}/merge_requests`, { query: { state: 'opened', target_branch: TARGET } });
  const me = await gitlabUser(ctx);
  const prs = new Map();
  for (const p of pulls) if (eligible(p, r)) prs.set(p.head.ref, p);
  const openBySource = new Map();
  for (const m of mrs) {
    if (m?.state === 'opened' && m.target_branch === TARGET && m.source_project_id === m.target_project_id && typeof m.source_branch === 'string') openBySource.set(m.source_branch, m);
  }
  const act = async (a, fn) => {
    if (!dryRun) await fn();
    const entry = { repo: r.github, ...a };
    actions.push(entry);
    log('info', dryRun ? 'planned' : a.action, entry);
  };
  const out = { branches: {}, prs: {} };
  // Branches in name order, starting where the status budget ran out last time, so every pull request gets its turn.
  const sorted = [...new Set([...ghHeads.keys(), ...prs.keys()])].sort();
  const start = st.status_resume ? sorted.findIndex((x) => x >= st.status_resume) : -1;
  const order = start > 0 ? [...sorted.slice(start), ...sorted.slice(0, start)] : sorted;
  for (const b of order) {
    const gh = ghHeads.get(b) ?? null;
    const pr = prs.get(b);
    let step;
    try {
      step = await branchStep(ctx, r, { b, gh, gl: glHeads.get(b) ?? null, entry: st.branches[b], ghUrl, glUrl, act });
    } catch (e) {
      errors.push({ repo: r.github, branch: b, message: messageOf(e) });
      log('error', 'branch_failed', { repo: r.github, branch: b, error: messageOf(e), retry: 'next tick' });
      if (st.branches[b]) out.branches[b] = st.branches[b];
      if (pr && st.prs[pr.number]) out.prs[pr.number] = st.prs[pr.number];
      continue;
    }
    if (gh && step.entry) out.branches[b] = step.entry;
    if (!pr) continue;
    const before = st.prs[pr.number];
    const draft = structuredClone(before ?? {});
    try {
      if (step.bridged) await pullRequestStep(ctx, r, { b, pr, mr: openBySource.get(b), draft, before, me, pid, act, entry: step.entry ?? {}, glUrl });
      if (Object.keys(draft).length) out.prs[pr.number] = draft;
    } catch (e) {
      errors.push({ repo: r.github, branch: b, pr: pr.number, message: messageOf(e) });
      log('error', 'pull_request_failed', { repo: r.github, branch: b, pr: pr.number, error: messageOf(e), retry: 'next tick' });
      if (before) out.prs[pr.number] = before;
    }
  }
  // A branch deleted on GitHub keeps its entry while GitLab still has the bridge's copy, so a new branch of that name
  // (other history) is still the bridge's to copy and not refused against the bridge's own copy.
  for (const [b, entry] of Object.entries(st.branches)) {
    if (out.branches[b] || ghHeads.has(b)) continue;
    const gl = glHeads.get(b);
    if (gl && (gl === entry.pushed || gl === entry.gitlab)) out.branches[b] = entry;
  }
  await closeOrphans(ctx, r, { mrs, prs, me, pid, act, errors });
  return out; // postStatuses adds the statuses' cache entries and status_resume after every repository was read
}

/** True when GitLab head `glSha` is the GitHub head `sha` itself, or `sha` with only the merge bot's clean merges of main
 * on top (eng-gitlab-m2 §3.4 "behind main", plan §3.5 train update); null when a dry run cannot tell without a fetch. */
async function sameWork(ctx, r, { glSha, sha, entry, glUrl }) {
  if (glSha === sha || (entry?.gitlab && glSha === entry.gitlab && entry.pushed === sha)) return true;
  const mainHead = await ctx.gitlabMain(r, glUrl);
  if (!mainHead) return false;
  const split = ctx.git.withoutMainMerges(r.github, glSha, mainHead);
  if (!split) return null;
  return split.merges > 0 && split.base === sha;
}

/** The merged merge request from `branch` (same project, into main) whose head was `sha`, or `sha` plus the merge bot's
 * merges of main; { unknown: true } when a dry run cannot tell; else null. GitLab keeps refs/merge-requests/<iid>/head
 * after the merge, so the landed head can be fetched and judged after the source branch was removed. */
async function findLanded(ctx, r, { branch, sha, entry, glUrl, list }) {
  const all = list ?? await ctx.gitlab.paginate(`/projects/${projectId(r.gitlab)}/merge_requests`, { query: { state: 'merged', source_branch: branch, target_branch: TARGET } });
  const merged = all.filter((m) => m?.state === 'merged' && m.source_branch === branch && m.source_project_id === m.target_project_id && SHA.test(String(m.sha)));
  const exact = merged.find((m) => m.sha === sha || (entry?.gitlab && m.sha === entry.gitlab && entry.pushed === sha));
  if (exact) return exact;
  for (const m of merged) {
    if (!ctx.dryRun && ctx.git.fetchMergeRequestHead(r.github, glUrl, m.iid) !== m.sha) continue;
    const same = await sameWork(ctx, r, { glSha: m.sha, sha, entry, glUrl });
    if (same === null) return { unknown: true };
    if (same) return m;
  }
  return null;
}

/** One branch, GitHub → GitLab, under the one-writer rule. Returns { entry, bridged }: the branch's new state entry and
 * whether the GitLab branch is the bridge's copy (only then the bridge keeps a merge request for its pull request). */
async function branchStep(ctx, r, { b, gh, gl, entry, ghUrl, glUrl, act }) {
  const { git, dryRun = false, log = () => {} } = ctx;
  const e = entry ? { ...entry } : {};
  if (!gh) return { entry, bridged: false };
  const fetchHead = () => {
    const got = git.fetchBranch(r.github, ghUrl, b);
    if (got !== gh) throw new BridgeError(`branch ${b} moved on GitHub while it was read; it is copied at the next tick`, 'moved');
  };
  const copy = (action, expect, extra = {}) => act({ action, branch: b, from: gl, to: gh, ...extra }, () => {
    fetchHead();
    git.push(r.github, glUrl, gh, b, expect);
  });
  const own = e.gitlab ?? e.pushed; // the GitLab head that is the bridge's copy (with the merge bot's merges of main)
  if (gl === null) {
    // A head that already landed (its merge request merged, the source branch removed after merge) is not copied again,
    // also after a lost state; any other missing branch is created (new, or deleted on GitLab by a person).
    if (e.landed === gh) return { entry: e, bridged: true };
    const landed = await findLanded(ctx, r, { branch: b, sha: gh, entry: e, glUrl });
    if (landed?.unknown) {
      await act({ action: 'check_history', branch: b, github_head: gh, note: 'a merged merge request may hold this head' }, () => {});
      return { entry, bridged: false };
    }
    if (landed) {
      log('info', 'branch_landed', { repo: r.github, branch: b, head: gh, mr: landed.iid, note: 'not copied again; a new head on GitHub is copied' });
      return { entry: { pushed: gh, landed: gh }, bridged: true };
    }
    await copy('create_branch', null);
    return { entry: { pushed: gh }, bridged: true };
  }
  if (gl === gh) {
    if (e.pushed !== gh || e.gitlab) await act({ action: 'adopt_branch', branch: b, head: gh }, () => {});
    return { entry: { pushed: gh }, bridged: true };
  }
  if (own && gl === own) {
    if (gh === e.pushed) return { entry: e, bridged: true }; // GitLab has the bridge's copy plus the bot's merges of main
    await copy('update_branch', gl); // a new GitHub head, a force-push too; it replaces the bot's merges (it merges again)
    return { entry: { pushed: gh }, bridged: true };
  }
  // GitLab has this branch at a head the bridge did not push: copy only GitHub's own history (adopt), accept the merge
  // bot's clean merges of main on top of GitHub's history, else refuse.
  if (e.refused?.gitlab === gl && e.refused?.github === gh) return { entry: e, bridged: false };
  if (!dryRun) {
    fetchHead();
    if (git.fetchGitLabBranch(r.github, glUrl, b) !== gl) throw new BridgeError(`branch ${b} moved on GitLab while it was read; it is judged at the next tick`, 'moved');
  }
  const ancestor = git.isAncestor(r.github, gl, gh);
  if (ancestor) {
    await act({ action: 'adopt_and_update_branch', branch: b, from: gl, to: gh }, () => git.push(r.github, glUrl, gh, b, gl));
    return { entry: { pushed: gh }, bridged: true };
  }
  const mainHead = ancestor === null ? null : await ctx.gitlabMain(r, glUrl);
  const split = ancestor === null || !mainHead ? null : git.withoutMainMerges(r.github, gl, mainHead);
  if (ancestor === null || (mainHead && !split)) { // a dry run without the objects in the cache: a live run fetches first
    await act({ action: 'check_history', branch: b, gitlab_head: gl, github_head: gh }, () => {});
    return { entry, bridged: false };
  }
  if (split?.merges > 0 && (split.base === e.pushed || git.isAncestor(r.github, split.base, gh))) {
    if (split.base === gh) { // GitLab = the GitHub head plus the merge bot's merges of main: nothing to copy
      await act({ action: 'adopt_main_merge', branch: b, head: gh, gitlab_head: gl, merges: split.merges }, () => {});
      return { entry: { pushed: gh, gitlab: gl }, bridged: true };
    }
    await copy('update_branch', gl, { note: 'over the merge bot\'s merges of main' });
    return { entry: { pushed: gh }, bridged: true };
  }
  if (e.refused?.gitlab !== gl) {
    log('warn', 'branch_refused', {
      repo: r.github, branch: b, gitlab_head: gl, github_head: gh,
      reason: 'GitLab already has this branch with other history (another writer); nothing was pushed', see: 'RUNBOOK-github-bridge.md "A refused branch"',
    });
  }
  return { entry: { ...e, refused: { gitlab: gl, github: gh } }, bridged: false };
}

/** The merge request of one open pull request whose branch the bridge copied: create, update, land, statuses. */
async function pullRequestStep(ctx, r, { b, pr, mr, draft, before, me, pid, act, entry, glUrl }) {
  const { gitlab, log = () => {} } = ctx;
  const title = mrTitle(pr);
  const description = mrDescription(pr.body);
  if (!mr) {
    const all = await gitlab.paginate(`/projects/${pid}/merge_requests`, { query: { source_branch: b, target_branch: TARGET } });
    const same = all.filter((m) => m?.source_branch === b && m.source_project_id === m.target_project_id);
    const landed = await findLanded(ctx, r, { branch: b, sha: pr.head.sha, entry, glUrl, list: same });
    if (landed?.unknown) return undefined; // a dry run that cannot tell without a fetch
    if (landed) return closeLanded(ctx, r, { b, pr, mr: landed, act });
    const ours = (m) => m.sha === pr.head.sha || (entry.gitlab && m.sha === entry.gitlab && entry.pushed === pr.head.sha);
    const closed = same.find((m) => m.state === 'closed' && ours(m) && m.closed_by?.id !== me.id);
    if (closed) { // closed on GitLab by a person while the pull request is open: not opened again for this head
      if (draft.closed_seen !== closed.iid) {
        log('warn', 'merge_request_closed_on_gitlab', { repo: r.github, branch: b, pr: pr.number, mr: closed.iid, note: 'close the pull request, or push a new head to get a new merge request' });
        draft.closed_seen = closed.iid;
      }
      return undefined;
    }
    let created = null;
    await act({ action: 'create_merge_request', branch: b, pr: pr.number }, async () => {
      created = await gitlab.post(`/projects/${pid}/merge_requests`, { body: { source_branch: b, target_branch: TARGET, title, description } });
    });
    if (!created) return undefined; // a dry run
    mr = created;
  } else if (mr.author?.id !== me.id) { // a merge request a person opened from this branch: never rewritten
    if (draft.foreign_seen !== mr.iid) {
      log('info', 'merge_request_not_ours', { repo: r.github, branch: b, pr: pr.number, mr: mr.iid, note: 'opened by another account; its title and description are left as they are' });
      draft.foreign_seen = mr.iid;
    }
  } else if (!sameText(mr.title, title) || !sameText(mr.description, description)) {
    await act({ action: 'update_merge_request', branch: b, pr: pr.number, mr: mr.iid }, () => gitlab.put(`/projects/${pid}/merge_requests/${mr.iid}`, { body: { title, description } }));
  }
  delete draft.closed_seen;
  return statusStep(ctx, r, { b, pr, mr, draft, before, pid, act, entry });
}

/** Closes the pull request whose head landed, with one comment that links the landed commit (idempotent: the marker). */
async function closeLanded(ctx, r, { b, pr, mr, act }) {
  const { github } = ctx;
  if (ctx.githubPaused?.()) return; // a GitHub rate limit: the pull request is closed at a later tick
  const web = String(ctx.gitlabWebUrl ?? DEFAULTS.gitlabUrl).replace(/\/+$/, '');
  const landed = [mr.squash_commit_sha, mr.merge_commit_sha, mr.sha].find((s) => SHA.test(String(s)));
  const marker = `<!-- vitana-github-bridge: landed ${r.gitlab}!${mr.iid} -->`;
  const comments = await github.paginate(`/repos/${r.github}/issues/${pr.number}/comments`);
  if (!comments.some((c) => typeof c?.body === 'string' && c.body.includes(marker))) {
    const mrUrl = `${web}/${r.gitlab}/-/merge_requests/${mr.iid}`;
    const body = `${landed ? `Landed on GitLab as ${web}/${r.gitlab}/-/commit/${landed} (merge request ${mrUrl}).` : `Landed on GitLab: merge request ${mrUrl}.`} Closed by the GitHub bridge.\n\n${marker}`;
    await act({ action: 'comment_landed', branch: b, pr: pr.number, mr: mr.iid, commit: landed }, () => github.post(`/repos/${r.github}/issues/${pr.number}/comments`, { body: { body } }));
  }
  await act({ action: 'close_pull_request', branch: b, pr: pr.number, mr: mr.iid }, () => github.patch(`/repos/${r.github}/pulls/${pr.number}`, { body: { state: 'closed' } }));
}

const statusKey = (s) => `${s?.state ?? ''}\u0000${s?.target_url ?? ''}\u0000${s?.description ?? ''}`;
/** GitHub's latest status of each context on a commit (the combined status lists the latest one per context). */
async function latestStatuses(github, repo, sha) {
  const out = new Map();
  for (let page = 1; page <= 10; page++) {
    const data = await github.get(`/repos/${repo}/commits/${sha}/status`, { query: { per_page: 100, page } });
    const list = Array.isArray(data?.statuses) ? data.statuses : [];
    for (const s of list) if (typeof s?.context === 'string' && !out.has(s.context)) out.set(s.context, s);
    if (list.length < 100 || out.size >= Number(data?.total_count ?? 0)) break;
  }
  return out;
}

/** The gitlab/<job> statuses one pull request head needs, from the merge request's head pipeline when that pipeline is for
 * the PR head: one per job result, and a pending gitlab/gate while the pipeline runs without a gate result. They are queued
 * in ctx.statusQueue; postStatuses posts the queue of the whole tick. */
async function statusStep(ctx, r, { b, pr, mr, draft, before, pid, act, entry = {} }) {
  const { gitlab } = ctx;
  const sha = pr.head.sha;
  // The pipeline of the pull request head, or of that head with the merge bot's merges of main on top (then its results
  // are posted on the pull request head, the commit GitHub knows).
  const heads = new Set([sha]);
  if (entry.gitlab && entry.pushed === sha) heads.add(entry.gitlab);
  if (mr.sha && !heads.has(mr.sha)) return; // GitLab does not have the pull request head yet
  if (ctx.githubPaused?.()) return;
  const full = await gitlab.get(`/projects/${pid}/merge_requests/${mr.iid}`);
  const pipe = full?.head_pipeline;
  if (!pipe || !heads.has(pipe.sha) || !Number.isInteger(pipe.id)) return;
  const web = `${String(ctx.gitlabWebUrl ?? DEFAULTS.gitlabUrl).replace(/\/+$/, '')}/`;
  const onGitLab = (url) => (typeof url === 'string' && url.startsWith(web) ? url : undefined);
  const want = new Map();
  for (const job of await gitlab.paginate(`/projects/${pid}/pipelines/${pipe.id}/jobs`)) {
    if (typeof job?.name !== 'string' || job.name === '') continue;
    const s = jobToStatus(job);
    if (!s.settled) continue; // a job that is still waiting or running has no result yet
    want.set(statusContext(job.name), { state: s.state, description: s.description, target_url: onGitLab(job.web_url), unknown: s.unknown, status: job.status });
  }
  // Until the pipeline has a gate result, gitlab/gate is pending, so GitHub never shows only success while GitLab still
  // runs (plan-driver.mjs reads a pending status as pending). The real result replaces it. A pipeline that ended without a
  // gate job (the merge bot's ci.skip update of a train, plan §3.5) gets none: GitHub keeps what it shows.
  if (!want.has(GATE_CONTEXT) && !FINISHED_PIPELINE.has(pipe.status)) {
    want.set(GATE_CONTEXT, { state: 'pending', description: 'GitLab pipeline running', target_url: onGitLab(pipe.web_url) });
  }
  const fp = Object.fromEntries([...want].map(([c, s]) => [c, statusKey(s)]));
  if (draft.statuses?.sha === sha && JSON.stringify(draft.statuses.fp) === JSON.stringify(fp)) return; // nothing changed
  const writes = [...want].map(([context, s]) => ({ context, s, tier: statusTier(context, s) }));
  ctx.statusQueue.push({ r, b, pr, sha, fp, draft, before, act, writes });
}

/**
 * Posts the statuses the tick queued, within the status write budget of the tick (see tick). The gate results that are not
 * success go first, over every pull request of the tick, then the other gate results, then the rest; within each group in
 * the order the pull requests were read (rotation included) and the pipeline lists its jobs. So with any budget left, a red
 * or running pipeline never shows only success on GitHub while other writes wait. A head's cache entry (draft.statuses) is
 * written only when every status of that head is on GitHub; over budget, the rest is posted at a later tick, and the first
 * pull request of each repository left without a turn starts that repository's next tick. An error leaves that pull
 * request as it was before the tick; the others go on.
 */
async function postStatuses(ctx, queue, { next, errors }) {
  const { github, log = () => {} } = ctx;
  const budget = ctx.statusBudget ?? { left: Infinity, used: 0 };
  const prsOf = (q) => next.repos[q.r.github].prs;
  const commit = (q) => {
    q.draft.statuses = { sha: q.sha, fp: q.fp };
    prsOf(q)[q.pr.number] = q.draft;
  };
  const settle = (q) => { // one status of the head is on GitHub (posted now, or already the latest of its context)
    q.left -= 1;
    if (q.left === 0) commit(q);
  };
  const fail = (q, e) => {
    q.failed = true;
    errors.push({ repo: q.r.github, branch: q.b, pr: q.pr.number, message: messageOf(e) });
    log('error', 'pull_request_failed', { repo: q.r.github, branch: q.b, pr: q.pr.number, error: messageOf(e), retry: 'next tick' });
    if (q.before) prsOf(q)[q.pr.number] = q.before;
    else delete prsOf(q)[q.pr.number];
  };
  for (const q of queue) {
    q.posted = 0;
    q.left = q.writes.length;
    if (q.left === 0) commit(q); // a pipeline with nothing to post (it ended without a job result)
  }
  const order = queue.flatMap((q) => q.writes.map((w) => ({ q, ...w }))).sort((x, y) => x.tier - y.tier);
  let refused = null; // the first write the budget did not allow
  for (const { q, context, s } of order) {
    if (q.failed) continue;
    if (ctx.githubPaused?.()) break; // a write of this tick hit a rate limit
    if (!q.latest) {
      if (budget.left <= 0) { refused = q; break; }
      try {
        q.latest = await latestStatuses(github, q.r.github, q.sha);
      } catch (e) {
        fail(q, e);
        continue;
      }
    }
    if (q.latest.has(context) && statusKey(q.latest.get(context)) === statusKey(s)) { settle(q); continue; }
    if (budget.left <= 0) { refused = q; break; }
    budget.left -= 1;
    budget.used += 1;
    q.posted += 1;
    if (s.unknown) log('warn', 'unknown_job_status', { repo: q.r.github, pr: q.pr.number, context, status: String(s.status).slice(0, 60) });
    try {
      await q.act({ action: 'post_status', branch: q.b, pr: q.pr.number, sha: q.sha, context, state: s.state },
        () => github.post(`/repos/${q.r.github}/statuses/${q.sha}`, { body: { state: s.state, target_url: s.target_url, description: s.description, context } }));
    } catch (e) {
      fail(q, e);
      continue;
    }
    settle(q);
  }
  if (!refused) return;
  log('info', 'status_budget_reached', { repo: refused.r.github, pr: refused.pr.number, note: 'GitHub content write limit: the remaining statuses are posted at a later tick' });
  for (const q of queue) {
    const out = next.repos[q.r.github];
    if (q.posted === 0 && q.left > 0 && !q.failed && out.status_resume === undefined) out.status_resume = q.b;
  }
}

/** Closes each merge request the bridge opened whose pull request is no longer open into main, after GitHub confirms it. */
async function closeOrphans(ctx, r, { mrs, prs, me, pid, act, errors }) {
  const { github, gitlab, log = () => {} } = ctx;
  const owner = r.github.split('/')[0];
  for (const m of mrs) {
    if (m?.state !== 'opened' || m.author?.id !== me.id || m.source_project_id !== m.target_project_id || !isBridgedBranch(m.source_branch) || prs.has(m.source_branch)) continue;
    try {
      const still = await github.paginate(`/repos/${r.github}/pulls`, { query: { state: 'open', base: TARGET, head: `${owner}:${m.source_branch}` } });
      if (still.some((p) => eligible(p, r))) {
        log('warn', 'pull_request_list_inconsistent', { repo: r.github, branch: m.source_branch, mr: m.iid, note: 'an open pull request was missing from the list; nothing closed' });
        continue;
      }
      await act({ action: 'close_merge_request', branch: m.source_branch, mr: m.iid }, () => gitlab.put(`/projects/${pid}/merge_requests/${m.iid}`, { body: { state_event: 'close' } }));
    } catch (e) {
      errors.push({ repo: r.github, branch: m.source_branch, mr: m.iid, message: messageOf(e) });
      log('error', 'merge_request_failed', { repo: r.github, branch: m.source_branch, mr: m.iid, error: messageOf(e), retry: 'next tick' });
    }
  }
}

// ------------------------------------------------------------------------------------------------- assist commits
/**
 * Pushes an assist commit (plan §3.9) to the GitHub branch of a bridged branch with the bridge's GitHub token. Only when
 * the branch is a kiro/* or claude/* branch the bridge copied, GitLab still has the bridge's copy, `fromRef` on GitLab
 * points at `commit`, and the commit is one commit on top of the GitHub branch head (a fast-forward, pushed with that head
 * as the lease). Anything else is refused and pushes nothing. The next tick copies the new head to GitLab.
 * ctx: { repo, branch, commit, fromRef, git, state, dryRun, log } → { ok, action } or { ok: false, refused }.
 */
export async function assistPush({ repo, branch, commit, fromRef, git, state, dryRun = false, log = () => {} }) {
  const refuse = (reason, extra = {}) => {
    log('warn', 'assist_refused', { repo: repo?.github, branch: String(branch).slice(0, 200), reason, ...extra });
    return { ok: false, refused: reason };
  };
  if (!repo || !BRIDGE_REPOS.some((x) => x.github === repo.github)) return refuse('not one of the bridged repositories');
  if (!isBridgedBranch(branch)) return refuse('only a kiro/* or claude/* branch gets assist commits through the bridge');
  if (!SHA.test(String(commit))) return refuse('the commit must be a full 40-character sha');
  // Only a protected assist ref (plan §3.9: only bot-land and the owner may push there), never a branch any agent can push.
  if (!isPlainRef(fromRef) || !fromRef.startsWith('refs/heads/assist/')) return refuse('the source must be a protected assist ref (refs/heads/assist/...)');
  const entry = state?.repos?.[repo.github]?.branches?.[branch];
  if (!entry?.pushed) return refuse('the branch is not bridged: the bridge has not copied it');
  const { ghUrl, glUrl } = gitUrls({}, repo);
  const gh = git.lsRemote(ghUrl).get(branch) ?? null;
  const gl = git.lsRemote(glUrl).get(branch) ?? null;
  if (!gh) return refuse('the branch does not exist on GitHub');
  if (!gl || (gl !== entry.pushed && gl !== entry.gitlab)) return refuse('GitLab does not have the bridge copy of this branch (another writer, or not copied yet)', { gitlab_head: gl });
  if (!dryRun) {
    const tip = git.fetchRef(repo.github, glUrl, fromRef);
    if (tip !== commit) return refuse('the source ref does not point at the commit', { source_head: tip });
  } else if (!git.hasCommit(repo.github, commit)) {
    log('info', 'planned', { action: 'assist_push', repo: repo.github, branch, commit, note: 'a live run fetches the source ref and checks the commit first' });
    return { ok: true, dryRun: true, action: 'assist_push' };
  }
  const parents = git.parents(repo.github, commit);
  if (!parents || parents.length !== 1 || parents[0] !== gh) return refuse('the commit is not one commit on top of the GitHub branch head', { github_head: gh });
  if (dryRun) {
    log('info', 'planned', { action: 'assist_push', repo: repo.github, branch, commit, from: gh });
    return { ok: true, dryRun: true, action: 'assist_push' };
  }
  git.push(repo.github, ghUrl, commit, branch, gh);
  log('info', 'assist_pushed', { repo: repo.github, branch, commit, from: gh });
  return { ok: true, action: 'assist_pushed' };
}

// ------------------------------------------------------------------------------------------------- CLI
const USAGE = 'usage: github-bridge.mjs run [--dry-run] [options] | github-bridge.mjs assist-push --repo <owner/name> --branch <branch> --commit <sha> --from-ref <ref> [--dry-run] [options] (see the header of scripts/eng/github-bridge.mjs)';
const VALUE_OPTIONS = new Set(['state-dir', 'github-token-file', 'gitlab-token-file', 'gitlab-url', 'github-api-url', 'github-git-base', 'gitlab-git-base', 'repo', 'branch', 'commit', 'from-ref']);
const TOKEN_OPTIONS = new Set(['token', 'github-token', 'gitlab-token', 'private-token', 'access-token']);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run' && cmd !== 'assist-push') throw new BridgeError(USAGE, 'usage');
  const o = { cmd, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(rest[i]);
    if (!m) throw new BridgeError(`unexpected argument at position ${i + 2}; ${USAGE}`, 'usage'); // never echoed: it could be a token
    const k = m[1];
    if (TOKEN_OPTIONS.has(k)) throw new BridgeError(`--${k} is not an option: tokens are read from files (--github-token-file, --gitlab-token-file)`, 'usage');
    if (k === 'dry-run' && m[2] === undefined) { o.dryRun = true; continue; }
    if (!VALUE_OPTIONS.has(k)) throw new BridgeError(`unknown option --${k}; ${USAGE}`, 'usage');
    const v = m[2] ?? rest[++i];
    if (v === undefined) throw new BridgeError(`--${k} needs a value`, 'usage');
    o[k.replace(/-([a-z])/g, (_x, c) => c.toUpperCase())] = v; // a repeated option: the last one wins
  }
  return o;
}
function httpsBase(value, name) {
  let u;
  try { u = new URL(value); } catch { throw new BridgeError(`${name} must be an https URL`, 'usage'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new BridgeError(`${name} must be an https URL without credentials, query or fragment`, 'usage');
  return u.href.replace(/\/+$/, '');
}
const gitBase = (value, name) => (path.isAbsolute(value) ? value.replace(/\/+$/, '') : httpsBase(value, name));
const absolute = (value, name) => {
  if (!path.isAbsolute(value)) throw new BridgeError(`${name} must be an absolute path`, 'usage');
  return value;
};

/** The CLI. deps (tests): { fetch, spawnSync, sleep, stdout, stderr, now }. Returns the exit code. */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? (() => new Date());
  let clean = makeRedactor([]);
  const log = (level, event, fields = {}) => { stdout.write(`${clean(JSON.stringify({ at: now().toISOString(), level, event, ...fields }))}\n`); };
  let setup;
  try {
    const o = parseArgs(argv);
    const stateDir = absolute(o.stateDir ?? DEFAULTS.stateDir, '--state-dir');
    const gitlabUrl = httpsBase(o.gitlabUrl ?? DEFAULTS.gitlabUrl, '--gitlab-url');
    const githubApiUrl = httpsBase(o.githubApiUrl ?? DEFAULTS.githubApiUrl, '--github-api-url');
    const githubGitBase = gitBase(o.githubGitBase ?? DEFAULTS.githubGitBase, '--github-git-base');
    const gitlabGitBase = gitBase(o.gitlabGitBase ?? gitlabUrl, '--gitlab-git-base');
    if (o.cmd === 'assist-push') {
      if (!BRIDGE_REPOS.some((x) => x.github === o.repo)) throw new BridgeError(`--repo must be one of ${BRIDGE_REPOS.map((x) => x.github).join(', ')}`, 'usage');
      for (const k of ['branch', 'commit', 'fromRef']) if (!o[k]) throw new BridgeError(`assist-push needs --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, 'usage');
    }
    const ghToken = readTokenFile(o.githubTokenFile ?? DEFAULTS.githubTokenFile);
    const glToken = readTokenFile(o.gitlabTokenFile ?? DEFAULTS.gitlabTokenFile);
    clean = makeRedactor([ghToken, glToken]);
    const stateFile = path.join(stateDir, 'state.json');
    const state = loadState(stateFile);
    const repos = BRIDGE_REPOS.map(({ github, gitlab }) => ({ github, gitlab, githubGitUrl: `${githubGitBase}/${github}.git`, gitlabGitUrl: `${gitlabGitBase}/${gitlab}.git` }));
    const credentials = [[githubGitBase, 'github', ghToken], [gitlabGitBase, 'gitlab', glToken]]
      .filter(([b]) => !path.isAbsolute(b)).map(([url, kind, token]) => ({ url, kind, token }));
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const sleep = deps.sleep ? { sleep: deps.sleep } : {};
    setup = {
      o, state, stateFile, repos, gitlabUrl,
      github: createGitHubClient({ token: ghToken, baseUrl: githubApiUrl, fetch: fetchImpl, ...sleep }),
      gitlab: createClient({ baseUrl: gitlabUrl, token: glToken, fetch: fetchImpl, ...sleep }),
      git: createGit({ cacheDir: path.join(stateDir, 'cache'), credentials, spawnSync: deps.spawnSync ?? nodeSpawnSync }),
    };
  } catch (e) {
    stderr.write(`github-bridge: ${clean(messageOf(e))}\n`);
    return 2;
  }
  const { o, state, stateFile, repos, gitlabUrl, github, gitlab, git } = setup;
  try {
    if (o.cmd === 'run' && o.dryRun) {
      // A dry run (often run by a person as root) only reads the service's cache, through a throw-away repository.
      const scratch = git.scratch(repos.map((x) => x.github));
      try {
        const res = await tick({ repos, github, gitlab, git: scratch, state, dryRun: true, log, gitlabWebUrl: gitlabUrl });
        return res.errors.length ? 1 : 0;
      } finally {
        scratch.dispose();
      }
    }
    if (o.cmd === 'run') {
      const res = await tick({ repos, github, gitlab, git, state, dryRun: false, log, gitlabWebUrl: gitlabUrl });
      saveState(stateFile, res.state);
      return res.errors.length ? 1 : 0;
    }
    // An assist push may run as another user than the timer (root, the merge bot): it works in a throw-away repository
    // that only reads the service's cache, so it never writes a file the service then cannot write.
    const scratch = git.scratch([o.repo]);
    try {
      const res = await assistPush({ repo: repos.find((x) => x.github === o.repo), branch: o.branch, commit: o.commit, fromRef: o.fromRef, git: scratch, state, dryRun: o.dryRun, log });
      return res.ok ? 0 : 3;
    } finally {
      scratch.dispose();
    }
  } catch (e) {
    log('error', 'failed', { command: o.cmd, error: messageOf(e) });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}

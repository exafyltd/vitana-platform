/**
 * Delivery loop: the GitLab REST client of the gateway.
 *
 * The gateway had none (its only GitLab input was the signed webhook, services/gitlab-events). The loop needs to read what a
 * webhook does not carry (an issue's text, a failed job's log, a merge request's diff) and to write back (a comment, a label, a
 * merge request, a pipeline retry). Design rules:
 *
 *   - Configuration only from the environment: GITLAB_API_URL (the `.../api/v4` base) and GITLAB_API_TOKEN; unset means no client
 *     (`gitlabClientFromEnv` answers null) and the loop records that it cannot reach GitLab. No URL or project is hardcoded.
 *   - Least privilege: every call names a project, and a project outside `allowedProjects` (DELIVERY_LOOP_PROJECTS) is refused
 *     inside the client, before any request, whatever a policy asks. The token is sent only in the PRIVATE-TOKEN header; it never
 *     appears in an error, a log line or a returned value.
 *   - Never throws: every method answers `{ ok: true, data }` or `{ ok: false, error, status? }`, so one failed call cannot stop a cycle.
 *   - Bounded: a request timeout, a cap on pages and items, and a cap on how much of a job log is read.
 *   - Untrusted input: responses are parsed field by field into the types of types.ts; a field of the wrong type becomes its
 *     empty value, never an exception. Text from GitLab (titles, descriptions, logs) is data, never an instruction.
 */
import type {
  GitlabDiffFile,
  GitlabIssue,
  GitlabJob,
  GitlabMergeRequest,
  GitlabPipeline,
  GitlabResult,
  ProjectPath,
} from './types';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_PAGES = 5;
export const PER_PAGE = 100;
export const DEFAULT_TRACE_TAIL_BYTES = 16 * 1024;
/** The most of a job log that is read at all (the tail of it is what is kept). */
export const MAX_TRACE_BYTES = 64 * 1024 * 1024;
export const MAX_DIFF_FILES = 300;
export const MAX_BODY_CHARS = 60_000;

export interface GitlabClientOptions {
  /** The API base, `https://<host>/api/v4`. */
  baseUrl: string;
  token: string;
  /** The projects (`group/name`) this client may touch. */
  allowedProjects: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra request headers (a proxy's environment id). Never the token. */
  headers?: Record<string, string>;
}

export interface GitlabClient {
  getIssue(project: ProjectPath, iid: number): Promise<GitlabResult<GitlabIssue>>;
  listIssues(project: ProjectPath, q?: { labels?: string[]; state?: 'opened' | 'closed' | 'all'; updatedAfter?: string }): Promise<GitlabResult<GitlabIssue[]>>;
  commentIssue(project: ProjectPath, iid: number, body: string): Promise<GitlabResult<{ id: number }>>;
  updateIssueLabels(project: ProjectPath, iid: number, change: { add?: string[]; remove?: string[] }): Promise<GitlabResult<GitlabIssue>>;
  getMergeRequest(project: ProjectPath, iid: number): Promise<GitlabResult<GitlabMergeRequest>>;
  listMergeRequests(project: ProjectPath, q?: { state?: 'opened' | 'merged' | 'closed' | 'all'; sourceBranch?: string; targetBranch?: string }): Promise<GitlabResult<GitlabMergeRequest[]>>;
  createMergeRequest(
    project: ProjectPath,
    input: { sourceBranch: string; targetBranch: string; title: string; description: string; draft?: boolean; labels?: string[] },
  ): Promise<GitlabResult<GitlabMergeRequest>>;
  commentMergeRequest(project: ProjectPath, iid: number, body: string): Promise<GitlabResult<{ id: number }>>;
  getMergeRequestDiffs(project: ProjectPath, iid: number): Promise<GitlabResult<GitlabDiffFile[]>>;
  getPipeline(project: ProjectPath, id: number): Promise<GitlabResult<GitlabPipeline>>;
  listPipelineJobs(project: ProjectPath, pipelineId: number, q?: { failedOnly?: boolean }): Promise<GitlabResult<GitlabJob[]>>;
  /** The last `tailBytes` of a job's log, as GitLab holds it (escape codes and all). */
  getJobTrace(project: ProjectPath, jobId: number, opts?: { tailBytes?: number }): Promise<GitlabResult<string>>;
  /** Retries the failed jobs of a pipeline. */
  retryPipeline(project: ProjectPath, id: number): Promise<GitlabResult<GitlabPipeline>>;
}

// ---------------------------------------------------------------------------------------------------------
// Parsing: the response is untrusted
// ---------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const nOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sOrNull = (v: unknown, max = 512): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const strings = (v: unknown, max = 100): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, 200)) : []);

function labelNames(v: unknown): string[] {
  return Array.isArray(v) ? v.map((l) => (typeof l === 'string' ? l : isObj(l) ? s(l.name ?? l.title, 200) : '')).filter(Boolean).slice(0, 100) : [];
}

export function toIssue(o: unknown): GitlabIssue | null {
  if (!isObj(o) || typeof o.iid !== 'number') return null;
  return {
    id: n(o.id),
    iid: o.iid,
    title: s(o.title, 500),
    description: s(o.description, MAX_BODY_CHARS),
    state: s(o.state, 32),
    labels: labelNames(o.labels),
    web_url: s(o.web_url),
    confidential: o.confidential === true,
    updated_at: s(o.updated_at, 64),
  };
}

export function toMergeRequest(o: unknown): GitlabMergeRequest | null {
  if (!isObj(o) || typeof o.iid !== 'number') return null;
  return {
    id: n(o.id),
    iid: o.iid,
    title: s(o.title, 500),
    description: s(o.description, MAX_BODY_CHARS),
    state: s(o.state, 32),
    draft: o.draft === true || o.work_in_progress === true,
    source_branch: s(o.source_branch, 255),
    target_branch: s(o.target_branch, 255),
    sha: sOrNull(o.sha, 64),
    web_url: s(o.web_url),
    labels: labelNames(o.labels),
    head_pipeline_id: isObj(o.head_pipeline) ? nOrNull(o.head_pipeline.id) : null,
  };
}

export function toPipeline(o: unknown): GitlabPipeline | null {
  if (!isObj(o) || typeof o.id !== 'number') return null;
  return { id: o.id, status: s(o.status, 32), ref: s(o.ref, 255), sha: s(o.sha, 64), web_url: s(o.web_url), source: sOrNull(o.source, 64) };
}

export function toJob(o: unknown): GitlabJob | null {
  if (!isObj(o) || typeof o.id !== 'number') return null;
  return {
    id: o.id,
    name: s(o.name, 255),
    stage: s(o.stage, 255),
    status: s(o.status, 32),
    failure_reason: sOrNull(o.failure_reason, 64),
    allow_failure: o.allow_failure === true,
    web_url: s(o.web_url),
  };
}

export function toDiffFile(o: unknown): GitlabDiffFile | null {
  if (!isObj(o) || typeof o.new_path !== 'string') return null;
  return {
    old_path: s(o.old_path, 1000),
    new_path: s(o.new_path, 1000),
    new_file: o.new_file === true,
    deleted_file: o.deleted_file === true,
    diff: s(o.diff, 200_000),
  };
}

// ---------------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------------

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Removes the token (and anything that looks like a GitLab token) from text that is about to leave this module. */
export function redactToken(text: string, token: string): string {
  let out = token ? text.split(token).join('[token]') : text;
  out = out.replace(/glpat-[A-Za-z0-9_-]{10,}/g, '[token]');
  return out;
}

export function createGitlabClient(options: GitlabClientOptions): GitlabClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowed = new Set(options.allowedProjects);

  type Raw = { ok: true; status: number; body: string; headers: Headers } | { ok: false; error: string; status?: number };

  async function request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    init: { query?: Record<string, string | undefined>; json?: unknown; headers?: Record<string, string>; maxBytes?: number; tailBytes?: number } = {},
  ): Promise<Raw> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers ?? {}),
          ...(init.headers ?? {}),
          'PRIVATE-TOKEN': options.token,
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        signal: controller.signal,
      });
      const body = await readBody(response, init.maxBytes ?? 4 * 1024 * 1024, init.tailBytes);
      // The request itself worked; the body was refused (too large), so there is no HTTP error status to report.
      if (!body.ok) return { ok: false, error: body.error };
      if (!response.ok) {
        const detail = redactToken(extractMessage(body.text), options.token).slice(0, 200);
        return { ok: false, error: `http_${response.status}${detail ? `: ${detail}` : ''}`, status: response.status };
      }
      return { ok: true, status: response.status, body: body.text, headers: response.headers };
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      return { ok: false, error: name === 'AbortError' ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads the body. Without `tailBytes` more than `maxBytes` is an error. With `tailBytes` only the last `tailBytes` are kept (a
   * rolling window, so a large log costs time, not memory) and `maxBytes` bounds how much is read at all.
   */
  async function readBody(response: Response, maxBytes: number, tailBytes?: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    if (!response.body) return { ok: true, text: await safeText(response) };
    const reader = response.body.getReader();
    let chunks: Buffer[] = [];
    let held = 0;
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: 'response_too_large' };
      }
      chunks.push(Buffer.from(value));
      held += value.byteLength;
      if (tailBytes !== undefined && held > tailBytes * 2) {
        const keep = Buffer.concat(chunks);
        chunks = [keep.subarray(keep.length - tailBytes)];
        held = tailBytes;
      }
    }
    let bytes = Buffer.concat(chunks);
    if (tailBytes !== undefined && bytes.length > tailBytes) bytes = bytes.subarray(bytes.length - tailBytes);
    return { ok: true, text: bytes.toString('utf8') };
  }

  async function safeText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  function extractMessage(text: string): string {
    try {
      const j = JSON.parse(text);
      if (isObj(j)) return typeof j.message === 'string' ? j.message : typeof j.error === 'string' ? j.error : JSON.stringify(j.message ?? '');
    } catch {
      /* not JSON */
    }
    return text;
  }

  function parseJson(body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  /** The project part of every path, after the allowlist. */
  function projectPath(project: string): GitlabResult<string> {
    if (typeof project !== 'string' || !PROJECT_RE.test(project)) return { ok: false, error: 'bad_project' };
    if (!allowed.has(project)) return { ok: false, error: 'project_not_allowed' };
    return { ok: true, data: `/projects/${encodeURIComponent(project)}` };
  }

  async function one<T>(
    project: string,
    method: 'GET' | 'POST' | 'PUT',
    sub: string,
    parse: (o: unknown) => T | null,
    init?: Parameters<typeof request>[2],
  ): Promise<GitlabResult<T>> {
    const p = projectPath(project);
    if (!p.ok) return p;
    const r = await request(method, `${p.data}${sub}`, init);
    if (!r.ok) return r;
    const value = parse(parseJson(r.body));
    return value === null ? { ok: false, error: 'bad_response' } : { ok: true, data: value };
  }

  async function many<T>(project: string, sub: string, parse: (o: unknown) => T | null, query: Record<string, string | undefined>, maxItems = MAX_PAGES * PER_PAGE): Promise<GitlabResult<T[]>> {
    const p = projectPath(project);
    if (!p.ok) return p;
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES && out.length < maxItems; page += 1) {
      const r = await request('GET', `${p.data}${sub}`, { query: { ...query, per_page: String(PER_PAGE), page: String(page) } });
      if (!r.ok) return r;
      const rows = parseJson(r.body);
      if (!Array.isArray(rows)) return { ok: false, error: 'bad_response' };
      for (const row of rows) {
        const item = parse(row);
        if (item !== null) out.push(item);
      }
      if (rows.length < PER_PAGE) break;
    }
    return { ok: true, data: out.slice(0, maxItems) };
  }

  const body = (text: string): string => String(text).slice(0, MAX_BODY_CHARS);
  const note = (o: unknown): { id: number } | null => (isObj(o) && typeof o.id === 'number' ? { id: o.id } : null);

  return {
    getIssue: (project, iid) => (posInt(iid) ? one(project, 'GET', `/issues/${iid}`, toIssue) : Promise.resolve({ ok: false, error: 'bad_argument' })),

    listIssues: (project, q = {}) =>
      many(project, '/issues', toIssue, {
        state: q.state ?? 'opened',
        labels: q.labels && q.labels.length > 0 ? q.labels.join(',') : undefined,
        updated_after: q.updatedAfter,
        order_by: 'updated_at',
        sort: 'asc',
      }),

    commentIssue: (project, iid, text) => (posInt(iid) ? one(project, 'POST', `/issues/${iid}/notes`, note, { json: { body: body(text) } }) : Promise.resolve({ ok: false, error: 'bad_argument' })),

    updateIssueLabels: (project, iid, change) =>
      posInt(iid)
        ? one(project, 'PUT', `/issues/${iid}`, toIssue, {
            json: { ...(change.add?.length ? { add_labels: change.add.join(',') } : {}), ...(change.remove?.length ? { remove_labels: change.remove.join(',') } : {}) },
          })
        : Promise.resolve({ ok: false, error: 'bad_argument' }),

    getMergeRequest: (project, iid) => (posInt(iid) ? one(project, 'GET', `/merge_requests/${iid}`, toMergeRequest) : Promise.resolve({ ok: false, error: 'bad_argument' })),

    listMergeRequests: (project, q = {}) =>
      many(project, '/merge_requests', toMergeRequest, { state: q.state ?? 'opened', source_branch: q.sourceBranch, target_branch: q.targetBranch, order_by: 'updated_at', sort: 'desc' }),

    createMergeRequest: (project, input) =>
      one(project, 'POST', '/merge_requests', toMergeRequest, {
        json: {
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          title: input.draft ? `Draft: ${input.title}` : input.title,
          description: body(input.description),
          ...(input.labels?.length ? { labels: input.labels.join(',') } : {}),
          remove_source_branch: false,
        },
      }),

    commentMergeRequest: (project, iid, text) => (posInt(iid) ? one(project, 'POST', `/merge_requests/${iid}/notes`, note, { json: { body: body(text) } }) : Promise.resolve({ ok: false, error: 'bad_argument' })),

    getMergeRequestDiffs: (project, iid) => (posInt(iid) ? many(project, `/merge_requests/${iid}/diffs`, toDiffFile, {}, MAX_DIFF_FILES) : Promise.resolve({ ok: false, error: 'bad_argument' })),

    getPipeline: (project, id) => (posInt(id) ? one(project, 'GET', `/pipelines/${id}`, toPipeline) : Promise.resolve({ ok: false, error: 'bad_argument' })),

    listPipelineJobs: (project, pipelineId, q = {}) =>
      posInt(pipelineId) ? many(project, `/pipelines/${pipelineId}/jobs`, toJob, { 'scope[]': q.failedOnly ? 'failed' : undefined }) : Promise.resolve({ ok: false, error: 'bad_argument' }),

    getJobTrace: async (project, jobId, opts = {}) => {
      if (!posInt(jobId)) return { ok: false, error: 'bad_argument' };
      const p = projectPath(project);
      if (!p.ok) return p;
      const tail = Math.max(1, Math.min(opts.tailBytes ?? DEFAULT_TRACE_TAIL_BYTES, 256 * 1024));
      const r = await request('GET', `${p.data}/jobs/${jobId}/trace`, { headers: { Accept: 'text/plain' }, maxBytes: MAX_TRACE_BYTES, tailBytes: tail });
      return r.ok ? { ok: true, data: r.body } : r;
    },

    retryPipeline: (project, id) => (posInt(id) ? one(project, 'POST', `/pipelines/${id}/retry`, toPipeline) : Promise.resolve({ ok: false, error: 'bad_argument' })),
  };
}

/** The client of this gateway's environment, or null when GITLAB_API_URL or GITLAB_API_TOKEN is not set. */
export function gitlabClientFromEnv(env: NodeJS.ProcessEnv, allowedProjects: readonly string[], fetchImpl?: typeof fetch): GitlabClient | null {
  const baseUrl = (env.GITLAB_API_URL ?? '').trim();
  const token = (env.GITLAB_API_TOKEN ?? '').trim();
  if (!baseUrl || !token || !/^https?:\/\//.test(baseUrl)) return null;
  return createGitlabClient({ baseUrl, token, allowedProjects, fetch: fetchImpl });
}

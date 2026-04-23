/**
 * GitHub REST API client for the worker — branch creation, file writes, PR
 * opening. Mirror of the helpers that previously lived on the gateway in
 * services/gateway/src/services/dev-autopilot-execute.ts.
 *
 * Why this lives in the worker now
 * --------------------------------
 * The gateway version sat inside `runExecutionSession` which ran on Cloud
 * Run as a fire-and-forget background promise. Cloud Run recycles
 * containers every few minutes and routinely killed the gateway mid-write,
 * leaving execution rows stuck in 'running' (we shipped a watchdog for
 * that, but stuck rows never produced a merged PR).
 *
 * The worker process is long-lived on the developer workstation (or a VM)
 * and doesn't get recycled mid-task. Moving these calls here means the
 * "claude → validate → branch → write → PR" sequence runs in a single
 * process from start to finish.
 *
 * Auth: GITHUB_SAFE_MERGE_TOKEN (or DEV_AUTOPILOT_GITHUB_TOKEN /
 * GITHUB_TOKEN as fallbacks). Same precedence the gateway used.
 */

const LOG_PREFIX = '[autopilot-worker/github]';

const GITHUB_OWNER = process.env.AUTOPILOT_WORKER_GITHUB_OWNER || 'exafyltd';
const GITHUB_REPO = process.env.AUTOPILOT_WORKER_GITHUB_REPO || 'vitana-platform';

function getToken(): string {
  return process.env.GITHUB_SAFE_MERGE_TOKEN
      || process.env.DEV_AUTOPILOT_GITHUB_TOKEN
      || process.env.GITHUB_TOKEN
      || '';
}

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): Promise<ApiResult<T>> {
  const token = getToken();
  if (!token) {
    return { ok: false, status: 0, error: 'GITHUB_SAFE_MERGE_TOKEN not set on worker — can\'t talk to GitHub' };
  }
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: init.accept || 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'vitana-autopilot-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: init.body != null ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      return { ok: false, status: res.status, error: `${res.status}: ${body}` };
    }
    if (res.status === 204) return { ok: true, status: 204 };
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

function encodePath(path: string): string {
  return path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

/** Look up a file's current sha + content on a given ref. Returns
 * { exists: false } cleanly on 404 (the file doesn't exist yet). */
export async function fetchFileContent(
  path: string,
  ref: string,
): Promise<{ exists: boolean; content?: string; sha?: string; error?: string }> {
  const r = await api<{ content: string; encoding: string; sha: string }>(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (!r.ok) {
    if (r.status === 404) return { exists: false };
    return { exists: false, error: r.error };
  }
  if (!r.data) return { exists: false };
  const decoded = Buffer.from(r.data.content || '', (r.data.encoding as BufferEncoding) || 'base64').toString('utf-8');
  return { exists: true, content: decoded, sha: r.data.sha };
}

/** Get the head sha of a branch. */
export async function getBranchSha(branch: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const r = await api<{ object: { sha: string } }>(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error || 'ref lookup failed' };
  return { ok: true, sha: r.data.object.sha };
}

/** Create a branch from baseBranch's HEAD. If `branch` already exists
 * (from a prior failed run on the same execution id), delete it first so we
 * write a clean tree. Safe because these branches are always
 * `dev-autopilot/...` prefixed. */
export async function createBranch(
  branch: string,
  baseBranch: string,
): Promise<{ ok: boolean; error?: string }> {
  const base = await getBranchSha(baseBranch);
  if (!base.ok || !base.sha) return { ok: false, error: `base branch lookup: ${base.error}` };

  const existing = await getBranchSha(branch);
  if (existing.ok) {
    const del = await api(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: 'DELETE' },
    );
    if (!del.ok) return { ok: false, error: `could not delete stale branch ${branch}: ${del.error}` };
  }

  const create = await api(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`,
    { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: base.sha } },
  );
  if (!create.ok) return { ok: false, error: `create branch ${branch}: ${create.error}` };
  return { ok: true };
}

/** Create or update a file on a branch. Pass existingSha when modifying an
 * existing file (GitHub requires it for atomic update). */
export async function putFileToBranch(
  branch: string,
  path: string,
  content: string,
  message: string,
  existingSha?: string,
): Promise<{ ok: boolean; error?: string }> {
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  const body: Record<string, unknown> = { message, content: base64, branch };
  if (existingSha) body.sha = existingSha;
  const r = await api(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`,
    { method: 'PUT', body },
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

export async function deleteFileOnBranch(
  branch: string,
  path: string,
  message: string,
  sha: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await api(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`,
    { method: 'DELETE', body: { message, sha, branch } },
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

export async function openPullRequest(
  branch: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<{ ok: boolean; url?: string; number?: number; error?: string }> {
  const r = await api<{ html_url: string; number: number }>(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`,
    {
      method: 'POST',
      body: {
        title: title.slice(0, 240),
        head: branch,
        base: baseBranch,
        body,
        maintainer_can_modify: true,
        draft: false,
      },
    },
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error };
  return { ok: true, url: r.data.html_url, number: r.data.number };
}

export { LOG_PREFIX, GITHUB_OWNER, GITHUB_REPO };

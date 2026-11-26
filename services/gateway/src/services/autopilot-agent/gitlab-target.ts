/**
 * GitLab-native repair target of a Dev Autopilot execution.
 *
 * Owner instruction 2026-11-19: "Implement the GitLab failure adapter against the existing self-healing architecture, but make it
 * GitLab-native. Do not route GitLab failures through GitHub PRs."
 *
 * The delivery loop hands Dev Autopilot a failed GitLab merge-request pipeline (services/dev-autopilot-gitlab-repair.ts). The execution
 * that repairs it carries `metadata.host = 'gitlab'` and this target in `metadata.gitlab`. Its branch belongs to the GitLab merge
 * request: nothing on GitHub is looked up, opened, closed or merged for it, and it never gets a PR field. The agent runner clones that
 * branch from GitLab at the head whose pipeline failed, adds one commit, and pushes it with a lease on that head; GitLab's pipeline
 * judges the result and the delivery loop reads it.
 *
 * `isGitlabExecution` is broad on purpose. Any row that claims to be GitLab-hosted (the host flag, or any `gitlab` block, valid or not)
 * is GitLab-hosted for every guard, so a malformed row fails safe (it is refused) instead of falling through to the GitHub paths of the
 * bridge and the runner (PR close, branch delete, PR open).
 */

export const GITLAB_HOST = 'gitlab';

/**
 * The executor's own GitLab token (`write_repository` on the projects the loop repairs). It is not the delivery loop's API token
 * (GITLAB_API_TOKEN, which reads and comments): pushing code is a different permission and gets its own secret.
 */
export const GITLAB_EXECUTOR_TOKEN_ENV = 'DEV_AUTOPILOT_GITLAB_TOKEN';

export interface GitlabTarget {
  /** `group/name` of the GitLab project. */
  project_path: string;
  mr_iid: number;
  mr_url: string | null;
  /** The merge request's own branch: the only branch the repair may add a commit to. */
  source_branch: string;
  /** The branch the merge request merges into; read for the merge base, never written. */
  target_branch: string;
  /** The pipeline that failed. */
  pipeline_id: number;
  /** The head that failed: the clone must be at it, and the push is leased on it. */
  sha: string;
  /** The delivery loop's work (shared by the attempts at one failure). */
  work_key: string;
  /** The delivery loop's attempt: one execution per dispatch key. */
  dispatch_key: string;
}

/** True for any row that claims to be GitLab-hosted, valid or not: every guard treats such a row as GitLab's. */
export function isGitlabExecution(row: { metadata?: unknown } | null | undefined): boolean {
  const m = row && typeof row === 'object' ? (row as { metadata?: unknown }).metadata : null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const meta = m as Record<string, unknown>;
  if (typeof meta.host === 'string' && meta.host.toLowerCase() === GITLAB_HOST) return true;
  return meta.gitlab !== undefined && meta.gitlab !== null;
}

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const NEVER_REPAIRED = new Set(['main', 'master', 'head']);

/** Why `b` is not a branch name this code passes to git, or null. A name can never be read as an option (it starts with a letter or digit). */
export function badBranchName(b: unknown): string | null {
  if (typeof b !== 'string' || b.length === 0 || b.length > 255) return 'empty or longer than 255 characters';
  if (!BRANCH_RE.test(b)) return 'it has characters this executor does not pass to git';
  if (b.includes('..') || b.includes('//') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock') || b.includes('@{')) return 'it is not a valid branch name';
  return null;
}

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const key = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 500;

/** The GitLab target of an execution, validated, or why it is not one. */
export function parseGitlabTarget(metadata: unknown): { ok: true; target: GitlabTarget } | { ok: false; error: string } {
  if (!isGitlabExecution({ metadata })) return { ok: false, error: 'not a GitLab-hosted execution' };
  const g = (metadata as Record<string, unknown>).gitlab;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return { ok: false, error: 'metadata.gitlab is missing' };
  const t = g as Record<string, unknown>;
  if (typeof t.project_path !== 'string' || !PROJECT_RE.test(t.project_path) || t.project_path.length > 255) return { ok: false, error: 'project_path is not group/name' };
  if (!posInt(t.mr_iid)) return { ok: false, error: 'mr_iid is not a positive integer' };
  if (!posInt(t.pipeline_id)) return { ok: false, error: 'pipeline_id is not a positive integer' };
  if (typeof t.sha !== 'string' || !SHA_RE.test(t.sha)) return { ok: false, error: 'sha is not a full lower-case commit sha' };
  const sourceBad = badBranchName(t.source_branch);
  if (sourceBad) return { ok: false, error: `source_branch: ${sourceBad}` };
  const targetBad = badBranchName(t.target_branch);
  if (targetBad) return { ok: false, error: `target_branch: ${targetBad}` };
  const source = t.source_branch as string;
  const target = t.target_branch as string;
  if (NEVER_REPAIRED.has(source.toLowerCase())) return { ok: false, error: `source_branch ${source} is never repaired` };
  if (source === target) return { ok: false, error: 'source_branch is the target branch' };
  if (!key(t.work_key)) return { ok: false, error: 'work_key is missing' };
  if (!key(t.dispatch_key)) return { ok: false, error: 'dispatch_key is missing' };
  if (t.mr_url !== null && t.mr_url !== undefined && (typeof t.mr_url !== 'string' || !t.mr_url.startsWith('https://') || t.mr_url.length > 2000)) {
    return { ok: false, error: 'mr_url is not an https URL' };
  }
  return {
    ok: true,
    target: {
      project_path: t.project_path,
      mr_iid: t.mr_iid,
      mr_url: typeof t.mr_url === 'string' ? t.mr_url : null,
      source_branch: source,
      target_branch: target,
      pipeline_id: t.pipeline_id,
      sha: t.sha,
      work_key: t.work_key,
      dispatch_key: t.dispatch_key,
    },
  };
}

/** Where the executor reaches GitLab (the origin of GITLAB_API_URL) and with which token, or why it cannot. Never carries the token in an error. */
export function gitlabExecutorConfig(env: NodeJS.ProcessEnv = process.env): { ok: true; origin: string; token: string } | { ok: false; error: string } {
  const api = (env.GITLAB_API_URL || '').trim();
  if (!api) return { ok: false, error: 'GITLAB_API_URL is not set' };
  let u: URL;
  try {
    u = new URL(api);
  } catch {
    return { ok: false, error: 'GITLAB_API_URL is not a URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'GITLAB_API_URL must be https' };
  const token = (env[GITLAB_EXECUTOR_TOKEN_ENV] || '').trim();
  if (!token) return { ok: false, error: `${GITLAB_EXECUTOR_TOKEN_ENV} is not set` };
  return { ok: true, origin: u.origin, token };
}

/** The clone URL of a GitLab project: `https://oauth2:<token>@<host>/<group>/<name>.git`. The token is URL-encoded and lives only here. */
export function gitlabRemoteUrl(origin: string, projectPath: string, token: string): string {
  const u = new URL(origin);
  return `${u.protocol}//oauth2:${encodeURIComponent(token)}@${u.host}/${projectPath}.git`;
}

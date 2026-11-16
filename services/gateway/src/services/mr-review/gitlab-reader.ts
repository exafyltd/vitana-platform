/**
 * GitLab read access for the reviewer: the MR (head SHA and state), its changes, and read-only repository
 * tools pinned to the review's head SHA. Read-only by construction: only GET requests are made. The token
 * is a read token for the one project. `search` is not offered, because it cannot be pinned to a commit.
 */
import type { GitLabMrReader, MrChangeFile } from './review-context';
import type { ExecuteTool } from '../plan-sparring/partner';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GitlabConfig {
  apiBase: string;
  token: string;
  projectPath: string;
  fetch: FetchLike;
}

async function getJson(cfg: GitlabConfig, path: string): Promise<unknown> {
  const res = await cfg.fetch(`${cfg.apiBase}${path}`, { method: 'GET', headers: { 'private-token': cfg.token } });
  if (!res.ok) throw new Error(`GitLab GET ${path} answered ${res.status}`);
  return res.json();
}

export function gitlabMrReader(cfg: GitlabConfig): GitLabMrReader {
  const pid = encodeURIComponent(cfg.projectPath);
  return {
    async getMr(iid) {
      const mr = (await getJson(cfg, `/projects/${pid}/merge_requests/${iid}`)) as { sha?: string; state?: string };
      return { sha: String(mr.sha ?? ''), state: String(mr.state ?? '') };
    },
    async getChanges(iid) {
      const c = (await getJson(cfg, `/projects/${pid}/merge_requests/${iid}/changes`)) as { changes?: Array<{ old_path: string; new_path: string; diff: string }> };
      const files: MrChangeFile[] = (c.changes ?? []).map((f) => ({ old_path: f.old_path, new_path: f.new_path, diff: f.diff ?? '' }));
      return { files };
    },
  };
}

const MAX_LINES = 400;

/** Read-only repository tools pinned to one head SHA. Used by the Bedrock partner's evidence rules. */
export function gitlabToolExecutor(cfg: GitlabConfig, headSha: string): ExecuteTool {
  const pid = encodeURIComponent(cfg.projectPath);
  const safePath = (p: string): string | null => {
    if (typeof p !== 'string' || p.startsWith('/') || p.split('/').some((seg) => seg === '..' || seg === '')) return null;
    return p;
  };
  const err = (name: string, message: string, path?: string) => ({
    result: message,
    isError: true,
    log: { name, repo: cfg.projectPath, path, ok: false } as never,
  });
  return async (name, args) => {
    if (name === 'search') return err(name, 'search is not available for a pinned review; read the files you cite instead');
    if (name === 'read_file') {
      const path = safePath(String(args.path ?? ''));
      if (!path) return err(name, 'the path must be repository-relative and cannot contain ..', String(args.path ?? ''));
      const res = await cfg.fetch(`${cfg.apiBase}/projects/${pid}/repository/files/${encodeURIComponent(path)}/raw?ref=${headSha}`, { method: 'GET', headers: { 'private-token': cfg.token } });
      if (!res.ok) return err(name, `file not readable at ${headSha}: ${res.status}`, path);
      const lines = (await res.text()).split('\n');
      const start = Math.max(1, Number(args.start_line ?? 1));
      const end = Math.min(lines.length, Number(args.end_line ?? start + MAX_LINES - 1), start + MAX_LINES - 1);
      const numbered = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
      return { result: numbered, isError: false, log: { name, repo: cfg.projectPath, path, ok: true } as never };
    }
    if (name === 'list_dir') {
      const dir = String(args.path ?? '');
      if (dir && !safePath(dir)) return err(name, 'the directory must be repository-relative', dir);
      const items = await getJson(cfg, `/projects/${pid}/repository/tree?path=${encodeURIComponent(dir)}&ref=${headSha}&per_page=100`);
      const names = (Array.isArray(items) ? items : []).map((i: { path: string; type: string }) => `${i.type === 'tree' ? 'dir ' : 'file'} ${i.path}`).join('\n');
      return { result: names, isError: false, log: { name, repo: cfg.projectPath, path: dir, ok: true } as never };
    }
    return err(name, `unknown tool ${name}`);
  };
}

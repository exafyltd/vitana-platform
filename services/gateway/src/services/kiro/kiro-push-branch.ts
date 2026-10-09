/**
 * VTID-05006: dev_push_kiro_branch — Kiro's edits leave its workspace only
 * through the gateway, never with a push credential of Kiro's own.
 *
 * Writes the given files as ONE commit on a `kiro/<user8>/<slug>` branch of
 * vitana-platform or vitana-v1 via GitHub's git-data API (blobs → tree →
 * commit → ref), with the gateway's own GitHub token. The branch is created
 * from main or fast-forwarded — never force-pushed, never main, never another
 * user's prefix. Kiro then opens the PR with dev_create_pr.
 */
import { posix } from 'path';

export const KIRO_PUSH_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
export const KIRO_PUSH_LIMITS = { files: 50, bytesPerFile: 512 * 1024, bytesTotal: 2 * 1024 * 1024 };

/** Paths a Kiro push may never touch: CI, agent rules, governance, evidence, migrations, ownership, dependencies. */
const DENIED_PREFIXES = ['.github/', '.claude/', 'gov/', 'scripts/ci/', 'docs/validation/', 'supabase/migrations/'];
const DENIED_NAMES = new Set(['CLAUDE.md', 'CODEOWNERS', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

export interface PushFile { path: string; content: string }
export interface PushArgs { repo: string; branch: string; message: string; files: PushFile[] }

export function kiroBranchPrefix(userId: string): string {
  return `kiro/${userId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}/`;
}

/** Check everything before touching GitHub. Returns the normalised files or the reason it is refused. */
export function validatePush(a: Partial<PushArgs>, userId: string): { ok: true; files: PushFile[] } | { ok: false; error: string } {
  if (!a || typeof a !== 'object') return { ok: false, error: 'arguments required' };
  if (!(KIRO_PUSH_REPOS as readonly string[]).includes(String(a.repo))) return { ok: false, error: `repo must be one of ${KIRO_PUSH_REPOS.join(', ')}` };
  const prefix = kiroBranchPrefix(userId);
  const branch = String(a.branch ?? '');
  if (!branch.startsWith(prefix) || !/^[a-z0-9-]{3,60}$/.test(branch.slice(prefix.length))) {
    return { ok: false, error: `branch must be ${prefix}<slug> (3-60 of a-z, 0-9, -)` };
  }
  if (typeof a.message !== 'string' || !a.message.trim() || a.message.length > 2000) return { ok: false, error: 'a commit message is required (≤ 2000 chars)' };
  if (!Array.isArray(a.files) || a.files.length === 0) return { ok: false, error: 'files required' };
  if (a.files.length > KIRO_PUSH_LIMITS.files) return { ok: false, error: `at most ${KIRO_PUSH_LIMITS.files} files per push` };
  let total = 0;
  const seen = new Set<string>();
  const out: PushFile[] = [];
  for (const f of a.files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') return { ok: false, error: 'each file needs a path and text content' };
    const raw = f.path.replace(/\\/g, '/');
    const norm = posix.normalize(raw);
    if (raw.startsWith('/') || norm.startsWith('..') || norm.split('/').includes('..') || norm === '.' || norm.endsWith('/')) return { ok: false, error: `invalid path: ${f.path}` };
    const base = posix.basename(norm);
    if (DENIED_PREFIXES.some((p) => norm.startsWith(p)) || DENIED_NAMES.has(base) || norm === 'docs/CODEOWNERS') {
      return { ok: false, error: `Kiro may not change ${norm} — that goes through the normal PR process` };
    }
    if (f.content.includes('\u0000')) return { ok: false, error: `binary content is not allowed: ${norm}` };
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > KIRO_PUSH_LIMITS.bytesPerFile) return { ok: false, error: `${norm} is over ${KIRO_PUSH_LIMITS.bytesPerFile} bytes` };
    total += bytes;
    if (total > KIRO_PUSH_LIMITS.bytesTotal) return { ok: false, error: `the push is over ${KIRO_PUSH_LIMITS.bytesTotal} bytes in total` };
    if (seen.has(norm)) return { ok: false, error: `duplicate path: ${norm}` };
    seen.add(norm);
    out.push({ path: norm, content: f.content });
  }
  return { ok: true, files: out };
}

/** Minimal GitHub client for the push, injectable for tests. */
export type GitHubCall = (method: string, endpoint: string, body?: unknown) => Promise<any>;

export const defaultGitHubCall: GitHubCall = async (method, endpoint, body) => {
  const token = process.env.GITHUB_SAFE_MERGE_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) throw new Error('GitHub token not configured');
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`GitHub ${method} ${endpoint.split('?')[0]} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

export interface PushResult { ok: boolean; error?: string; commit_sha?: string; branch?: string; created?: boolean; files?: number; bytes?: number }

export async function pushKiroBranch(a: PushArgs, userId: string, gh: GitHubCall = defaultGitHubCall): Promise<PushResult> {
  const v = validatePush(a, userId);
  if (!v.ok) return { ok: false, error: v.error };
  const repo = a.repo;
  const existing = await gh('GET', `/repos/${repo}/git/ref/heads/${a.branch}`);
  const parentSha: string = existing?.object?.sha ?? (await gh('GET', `/repos/${repo}/git/ref/heads/main`))?.object?.sha;
  if (!parentSha) return { ok: false, error: 'could not read main' };
  const parent = await gh('GET', `/repos/${repo}/git/commits/${parentSha}`);
  const tree = await Promise.all(v.files.map(async (f) => {
    const blob = await gh('POST', `/repos/${repo}/git/blobs`, { content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64' });
    return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
  const newTree = await gh('POST', `/repos/${repo}/git/trees`, { base_tree: parent.tree.sha, tree });
  const commit = await gh('POST', `/repos/${repo}/git/commits`, { message: a.message, tree: newTree.sha, parents: [parentSha] });
  if (existing) await gh('PATCH', `/repos/${repo}/git/refs/heads/${a.branch}`, { sha: commit.sha, force: false });
  else await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: commit.sha });
  const bytes = v.files.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0);
  return { ok: true, commit_sha: commit.sha, branch: a.branch, created: !existing, files: v.files.length, bytes };
}

/** The MCP declaration for the push tool (it is Kiro-only, not an Operator tool). */
export const KIRO_PUSH_TOOL = {
  name: 'dev_push_kiro_branch',
  description:
    'Push edited files from your workspace as ONE commit to your own kiro/<id>/<slug> branch of exafyltd/vitana-platform or exafyltd/vitana-v1 ' +
    '(created from main or fast-forwarded; never main, never force). Text files only, ≤ 50 files, ≤ 512 KB each, ≤ 2 MB total; ' +
    'no .github/, .claude/, CLAUDE.md, gov/, scripts/ci/, docs/validation/, supabase/migrations/, CODEOWNERS or package/lock files. ' +
    'Needs a vtid and the user\'s Allow. Then open the PR with dev_create_pr (head_branch = this branch).',
  inputSchema: {
    type: 'object',
    properties: {
      vtid: { type: 'string', description: 'The open VTID this change belongs to.' },
      repo: { type: 'string', enum: [...KIRO_PUSH_REPOS] },
      branch: { type: 'string', description: 'kiro/<first 8 chars of your user id>/<slug>' },
      message: { type: 'string', description: 'Commit message; start with the VTID.' },
      files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    },
    required: ['vtid', 'repo', 'branch', 'message', 'files'],
  },
};

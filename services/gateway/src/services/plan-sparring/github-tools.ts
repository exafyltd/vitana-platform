/**
 * VTID-04868 — Plan Sparring Gate: the partner's read-only code access (R1).
 *
 * Three tools, all GET-only against the GitHub REST API:
 *   read_file(repo, path, start_line?, end_line?)  — contents API, ref PINNED
 *   list_dir(repo, path)                           — contents API, ref PINNED
 *   search(repo, query)                            — code search; GitHub only
 *       searches the default branch, so results are marked approximate and
 *       never count as evidence on their own (only read_file does).
 *
 * Credential: PLAN_SPARRING_GITHUB_TOKEN ONLY — a dedicated fine-grained token
 * (contents:read + metadata:read, both repos). Deliberately never GITHUB_TOKEN
 * or GITHUB_SAFE_MERGE_TOKEN: the partner must not hold a credential that can
 * write or merge. The model cannot choose the ref — every read is pinned to
 * the commit the session was created at.
 */

import type { LLMRouterTool } from '../llm-router';
import type { ToolLogEntry } from './types';

export const PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
export const TOOL_RESULT_MAX_CHARS = 20_000;
const READ_FILE_MAX_LINES = 400;
const GITHUB_API = 'https://api.github.com';

export function planSparringGithubToken(): string | undefined {
  const t = process.env.PLAN_SPARRING_GITHUB_TOKEN ?? '';
  return t.trim().length > 0 ? t.trim() : undefined;
}

export const PARTNER_CODE_TOOLS: LLMRouterTool[] = [
  {
    name: 'read_file',
    description:
      'Read a file from one of the allowed repositories at the pinned commit of this review. Returns numbered lines. Use start_line/end_line for large files (max 400 lines per call). Every finding and premise check MUST cite a file you read with this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', enum: [...PLAN_SPARRING_REPOS] },
        path: { type: 'string', description: 'Repository-relative path, e.g. services/gateway/src/index.ts' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: 'List a directory of one of the allowed repositories at the pinned commit.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', enum: [...PLAN_SPARRING_REPOS] },
        path: { type: 'string', description: 'Repository-relative directory path; empty string for the root.' },
      },
      required: ['repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'GitHub code search in one allowed repository. APPROXIMATE: it searches the default branch, not the pinned commit, and may miss or include stale hits. Use it only to find candidate files, then confirm with read_file.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', enum: [...PLAN_SPARRING_REPOS] },
        query: { type: 'string' },
      },
      required: ['repo', 'query'],
      additionalProperties: false,
    },
  },
];

export interface ToolExecution {
  result: string;
  isError: boolean;
  log: ToolLogEntry;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

function clip(text: string): string {
  return text.length > TOOL_RESULT_MAX_CHARS
    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[truncated at ${TOOL_RESULT_MAX_CHARS} chars — read a narrower line range]`
    : text;
}

function validPath(p: unknown): p is string {
  return typeof p === 'string' && !p.includes('..') && !p.startsWith('/') && p.length <= 512;
}

function encodePath(p: string): string {
  return p.split('/').filter((s) => s.length > 0).map(encodeURIComponent).join('/');
}

/**
 * Build the executor for one session. `refs` maps repo → pinned commit SHA;
 * a repo with no pinned ref is refused (never silently read at HEAD).
 */
export function createCodeToolExecutor(opts: {
  refs: Record<string, string>;
  token?: string;
  fetchImpl?: FetchLike;
}): (name: string, args: Record<string, unknown>) => Promise<ToolExecution> {
  const token = opts.token ?? planSparringGithubToken();
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
  const headers = (): Record<string, string> => ({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vitana-plan-sparring',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  return async (name, args) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const base: ToolLogEntry = { name: name as ToolLogEntry['name'], repo, ok: false };
    const fail = (msg: string, extra: Partial<ToolLogEntry> = {}): ToolExecution => ({
      result: msg,
      isError: true,
      log: { ...base, ...extra, ok: false },
    });

    if (!token) return fail('PLAN_SPARRING_GITHUB_TOKEN is not configured — code access unavailable.');
    if (!(PLAN_SPARRING_REPOS as readonly string[]).includes(repo)) {
      return fail(`repo must be one of ${PLAN_SPARRING_REPOS.join(', ')}`);
    }
    const ref = opts.refs[repo];

    try {
      if (name === 'read_file') {
        if (!validPath(args.path) || args.path.length === 0) return fail('invalid path');
        const path = args.path;
        if (!ref) return fail(`no pinned ref for ${repo} in this session`, { path });
        const url = `${GITHUB_API}/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
        const resp = await doFetch(url, { method: 'GET', headers: headers() });
        if (!resp.ok) return fail(`GitHub ${resp.status} reading ${repo}/${path}@${ref}`, { path });
        const body = (await resp.json()) as { type?: string; encoding?: string; content?: string };
        if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') {
          return fail(`${path} is not a readable file (directory, submodule or >1MB)`, { path });
        }
        const lines = Buffer.from(body.content, 'base64').toString('utf8').split('\n');
        const start = Math.max(1, Number.isInteger(args.start_line) ? (args.start_line as number) : 1);
        const requestedEnd = Number.isInteger(args.end_line) ? (args.end_line as number) : lines.length;
        const end = Math.min(lines.length, requestedEnd, start + READ_FILE_MAX_LINES - 1);
        const numbered = lines
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(5, ' ')}  ${l}`)
          .join('\n');
        return {
          result: clip(`${repo}/${path}@${ref} lines ${start}-${end} of ${lines.length}\n${numbered}`),
          isError: false,
          log: { ...base, path, ok: true },
        };
      }

      if (name === 'list_dir') {
        if (!(validPath(args.path) || args.path === '')) return fail('invalid path');
        const path = args.path as string;
        if (!ref) return fail(`no pinned ref for ${repo} in this session`, { path });
        const url = `${GITHUB_API}/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
        const resp = await doFetch(url, { method: 'GET', headers: headers() });
        if (!resp.ok) return fail(`GitHub ${resp.status} listing ${repo}/${path}@${ref}`, { path });
        const body = await resp.json();
        if (!Array.isArray(body)) return fail(`${path} is not a directory`, { path });
        const entries = (body as Array<{ name?: string; type?: string }>)
          .map((e) => `${e.type === 'dir' ? 'dir ' : 'file'}  ${e.name}`)
          .join('\n');
        return { result: clip(`${repo}/${path || '.'}@${ref}\n${entries}`), isError: false, log: { ...base, path, ok: true } };
      }

      if (name === 'search') {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query || query.length > 256) return fail('invalid query');
        const url = `${GITHUB_API}/search/code?per_page=20&q=${encodeURIComponent(`${query} repo:${repo}`)}`;
        const resp = await doFetch(url, { method: 'GET', headers: headers() });
        if (!resp.ok) return fail(`GitHub ${resp.status} searching ${repo}`, { approximate: true });
        const body = (await resp.json()) as { items?: Array<{ path?: string }> };
        const paths = (body.items ?? []).map((i) => i.path).filter((p): p is string => typeof p === 'string');
        return {
          result: clip(
            `APPROXIMATE (default branch, not the pinned commit — confirm with read_file):\n${paths.join('\n') || '(no hits)'}`,
          ),
          isError: false,
          log: { ...base, ok: true, approximate: true },
        };
      }

      return fail(`unknown tool ${name}`);
    } catch (err) {
      return fail(`tool error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

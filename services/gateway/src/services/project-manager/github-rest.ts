/**
 * VTID-05274 — the PM's minimal GitHub REST and Supabase REST helpers (live
 * seams only; tests inject fakes behind the observer / writer interfaces).
 *
 * Token: the PM's GitHub App installation token when PM_GITHUB_APP_* are set
 * (VTID-05352), else the repo's own token (`repoGitHubToken`, e.g.
 * FRONTEND_DEPLOY_TOKEN for vitana-v1), else GITHUB_SAFE_MERGE_TOKEN — the same
 * resolution as github-service.ts. Never logged.
 */
import { repoGitHubToken, type VitanaRepo } from '../vitana-repos';
import { defaultAppTokenSource, type AppTokenSource } from './github-app-token';

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;

export class GithubHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * VTID-05352: the PM's GitHub App installation token first (when PM_GITHUB_APP_* are set), else today's resolution
 * unchanged. An App failure returns null from the source and falls back here, so the PM never stops on the App.
 */
export async function resolvePmToken(repo: string, app: AppTokenSource | null = defaultAppTokenSource()): Promise<string> {
  const fromApp = app ? await app.get() : null;
  if (fromApp) return fromApp;
  const t = repoGitHubToken(repo as VitanaRepo) || process.env.GITHUB_SAFE_MERGE_TOKEN;
  if (!t) throw new GithubHttpError(0, 'GITHUB_SAFE_MERGE_TOKEN is not set');
  return t;
}

/** One GitHub REST call for `repo`; `path` is relative to `/repos/<repo>` unless it starts with `/`. */
export async function gh<T>(repo: string, path: string, init: RequestInit = {}): Promise<{ status: number; data: T | null }> {
  const url = path.startsWith('/') ? `${GITHUB_API}${path}` : `${GITHUB_API}/repos/${repo}/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await resolvePmToken(repo)}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) {
    let msg = '';
    try { msg = String((JSON.parse(text) as { message?: string }).message || ''); } catch { /* non-JSON */ }
    throw new GithubHttpError(res.status, `GitHub ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`);
  }
  return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
}

/** All pages of a list endpoint (100 per page, capped). */
export async function ghPages<T>(repo: string, path: string, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await gh<T[]>(repo, `${path}${sep}per_page=100&page=${page}`);
    const items = r.data ?? [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

/** Supabase REST with the service role (the gateway's own runtime access). */
export async function supaRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('supabase not configured');
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : []) as T;
}

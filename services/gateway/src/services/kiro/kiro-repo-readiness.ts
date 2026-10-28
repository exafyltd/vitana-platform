/**
 * VTID-05014: read-only readiness of the repos Kiro may write to.
 *
 * For each Vitana repo: is its token configured, can that token read the repo,
 * and what GitHub reports as the token identity's permissions. One GET per repo
 * (`/repos/{repo}`); never a write, never the token itself in the answer.
 */
import { VITANA_REPOS } from '../vitana-repos';
import { pushToken } from './kiro-push-branch';

export interface RepoReadiness {
  repo: string;
  token_configured: boolean;
  can_read: boolean;
  permissions: { admin?: boolean; push?: boolean; pull?: boolean } | null;
  error?: string;
  note: string;
}

const NOTE =
  'permissions is what GitHub reports for the token\'s identity; a fine-grained token can still lack contents:write or ' +
  'pull_requests:write, so only a real push proves write access.';

export async function kiroRepoReadiness(fetchImpl: typeof fetch = fetch): Promise<RepoReadiness[]> {
  return Promise.all(VITANA_REPOS.map(async (repo): Promise<RepoReadiness> => {
    let token = '';
    try { token = pushToken(repo); } catch (e) {
      return { repo, token_configured: false, can_read: false, permissions: null, error: e instanceof Error ? e.message : String(e), note: NOTE };
    }
    if (!token) return { repo, token_configured: false, can_read: false, permissions: null, error: 'GitHub token not configured', note: NOTE };
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!res.ok) return { repo, token_configured: true, can_read: false, permissions: null, error: `GitHub answered ${res.status}`, note: NOTE };
      const body = (await res.json()) as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } };
      const p = body.permissions;
      return { repo, token_configured: true, can_read: true, permissions: p ? { admin: p.admin, push: p.push, pull: p.pull } : null, note: NOTE };
    } catch (e) {
      return { repo, token_configured: true, can_read: false, permissions: null, error: e instanceof Error ? e.message : String(e), note: NOTE };
    }
  }));
}

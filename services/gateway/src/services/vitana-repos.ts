/**
 * VTID-05014: the two Vitana repos the gateway reads AND writes (Operator read
 * tools, Kiro push/PR/merge, safe-merge). The single allowlist — never accept
 * any other repo string from a model or a request.
 */
export const VITANA_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
export type VitanaRepo = (typeof VITANA_REPOS)[number];
export function isVitanaRepo(repo: unknown): repo is VitanaRepo {
  return typeof repo === 'string' && (VITANA_REPOS as readonly string[]).includes(repo);
}

/**
 * VTID-05014: the one token resolver for those repos. vitana-platform →
 * undefined (githubRequest then uses GITHUB_SAFE_MERGE_TOKEN, unchanged);
 * vitana-v1 → FRONTEND_DEPLOY_TOKEN (the credential every vitana-v1 call
 * already uses). Unset → throws: a vitana-v1 call never falls back to the
 * platform token. Read at call time, so a task-def change applies without a
 * restart.
 */
export function repoGitHubToken(repo: VitanaRepo): string | undefined {
  if (repo === 'exafyltd/vitana-platform') return undefined;
  const t = process.env.FRONTEND_DEPLOY_TOKEN;
  if (!t) throw new Error(`repo_token_not_configured: FRONTEND_DEPLOY_TOKEN is not set — cannot reach "${repo}" from this environment.`);
  return t;
}

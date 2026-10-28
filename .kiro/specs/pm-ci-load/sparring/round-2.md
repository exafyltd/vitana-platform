# Sparring round 2 — converged

Session: `3b4bad67-1fa4-49d7-bf38-fe4fd45ec728` · plan hash `6114a50ca1b8a501f38c686881cdf09201da73ab3b817be1f177ec6e6134c294`

## Summary

The revised plan properly addresses both R1-F1 (explicit Variables read permission) and R1-F2 (no github.ref fallback in concurrency group). All key premises verified against the codebase hold. I have one new minor finding about a sync→async refactor that the plan should acknowledge but is not a blocker.

## Findings

### R2-F1 [minor]

The plan's Lane 2 step 2 says `token(repo)` will be modified to try the App token first, then fall back to today's resolution. However, the current `token()` function is synchronous (github-rest.ts:20-24) and is called synchronously inside `gh()` at line 33. Obtaining/refreshing an App installation token requires an async HTTP exchange (`POST /app/installations/<id>/access_tokens`). Even with a cache, the first call and every refresh will be async. The plan should note that `token()` must become async and `gh()` must `await` it — a small but real refactor of the call site that touches every REST path through `gh()`/`ghPages()`.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/github-rest.ts:20` — function token(repo: string): string {
    const t = repoGitHubToken(repo as VitanaRepo) || process.env.GITHUB_SAFE_MERGE_TOKEN;
    if (!t) throw new GithubHttpError(0, 'GITHUB_SAFE_MERGE_TOKEN is not set');
    return t;
  }
...
      Authorization: `Bearer ${token(repo)}`,

Suggestion: Acknowledge in the plan that `token()` becomes `async token(repo): Promise<string>` and `gh()` awaits it. Since `gh()` and `ghPages()` are already async, the change is mechanical and confined to github-rest.ts — no caller signature changes. The cache hit path (synchronous Map lookup) can be wrapped in `Promise.resolve()` or the function can simply be async. No new finding, just make it explicit so the implementer doesn't have to discover it.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Properly addressed: §4 now lists 'Variables read' explicitly and drops 'Actions read' and 'Commit statuses read'. Verified against the codebase that the only /actions/ call is the variables endpoint (observe-live.ts:709) and the only checks-related call uses check-runs (observe-live.ts:694), requiring Checks read, not Commit statuses.
- R1-F2: acknowledged — Properly addressed: §3 Lane 1 step 1 now specifies the exact PR-GATE.yml pattern with no github.ref fallback.

# VTID-04633 — GitHub API errors carry GitHub's own message

Observed 2026-09-26 10:20 UTC: three Command Hub PUBLISH clicks (VTID-04630/31/32,
staging `375401c`) failed with `production.publish.failed` "GitHub API error: 403 -
Forbidden". The last successful PUBLISH was 2026-09-25 09:06 (VTID-04529). At
19:17 that day AWS-PROD-DEPLOY-GATEWAY run #332 (VTID-04573) moved the production
gateway's `GITHUB_SAFE_MERGE_TOKEN` to `vitana/github/pat`. Every workflow
dispatch from the production gateway has failed since. A 403 on a
workflow_dispatch from a fine-grained PAT means the token lacks
`Actions: Read and write` on the repository. The token itself is owner-held and
is not changed by this PR.

The popover could not say that, because `githubRequest` threw only the status
line and logged GitHub's response body.

## Acceptance criteria

AC-1: `formatGitHubApiError` appends GitHub's `message` to the status line and keeps the `GitHub API error: <status> - <text>` prefix callers match on.
TEST: services/gateway/test/vtid-04633-github-api-error-message.test.ts

AC-2: a non-JSON or empty body gives the plain status line, and a long message is bounded.
TEST: services/gateway/test/vtid-04633-github-api-error-message.test.ts

AC-3: `triggerWorkflow` rejects with GitHub's reason on a 403.
TEST: services/gateway/test/vtid-04633-github-api-error-message.test.ts

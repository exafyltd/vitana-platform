# VTID-05014 - Kiro writes to exafyltd/vitana-v1 (push, open PR, merge)

Owner approval 2026-10-09 (Gate 1: "yes built it"). Sparring: `plan-sparring.md` (converged, 2 rounds, plan hash `d02381b8…`).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/operator/kiro/repos` (new, `routes/operator.ts`, `requireAdminAuth`, read-only). `POST /api/v1/github/create-pr` and `POST /api/v1/github/safe-merge` (existing, `routes/cicd.ts`) now accept `exafyltd/vitana-v1` as well as `exafyltd/vitana-platform`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/repos (staging).

CURL_PROOF: unauthenticated GET of the readiness route answers 401 application/json; safe-merge with an invalid bearer answers 401 application/json.

OASIS_PROOF: unchanged event set — `operator.kiro.write_tool_called`, `operator.kiro.write_confirmed`/`write_denied`, `operator.kiro.branch_pushed` (now with `repo: exafyltd/vitana-v1` for vitana-v1 pushes); cicd create/merge events carry the repo.

## Acceptance criteria

AC-1: One repo allowlist and one token resolver (`services/vitana-repos.ts`): vitana-platform uses the default token unchanged; every vitana-v1 call (push, PR, status, governance, merge, target check, readiness) uses FRONTEND_DEPLOY_TOKEN; unset fails loudly and never falls back to the platform token.
  TEST: services/gateway/test/vtid-05014-kiro-v1-writes.test.ts
  TEST: services/gateway/test/vtid-03946-operator-cross-repo-search.test.ts
AC-2: dev_push_kiro_branch accepts vitana-v1 with its own deny list (supabase/ entirely, AGENTS.md, .env files, eslint-rules/ and configs, plus the shared .github/.claude/CLAUDE.md/docs/validation/CODEOWNERS/package files); vitana-platform rules unchanged; a refused push is refused before the user is asked.
  TEST: services/gateway/test/vtid-05014-kiro-v1-writes.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-3: dev_create_pr / dev_merge_pr take an optional repo (default vitana-platform); /create-pr and /safe-merge accept both repos, refuse any other, and keep checks-green + governance; other cicd merge routes stay platform-only.
  TEST: services/gateway/test/vtid-05014-kiro-v1-writes.test.ts
  CURL: staging POST /api/v1/github/safe-merge with an invalid bearer -> 401 application/json
AC-4: A vitana-v1 push under Allow writes one fast-forward commit on the kiro branch with the vitana-v1 token only and leaves the platform repo untouched (end to end over the fake database and GitHub).
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-5: GET /api/v1/operator/kiro/repos is admin-only and read-only: per repo, token configured, readable, and GitHub's reported permissions, never a token value.
  TEST: services/gateway/test/vtid-05014-kiro-v1-writes.test.ts
  CURL: staging GET /api/v1/operator/kiro/repos without a caller -> 401 application/json

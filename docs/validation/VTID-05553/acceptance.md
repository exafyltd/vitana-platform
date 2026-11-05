# VTID-05553 - operator-chat-service-token: Operator Chat approve and reject send the gateway service token

Lane `operator-chat-service-token/operator-chat-service-token`, from plan `operator-chat-service-token` (plan PR #4681). The plan converged on round 2 and was approved by policy `converged-auto-v1` on 2026-11-05T09:06:33Z (final plan hash `941dcf483e67aabed1512a09d7ea971a145ac3fc6cf58a3292c38065095cae91`). Code head: `7facd9cba9`.

Ordering: this lane merges to main before `approvals-auth-v2` (VTID-05528, PR #4683) and before `approvals-auth` (VTID-05452, PR #4606). Without this lane on main, Operator Chat approve and reject answer 401/403 once the approvals routes deploy.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no route is added, and no route handler or route response changes. The approvals routes keep `requireServiceOrAdmin`.

FINAL_URL: n/a. This lane has no staging probe (see AC-5).

CURL_PROOF: n/a.

OASIS_IMPACT: no. No event is added, removed or reshaped.

## Acceptance criteria

AC-1: Operator Chat approve and reject send the gateway service token. `executeDevApproveItem` and `executeDevRejectItem` in `services/gateway/src/services/gemini-operator.ts` send `Content-Type: application/json` and `...gatewayServiceAuthHeader()`, with no `apikey` and no Supabase service key.
  TEST: services/gateway/test/operator-chat-service-token.test.ts, "sends the gateway service token and never the Supabase service key" (approve and reject, 2 cases). Red on origin/main: the header assertion fails (outputs/red-on-base.txt). Green on this head (outputs/green-operator-chat-head.txt).

AC-2: Nothing else changes. No approvals route, gate, middleware or other header in `gemini-operator.ts` changes.
  TEST: `git diff origin/main...HEAD --stat` lists `services/gateway/src/services/gemini-operator.ts` and `services/gateway/test/operator-chat-service-token.test.ts` only, both lane paths.

AC-3: The suites that cover the change pass on this head.
  TEST: `npx jest test/operator-chat-service-token.test.ts`, 2 passed (outputs/green-operator-chat-head.txt)
  TEST: every test file that mentions `gemini-operator` (47 suites, 817 tests) passes (outputs/green-gemini-operator-suites.txt; list in outputs/gemini-operator-suites.txt)
  TEST: `npm run test:operator`, 71 passed (outputs/green-test-operator-head.txt)
  TEST: `npm run test:roles`, 105 passed (outputs/green-test-roles-head.txt)
  TEST: `npx jest test/orb-tools/developer-tools.test.ts`, 60 passed (outputs/green-developer-tools-head.txt)
  TEST: `npm run typecheck` exits 0 (outputs/typecheck-head.txt); `npx tsc --noEmit` exits 0 (outputs/tsc-head.txt)

AC-4: Red before green. The new test runs against origin/main (`29b639da4b`, unchanged code) in a temporary worktree and fails on the header assertion, not on an import or setup error.
  TEST: outputs/red-on-base.txt (2 failed, 2 total; the failing line is `expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer ${SVC}' })`)

AC-5: Staging. Not verified on staging. The change alters the headers of two in-process calls, and a real approve or reject writes to the shared Supabase project. Staging suites are read-only (CLAUDE.md rule 48). The covering test is test/operator-chat-service-token.test.ts. The reason is recorded in staging-tests.json (plan section 9).
  TEST: staging-tests.json (empty list with the reason)

## Decisions taken

- The header comments name this lane's VTID (commit `7facd9cba9`). The first commit cited VTID-05528, the approvals lane, and was corrected before review. No code changed.
- The lane branch merged origin/main at `29b639da4b` (merge `43fc9fd0f7`) before the tests ran, so every suite ran on the current main code.
- The plan asked for "25 suites on base, plus the new test" that import `services/gemini-operator`. On this lane the count is 24 test files that import the module, including the new test, and 47 test files that mention it (`jest.mock` and similar). The 47-file run covers both sets, and all pass.
- Plan round 2 raised one minor finding (R2-F1). Plan section 6 says the programme line goes in `docs/programs/standalone/program.md`. The partner read the pinned main commit, which has no such line yet. The line exists on the plan branch (plan commit `3a802591df`, line 69), because the new spec needs its own registry line. The lane does not edit that file. The answer is recorded here. The plan was already converged and approved, so the plan text did not change.

## Open items

- Merge order: plan PR #4681 merges first, then this lane, then `approvals-auth-v2` (VTID-05528, PR #4683, draft until this lane is on main).
- PR-GATE `sparring` may report the plan's policy approval as a missing owner-approval line. The check is report-only (`scripts/ci/pr-gate/config.json`, `enforce: false`).

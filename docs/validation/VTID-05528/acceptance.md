# VTID-05528 - Track S approvals-auth-v2: review findings, and the head the reviewer accepted

Lane: `mt-track-s-authz/approvals-auth-v2` (plan amendment 1). The reviewer agent `vitana-lane-reviewer` returned `changes` on head `2dd8cc325519a2f4ce9e7a48791377be28489796` (2026-11-04T17:24Z) with three blocking findings. The earlier commits answer findings 1 and 2. Finding 3 (Operator Chat service token) moved to lane `operator-chat-service-token` (branch `kiro/operator-chat-service-token/lane`). The reviewer then accepted head `64524419f3b2f598b8aeaa99abd3ede82120f11a` (2026-11-04T18:15Z, no blocking findings, four non-blocking findings). This head answers those four findings. It also carries one narrowing made after that accept: the generic live path gives the member's bearer only to the two approvals tools.

Commits on top of the accepted head: `861c3ceca9` (merge of origin/main `4066f563e7`, no conflicts), `db8a6b41ef` (the narrowing and its regression case), and the commit that adds this refreshed evidence.

Earlier commits in the lane: `7a30f146d9` (Operator Chat change, reverted below), `a6455dfbc5` (bind tests), `33c492784b` (this folder), `be3f456cdf` (reverts `7a30f146d9` from this branch), `64524419f3` (evidence refresh).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no route is added. The three approvals POST routes already run `requireServiceOrAdmin` (VTID-05452). This lane adds the member bearer binds on the SSE, WebSocket and orb-tool paths, with their tests. It does not change the Operator Chat self-calls.

FINAL_URL: pending STAGING-VERIFY. Staging is https://preview-aws-gateway.vitanaland.com after this lane merges. Nothing has run against staging for this change.

CURL_PROOF: pending STAGING-VERIFY. The three rejected probes in `staging-tests.json` are unauthenticated POSTs that must answer 401 application/json before any handler runs. Nothing is written.

OASIS_IMPACT: no. No event is added, removed or reshaped. Refused calls never reach a handler.

## Acceptance criteria

AC-1: Finding 1 (evidence). The head has `docs/validation/VTID-05528/` with `scope.json`, `staging-tests.json`, `acceptance.md`, `commands.log` and `outputs/`. The outputs hold the red run on origin/main, the green runs on this head, `test:operator`, `test:roles`, `tsc` and the mutation checks.
  TEST: local PR-GATE `scope` and `weakening` pass; `sparring` fails and is listed under Open items (outputs/pr-gate-local.txt)
  TEST: VALIDATOR-CHECK Evidence Pack Gate (acceptance.md, commands.log and outputs/ exist)

AC-2: Finding 2 (SSE bind). `GET /api/v1/orb/live/stream` binds the member bearer to the live session only when it verifies to the session owner. Bound on a match. Not bound on a mismatch (the stream is still served), an unverified token, or no token.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, "the SSE stream binds the member bearer only when it verifies to the session owner" (4 cases)

AC-3: Finding 2 (WebSocket bind). The WebSocket start frame on `/api/v1/orb/live/ws` binds the socket bearer with the same four cases.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, "the WebSocket start frame binds the member bearer only when it verifies to the session owner" (4 cases)

AC-4: Finding 2 (orb-tool). `POST /api/v1/orb/tool` passes the request bearer to the tools as `user_jwt`. With no bearer the tool identity gets `null`.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, "POST /api/v1/orb/tool hands the request bearer to the tools as user_jwt" (2 cases)

AC-5: Finding 2 (source pins). The three guard sites in `orb-live.ts` and `orb-tool.ts` keep their exact guard text.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, "the bind guards and the tool bearer, as written in source" (3 cases)

AC-6: Finding 2 (the tests fail on a regression). Four mutations were applied one at a time to head `a6455dfbc5`: SSE bind without the owner check, WebSocket bind without the identity check, SSE bind without verification, and orb-tool without the bearer. Each one fails the named tests in outputs/mutation-checks.txt. The source was reverted after each run. The generic-path narrowing has its own mutation run (AC-11, M5).
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts (mutation runs, outputs/mutation-checks.txt)

AC-7: Authorization not loosened. The approvals routes keep `requireServiceOrAdmin`. No test assertion is removed or weakened.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, the no-bearer 401 and non-admin 403 cases on all three POST routes (outputs/green-approvals-head.txt)
  TEST: services/gateway/test/orb-tools/developer-tools.test.ts (outputs/green-developer-tools-head.txt)

AC-8: The suites that cover this change pass on code head `db8a6b41ef`.
  TEST: `npx jest test/mt-track-s-authz-approvals-auth.test.ts`, 33 passed (outputs/green-approvals-head.txt)
  TEST: `npx jest test/orb-tools/developer-tools.test.ts`, 60 passed (outputs/green-developer-tools-head.txt)
  TEST: `npm run test:operator`, 71 passed (outputs/green-test-operator-head.txt)
  TEST: `npm run test:roles`, 105 passed (outputs/green-test-roles-head.txt)
  TEST: `npm run test:support`, 87 passed in 4 suites (outputs/green-test-support-head.txt)
  TEST: nearby suites (VTID-05047, VTID-05019, VTID-05005, VTID-05006, ws-tenant-fallback, sse-stream characterization, VTID-04834), 142 passed in 7 suites (outputs/green-nearby-head.txt)

AC-9: The TypeScript build is clean. `npx tsc --noEmit` exits 0 on `db8a6b41ef` with no diagnostics (outputs/tsc-head.txt).

AC-10: Red before green. Run against origin/main code (7292527d60), the new and changed tests fail where the behaviour is new: 19 approvals cases. The six not-bound cases pass there by construction, because origin/main never binds the bearer. They are guards, and mutation runs show they fail on a regression. origin/main has since moved to 4066f563e7, which changes none of this lane's files.
  TEST: outputs/red-origin-main-results.txt (19 failed, 73 passed, 92 tests in 2 files; full console log not committed)

AC-11: The generic live path gives the member's bearer only to `dev_approve_pr` and `dev_reject_pr`. Every other registry tool on that path gets no bearer and answers as it did before this lane.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, "a non-approvals tool on the generic live path gets no member bearer" (no fetch call; the admin-session message is returned)
  TEST: mutation M5 in outputs/mutation-checks.txt (the wide form fails this case)

AC-12: POST /feed/approve refuses a body branch that differs from the PR head and merges nothing.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, "a body branch that differs from the PR head is refused and nothing merges", and "the matching head branch proceeds to the merge call"

AC-13: `dev_approve_pr` and `dev_reject_pr` forward the caller's bearer as the Bearer token, and refuse without one: no call is made and the admin-session message is returned.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, "developer voice tools carry the caller token (dev_approve_pr / dev_reject_pr)" (4 cases)

AC-14: The one test-only export added to `orb-live.ts`, `__executeLiveApiToolForTest`, is a re-export with no behaviour. It follows the pattern of the existing `__connectToLiveAPIForTest` and `__handleWsStopSessionForTest` exports.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts imports it (the voice approve case and the AC-11 case)

## Decisions taken

- The Operator Chat change (`gemini-operator.ts` and `test/operator-chat-service-token.test.ts`) is not on this head. Commit `be3f456cdf` reverts `7a30f146d9` here, and the change is re-applied as its own commit on `kiro/operator-chat-service-token/lane` (lane `operator-chat-service-token`), which merges first. Its green run output (`green-operator-chat-head.txt`) was removed from this folder for the same reason; it stays in the history of `33c492784b`.
- The bind tests drive the real SSE route, the real WebSocket server and the real orb-tool route. The stubs are `verifyAndExtractIdentity`, `startLiveSessionForWs`, `finalizeLiveSession` and `VERTEX_PROJECT_ID` set to empty. `VERTEX_PROJECT_ID` falls back to a decommissioned GCP project name, and `googleAuth` is always constructed, so without the stub the routes would pass the gate that starts the upstream Live API connect. The run log shows the gate closed with the stub (`googleAuth=true, VERTEX_PROJECT_ID=EMPTY`).
- One test-only re-export is added to `orb-live.ts`: `__executeLiveApiToolForTest`. It adds no behaviour.
- The member's bearer reaches the generic live path only for `dev_approve_pr` and `dev_reject_pr` (commit `db8a6b41ef`). Earlier heads passed it to every registry tool that gates on `user_jwt`, including feed goals, live rooms, scan_existing_matches, and the admin and dev tools. Those tools answered "no session" on this path before this lane. The reviewer accepted the wider form on `64524419f3` and asked that its reach be named at Gate 2. This head narrows it instead, because plan item A5 caps the change at three lines and says it mirrors `:6430`. Gate 2 should list this as a changed decision.
- origin/main moved from `7292527d60` to `4066f563e7` (plan `group-chat-realtime-status`, and the VTID-05208 record). It was merged without conflicts. None of this lane's files changed on main.
- The reviewer's note that each generic-path tool's route enforces its own auth was checked for the admin feedback tools. `feedback-admin.ts` applies `requireAdminAuth` (exafy_admin) to every route. A comment in `admin-feedback-tools.ts` says the routes check only a valid bearer. That comment is out of date. This lane does not change it.
- Staging verification is not run here. The `FINAL_URL` and `CURL_PROOF` lines are pending STAGING-VERIFY on the merge commit.

## Open items

- PR-GATE `sparring` check fails on this record: `.kiro/specs/mt-track-s-authz/sparring/verdict.md` has no "owner approval" line. The record is approved by policy `converged-auto-v1`, which is the approval path for CI-sparred plans, so the text rule cannot match it. The check is report-only (`scripts/ci/pr-gate/config.json` has `enforce: false`). Nothing was edited to satisfy it. The owner decides whether the rule should accept the policy approval.
- Merge order. This lane must not merge before `operator-chat-service-token` is on main. Without it, Operator Chat approve and reject answer 401/403 once this lane deploys. The queue does not enforce the order: `depends_on` is empty, and `queue.mjs` rejects a cross-plan `depends_on`. This PR waits until the operator lane is on main, and the same order goes in Gate 2.
- Import cycle. `developer-tools.ts` imports `NO_ADMIN_SESSION` from `admin-users-rbac-tools.ts`, which imports from `developer-tools.ts`. It works because both sides read the bindings only inside handlers. Follow-up: move the constant to `orb-tools-shared.ts`.
- Preflight on this head: `Collab handoff` and `Lane scope` fail. The lane file is on plan PR #4653 (remote head `91f683c908`), not on origin/main. The `Lane scope` check also looks up open plan PRs through `gh`, which cannot authenticate in this session (GH_ENTERPRISE_TOKEN rejected). Both clear when #4653 merges and `gh` works. See outputs/preflight-summary.txt.
- The PR body still needs `VALIDATION_PROFILE: gateway_backend`, `SCOPE_ALLOWLIST`, `ACCEPTANCE`, `MERGE_PAYLOAD_PREVIEW` and `OASIS_IMPACT: no`. The route-evidence fields are pending STAGING-VERIFY.
- On origin/main, the verdict does not list VTID-05528. The amendment branch lists it, and that file lands with the plan amendment.

# VTID-05528 - Track S approvals-auth-v2: blocking findings 1-3 of the lane review

Lane: `mt-track-s-authz/approvals-auth-v2` (plan amendment 1). The reviewer agent `vitana-lane-reviewer` returned `changes` on head `2dd8cc325519a2f4ce9e7a48791377be28489796` (2026-11-04T17:24Z) with three blocking findings. This folder answers them. Fix commits on top of the reviewed head: `7a30f146d9` (Operator Chat service token, its own commit), `a6455dfbc5` (bind tests), then the commit that adds this folder.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no route is added. The three approvals POST routes already run `requireServiceOrAdmin` on the reviewed head (VTID-05452). This change adds the gateway service token to two Operator Chat self-calls and adds tests.

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

AC-6: Finding 2 (the tests fail on a regression). Four mutations were applied one at a time to the head: SSE bind without the owner check, WebSocket bind without the identity check, SSE bind without verification, and orb-tool without the bearer. Each one fails the named tests in outputs/mutation-checks.txt. The source was reverted after each run.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts (mutation runs, outputs/mutation-checks.txt)

AC-7: Finding 3 (Operator Chat). `executeDevApproveItem` and `executeDevRejectItem` send `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>` and no `apikey` header. The Supabase service key appears in neither request.
  TEST: services/gateway/test/operator-chat-service-token.test.ts, dev_approve_item and dev_reject_item (2 cases, outputs/green-operator-chat-head.txt)

AC-8: Finding 3 (authorization not loosened). The approvals routes keep `requireServiceOrAdmin`. No test assertion is removed or weakened.
  TEST: services/gateway/test/mt-track-s-authz-approvals-auth.test.ts, the no-bearer 401 and non-admin 403 cases on all three POST routes (outputs/green-approvals-head.txt)
  TEST: services/gateway/test/orb-tools/developer-tools.test.ts (outputs/green-developer-tools-head.txt)

AC-9: The suites that cover this change pass on this head: the approvals and developer-tools suites, the operator and roles suites, and the nearby live and Kiro suites.
  TEST: npm run test:operator, 71 passed (outputs/green-test-operator-head.txt)
  TEST: npm run test:roles, 105 passed (outputs/green-test-roles-head.txt)
  TEST: nearby suites (VTID-05047, VTID-05019, VTID-05005, VTID-05006, ws-tenant-fallback, sse-stream characterization, VTID-04834), 142 passed (outputs/green-nearby-head.txt)

AC-10: The TypeScript build is clean. `npx tsc --noEmit` exits 0 on this head.
  TEST: services/gateway `npx tsc --noEmit` (outputs/tsc-head.txt: exit 0, no diagnostics)

AC-11: Red before green. Run against origin/main code, the new and changed tests fail where the behaviour is new: 19 approvals cases and 2 Operator Chat cases. The six not-bound cases pass there by construction, because origin/main never binds the bearer. They are guards, and mutation runs show they fail on a regression.
  TEST: outputs/red-origin-main-results.txt (21 failed, 73 passed, 94 tests in 3 files; full console log not committed)

## Decisions taken

- The Operator Chat test is in its own file (`test/operator-chat-service-token.test.ts`), and its change is its own commit, so the separate operator-chat-service-token lane can take it. Its path is outside the approvals-auth-v2 lane paths until the plan amendment in wt-pa2 lands (branch `kiro/mt-track-s-authz/plan-amend-1-sync`, head `76b22526d4`).
- The bind tests drive the real SSE route, the real WebSocket server and the real orb-tool route. The stubs are `verifyAndExtractIdentity`, `startLiveSessionForWs`, `finalizeLiveSession` and `VERTEX_PROJECT_ID` set to empty. `VERTEX_PROJECT_ID` falls back to a decommissioned GCP project name, and `googleAuth` is always constructed, so without the stub the routes would pass the gate that starts the upstream Live API connect. The run log shows the gate closed with the stub (`googleAuth=true, VERTEX_PROJECT_ID=EMPTY`).
- No new export was added to `orb-live.ts`. The WebSocket start is reached through the existing `initializeOrbWebSocket` entry point.
- origin/main moved from `56281ad0b8` to `7292527d60` (one commit, VTID-05208 lane close) during this session. That commit changes none of the lane's files, so the red run was made against `7292527d60`.
- `developer-tools.test.ts` changed seven call sites to pass a developer identity with `user_jwt`. These are fixtures that keep the approve and reject tests reaching the route after the gate. Their assertions are unchanged, and they pass on origin/main by construction, so they do not prove the fix. The approvals file carries the red proof.
- Staging verification is not run here. The `FINAL_URL` and `CURL_PROOF` lines are pending STAGING-VERIFY on the merge commit.

## Open items

- PR-GATE `sparring` check fails on this record: `.kiro/specs/mt-track-s-authz/sparring/verdict.md` has no "owner approval" line. The record is approved by policy `converged-auto-v1`, which is the approval path for CI-sparred plans, so the text rule cannot match it. The check is report-only (`scripts/ci/pr-gate/config.json` has `enforce: false`). Nothing was edited to satisfy it. The owner decides whether the rule should accept the policy approval.
- On origin/main, the verdict does not list VTID-05528. The amendment branch (wt-pa2, `76b22526d4`) lists it, and that file lands with the plan amendment.
- `test/operator-chat-service-token.test.ts` is outside the approvals-auth-v2 lane paths until the plan amendment lands, and the scope in this folder already includes it.
- The PR body still needs `VALIDATION_PROFILE: gateway_backend`, and the VALIDATOR-CHECK route-evidence fields are pending STAGING-VERIFY (see `FINAL_URL` and `CURL_PROOF`).

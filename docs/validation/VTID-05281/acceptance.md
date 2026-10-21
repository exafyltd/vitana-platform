# VTID-05281 — acceptance (lane kaf-fallback-env/ff-pm-flag)
VALIDATION_PROFILE: gateway_backend
Scope: `services/gateway/src/services/project-manager/observe-live.ts`,
`services/gateway/test/project-manager/observe-live.test.ts`, `docs/validation/VTID-05281/**`, the lane file.
`decide.ts`, `governance.ts`, `github-rest.ts`, `loop.ts`, `types.ts`, routes unchanged. No workflow, migration or
task-definition change. Repairs the VTID-05277 staging suite (`/mode` == `kiro_fallback`).
OASIS impact: no.
AC-1 — `GithubRestReader.variable` returns the value only on a 200 with a string `value`; a 404 (unset or no access)
or any other non-string answer throws `GithubHttpError`; a 403 still throws. Signature stays `Promise<string | null>`.
TEST: npx jest test/project-manager/observe-live.test.ts -t "B1|B2|B3" (services/gateway)
AC-2 — `observeClaude`: a readable `true`/`false` wins (B6); a read that threw or returned null/unparseable uses
`parseFlag(env.CLAUDE_AVAILABLE)` (B4 `false`, B5 `true` / unset → `null`).
TEST: npx jest test/project-manager/observe-live.test.ts -t "B4|B5|B6" (services/gateway)
AC-3 — The 4 h rule is kept: 404 + env `true` + a `next_actor: claude` item older than 4 h with no `session_` commit →
`claudeAvailability` = `{available:false, reason:'no_action_4h'}` (B7).
TEST: npx jest test/project-manager/observe-live.test.ts -t "B7" (services/gateway)
AC-4 — No `workflow_dispatch`, `/dispatches` or `AWS-PROD-DEPLOY` string in PM sources.
TEST: npx jest test/project-manager (services/gateway; fallback.test.ts)
AC-5 — Staging (read-only STAGING-VERIFY on the merge commit; the one that counts for `/mode` is the second lane to
land, plan §4): `/alive` 200; `/api/v1/project-manager/mode` 200 with
`{ok: true, enabled: true, mode: "live", executor_mode: "kiro_fallback"}`; `/status` invalid-bearer probe 401.
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/project-manager/mode (staging only, run by STAGING-VERIFY from `staging-tests.json`)
ROUTE_MOUNT: no route added; `GET /api/v1/project-manager/mode` and `/status` exist on main (VTID-05274).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/project-manager/mode (staging)
CURL_PROOF: no request by hand; the staging proof is the STAGING-VERIFY run of `staging-tests.json` on the merge commit.

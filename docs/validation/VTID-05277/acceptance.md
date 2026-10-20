# VTID-05277 — acceptance (lane kiro-autonomy-fallback/staging-proof)
VALIDATION_PROFILE: gateway_backend
Scope: `services/gateway/test/kiro-autonomy-fallback-proof.test.ts` (new, test only — no runtime code changes),
`docs/validation/VTID-05277/**`, the lane file. No workflow, migration or task-definition change. Staging suite:
`staging-tests.json` (read-only: GET or `rejected_probe`; nothing aimed at production).
OASIS impact: no.
AC-1 — Claude availability: only `CLAUDE_AVAILABLE=false` (`flag_false`) or the 4 h rule (`no_action_4h`, not
overridden by `true`) make Claude unavailable; unset / unknown / `true` keep today's routing.
TEST: npx jest test/kiro-autonomy-fallback-proof.test.ts (services/gateway)
AC-2 — `/mode` is public and returns exactly `{ok, enabled, mode, executor_mode}`; after a tick that observed the flag
`false` the default router reports `executor_mode: kiro_fallback`; `/status` answers 401 without a token and with the
STAGING-VERIFY invalid probe bearer, and with the service token carries `claude`, `fallback`, `last_lease`.
TEST: npx jest test/kiro-autonomy-fallback-proof.test.ts (services/gateway)
AC-3 — While Claude is unavailable, end-of-rotation reassigns (ready and review), parks and every decision of a tick go
to the exceptions seat `exafyltd`, never `claude`; with Claude available the end of rotation still goes to `claude`.
TEST: npx jest test/kiro-autonomy-fallback-proof.test.ts (services/gateway)
AC-4 — Staging (read-only STAGING-VERIFY on the merge commit): `/alive` 200; `/api/v1/project-manager/mode` 200 with
`{ok: true, enabled: true, mode: "live", executor_mode: "kiro_fallback"}`; `/status` invalid-bearer probe 401.
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/project-manager/mode (staging only, run by STAGING-VERIFY from `staging-tests.json`)
ROUTE_MOUNT: no route added; `GET /api/v1/project-manager/mode` and `/status` exist on main (VTID-05274).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/project-manager/mode (staging)
CURL_PROOF: no request by hand for the suite; the staging proof is the STAGING-VERIFY run of `staging-tests.json` on
the merge commit. Precondition read (driver, once, read-only, staging): see `commands.log`.

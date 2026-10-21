# VTID-05282 — acceptance (lane kaf-fallback-env/ff-stage-env)
VALIDATION_PROFILE: gateway_backend
Scope: `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` (step `taskdef`), `services/gateway/test/kaf-staging-claude-available-wiring.test.ts`
(new), `docs/validation/VTID-05282/**`, the lane file. No `AWS-PROD-*` file, no other workflow, no runtime code, no migration.
Staging suite: `staging-tests.json` (read-only GET + Jest; nothing aimed at production).
OASIS impact: no.

AC-1 — The step `taskdef` env (outside `run:`) has `CLAUDE_AVAILABLE_VALUE: ${{ vars.CLAUDE_AVAILABLE || 'true' }}`:
`'false'` passes through, empty → `'true'`.
TEST: npx jest test/kaf-staging-claude-available-wiring.test.ts (services/gateway)

AC-2 — The jq call gets `--arg CLAUDE_AVAILABLE "$CLAUDE_AVAILABLE_VALUE"` before `--arg TASK_ROLE "$TASK_ROLE_ARN" '`, which
stays the last arg; no comment or apostrophe added inside the jq program.
TEST: npx jest test/kaf-staging-claude-available-wiring.test.ts test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts (services/gateway)

AC-3 — `CLAUDE_AVAILABLE` is stripped (`"PM_AGENT_ENABLED","PM_MODE","CLAUDE_AVAILABLE"`) and upserted exactly once
(`{name:"CLAUDE_AVAILABLE", value:$CLAUDE_AVAILABLE}` next to `PM_MODE`), so redeploys never duplicate it.
TEST: npx jest test/kaf-staging-claude-available-wiring.test.ts (services/gateway)

AC-4 — Production untouched: `AWS-PROD-DEPLOY-GATEWAY.yml` contains no `CLAUDE_AVAILABLE`; the `taskdef` run: block stays
under the 20,000-char cap (cap unchanged).
TEST: npx jest test/kaf-staging-claude-available-wiring.test.ts test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts (services/gateway)

AC-5 — Staging (read-only STAGING-VERIFY on the merge commit): `/alive` 200 and the wiring suite as `existing`.
CURL: GET https://preview-aws-gateway.vitanaland.com/alive (staging only, run by STAGING-VERIFY from `staging-tests.json`)
ROUTE_MOUNT: no route added.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/alive (staging)
CURL_PROOF: no request by hand; the staging proof is the STAGING-VERIFY run of `staging-tests.json` on the merge commit.

# VTID-04944 — production deploys keep VTNA payouts on

Owner decision 2026-10-07: "Yes, pin them on". Plan sparred (2 rounds, converged), owner approved.

## Why
Payouts were switched on in production on 2026-10-06 20:55 UTC. Publishes on 2026-10-07 at 07:10, 07:35, 09:45 and 09:58 UTC
carried no `env_overrides`, so the VTID-04896/VTID-04899 pins switched both switches back to `false` each time
(run 37602791115 and 37604302802 logs: `REWARD_SWEEP_ENABLED=false (expected false)`).

## Acceptance
AC-1 `AWS-PROD-DEPLOY-GATEWAY.yml` "Build task-definition (reward payouts on)" pins `REWARD_SWEEP_ENABLED` and `AUTOPILOT_ACTION_REWARD_ENABLED` to `"true"`, before step 2/2 (env_overrides), so a `"false"` override wins. Mutation-checked: reverting the sweep pin to `"false"` fails the test (commands.log).
TEST: services/gateway/test/vtid-04896-prod-reward-sweep-pin.test.ts

AC-2 "Verify reward sweep setting" defaults to `EXPECTED=true` / `EXPECTED_AP=true`; an explicit env_overrides key still sets the expectation; read-only; a mismatch fails the job (rollback).
TEST: services/gateway/test/vtid-04899-autopilot-reward-switch.test.ts

AC-3 `conversation-flag-pins.generated.ts` is regenerated (prod `"true"` for both) and current.
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-4 Commerce MCP pins are unaffected; the sweep reads as on in production.
TEST: services/gateway/test/vtid-04897-prod-commerce-mcp-pin.test.ts

AC-5 Production proof after the next publish without overrides: the job prints `REWARD_SWEEP_ENABLED=true (expected true)` and `AUTOPILOT_ACTION_REWARD_ENABLED=true (expected true)`; build-info answers JSON.
CURL: https://gateway.vitanaland.com/api/v1/admin/build-info

`.claude/rules/backend.md` §13c rule 8 records the pin and the off switch.

## Not changed
No code path, database or staging behaviour. The generated pins file is a data mirror; `rewardSweepAllowed()` and
`isRuleLive()` read `process.env`.

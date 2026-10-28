# VTID-05011 - EventBridge automation jobs carry their own gateway token

Owner Gate 1 "yes", 2026-10-09. Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Each AP-XXXX job names the token of the gateway it calls: prod token for https://gateway.vitanaland.com, staging token otherwise.
  TEST: services/gateway/test/vtid-05011-eventbridge-automation-token.test.ts
AC-2: Staging-target jobs (test-contract scanners, handoff sweep) are unchanged; any other AUTOMATIONS_GATEWAY_URL is refused.
  TEST: services/gateway/test/vtid-05011-eventbridge-automation-token.test.ts
AC-3: Existing script behaviour (--only filter, cron conversion, test-contract schedules) unchanged.
  TEST: services/gateway/test/vtid-04352-eventbridge-only-filter.test.ts
  TEST: services/gateway/test/vtid-04673-eventbridge-cron-conversion.test.ts

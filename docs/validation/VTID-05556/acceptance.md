# VTID-05556 - the ORB reads memory only through recall()

Plan: `.kiro/specs/memory-legacy-read-retire-r2/` (converged, policy-approved). Lane `bridge-recall-only`.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: An identified read goes through recall() only, whatever MEMORY_ORB_RECALL_ENABLED says.
  TEST: services/gateway/test/services/memory/recall-bridge-wiring.test.ts
AC-2: A not-ok recall returns ok:false, no items and recall's error, and makes no network call (no legacy query, no shadow).
  TEST: services/gateway/test/services/memory/recall-bridge-wiring.test.ts
AC-3: Tenant scoping: recall() gets exactly the caller's tenant_id/user_id, never DEV_IDENTITY's; the bridge runs no direct memory_items query.
  TEST: services/gateway/test/services/orb-memory-bridge.test.ts
AC-4: The dev-sandbox fallback is unchanged in shape: no identity and bridge disabled returns ok:false with DEV_IDENTITY.
  TEST: services/gateway/test/services/orb-memory-bridge.test.ts
AC-5: The flag pins in both deploy workflows are unchanged.
  TEST: services/gateway/test/vtid-04452-staging-orb-recall-pinned.test.ts

## Merge precondition (plan premise 7, task D1)
Before merge, the 14-day production count of not-ok recalls (`[VTID-04452] orb recall unavailable`) and of sessions served by
the legacy read is taken read-only (`scripts/memory/recall-shadow-report.sh /vitana/gateway-awsdr 336`) and recorded in
`outputs/recall-failures.md`. Above about 0.5% of sessions, the lane parks and the owner is told.
Result (owner, read-only, 2026-11-05): 1 legacy-served read of 392 (0.26%), 0 broker failures. Met.

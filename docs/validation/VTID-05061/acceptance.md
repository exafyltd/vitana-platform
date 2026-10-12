# VTID-05061 - Orphan reaper must not tombstone sparring-bound VTIDs

Owner approval 2026-10-10 (Gate 1). Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

Change: `allocatedOrphanReaperTick()` in `services/gateway/src/services/dev-autopilot-execute.ts`.
No route, migration, auth or deploy-config change. OASIS_IMPACT: no (the new per-tick count is a console.warn, not an event).

## Acceptance criteria

AC-1: The reaper's candidate SELECT excludes every `vtid_ledger` row whose metadata carries `sparring_id` or `sparring_id_unverified` (`metadata->>sparring_id=is.null&metadata->>sparring_id_unverified=is.null`); allocated placeholder shells without a binding are still selected exactly as before (status, title, 10 min grace unchanged).
  TEST: services/gateway/test/vtid-05061-reaper-sparring-guard.test.ts

AC-2: The tombstoning PATCH filter carries the same two `is.null` conditions, so a row that gained a binding between SELECT and PATCH is never tombstoned; the PATCH still writes status/is_terminal/terminal_outcome as before.
  TEST: services/gateway/test/vtid-05061-reaper-sparring-guard.test.ts
  TEST: services/gateway/test/vtid-03818-reaper-terminal-flag.test.ts

AC-3: Each tick counts sparring-bound placeholder shells older than 1 h (status=allocated, placeholder title, limit 50) and writes one `console.warn` ("reaper: skipped N sparring-bound shell(s) older than 1h") when N > 0. No OASIS event.
  TEST: services/gateway/test/vtid-05061-reaper-sparring-guard.test.ts

AC-4: Mutation check: dropping the guard from the SELECT, from the PATCH, either key, or the warn makes the new test fail.
  TEST: docs/validation/VTID-05061/outputs/mutation-check.txt

AC-5: The Operator pipeline regression stays green.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts (npm run test:operator)

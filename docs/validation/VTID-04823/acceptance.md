# VTID-04823 — the VTID-04545 session-start characterization pins the local hour

VTID-04595 holds the morning journey greeting (and its `last_session_date` stamp) until 05:00 local. The VTID-04545
characterization suite runs its daytime scenarios against the real clock in `Europe/Berlin`, so 9 of its 28 tests
failed every night between 00:00 and 05:00 Berlin (22:00–03:00 UTC) — on `main` and on every PR's gateway Jest job.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: The suite mocks only `localHourInTimezone` (10:00) and keeps the real `todayInTimezone` and the rest of `new-day-return`; every assertion is unchanged; 28/28 pass at any hour (verified at 00:47 Berlin, where 9 failed before).
  TEST: services/gateway/test/orb/live/session/vtid-04545-session-start-characterization.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/test/orb/live/session/vtid-04545-session-start-characterization.test.ts (one jest.mock)
- docs/validation/VTID-04823/**

## OASIS

OASIS_IMPACT: none (test only).

## MERGE_PAYLOAD_PREVIEW

Test-only; no runtime change. Ships in the same PR as VTID-04821, whose gateway Jest job it unblocks at night.

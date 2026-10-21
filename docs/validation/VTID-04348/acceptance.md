# VTID-04348 — Acceptance

## Context

`e09eb26` ("Revert: auto-fix 593cb4d1 failed deploying verification") removed
`services/gateway/test/services/action-executors.test.ts` (143 lines) and the
VTID-04289 evidence pack. The revert came from the Dev Autopilot reconciler,
not from a failing test: execution 593cb4d1 was claimed by the production
gateway, which never receives a deploy event for a merge to `main`, so its
30-minute deploy window lapsed and the change was reverted. The tests were
never wrong. The owner asked to restore them (2026-09-23).

## Acceptance Criteria

AC-1: The action-executors suite is back in the tree and passes on current main.
TEST: services/gateway/test/services/action-executors.test.ts

AC-2: The VTID-04289 evidence pack is restored alongside it.
TEST: services/gateway/test/services/action-executors.test.ts (the pack's AC mapping points at this suite)

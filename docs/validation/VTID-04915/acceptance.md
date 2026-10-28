# VTID-04915 — community event host entry and event edits reach the calendar (platform part)

Plan: `plan-sparring.md` (converged, 3 rounds, plan hash `e64911d9c6d0734acc94b829b02e0991ac172df64b28a7895bebc46b6f06ac38`), Phase 1 item 7.
The app part (entry actions, entry deep link, retiring the older popup) is exafyltd/vitana-v1 under the same VTID.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (migration only).

FINAL_URL: n/a.

CURL_PROOF: n/a (database triggers; applied after merge through RUN-MIGRATION.yml).

OASIS_PROOF: n/a.

## Acceptance criteria

AC-1: Creating a community event gives its host one calendar entry with the VTID-04321 shape plus metadata.host=true; no entry without start time or creator.
  TEST: scripts/ci/sql-tests/run-community-event-calendar-test.sh (CI SQL-COMMUNITY-EVENT-CALENDAR)
AC-2: Editing time, end, place, link, title or description moves every live entry for the event (host, attendees, legacy client rows) in one set-based UPDATE; unrelated events and cancelled entries are untouched; no-op updates rewrite nothing.
  TEST: scripts/ci/sql-tests/run-community-event-calendar-test.sh (CI SQL-COMMUNITY-EVENT-CALENDAR)
AC-3: Deleting an event cancels every live entry for it, and nothing else.
  TEST: scripts/ci/sql-tests/run-community-event-calendar-test.sh (CI SQL-COMMUNITY-EVENT-CALENDAR)
AC-4: The function is not executable by anon/authenticated; hosts of future events are backfilled once, past events never; the migration is idempotent.
  TEST: services/gateway/test/vtid-04915-community-event-calendar-migration.test.ts

# VTID-04965 — acceptance

AC-1 Subscribing ("Erinnern") to a pending, future Live Room gives the member one calendar entry (`source_type` and `source_ref_type` `live_room`, length = the room's duration, or 60 minutes when it has none).
TEST: scripts/ci/sql-tests/vtid-04965-live-room-calendar.test.sql (steps 1 and 2; CI SQL-LIVE-ROOM-CALENDAR)

AC-2 Un-subscribing cancels that entry; subscribing again revives the same row and never creates a duplicate.
TEST: scripts/ci/sql-tests/vtid-04965-live-room-calendar.test.sql (step 5)

AC-3 A room that is not pending, has no date, or already started never reaches the calendar, and unsubscribing from one room never touches another room's entry.
TEST: scripts/ci/sql-tests/vtid-04965-live-room-calendar.test.sql (steps 3 and 6)

AC-4 Registered service and test accounts get no entry, from the trigger or the backfill.
TEST: scripts/ci/sql-tests/vtid-04965-live-room-calendar.test.sql (step 4 and the backfill block)

AC-5 Reminders set before the trigger existed are backfilled once for pending, future rooms only, and a second run adds nothing.
TEST: scripts/ci/sql-tests/vtid-04965-live-room-calendar.test.sql (backfill block, migration run twice)

AC-6 The migration keeps its safety properties: set-based cancel, no loop or network call, only a cancelled row is revived, trigger function not executable by clients.
TEST: services/gateway/test/vtid-04965-live-room-calendar-migration.test.ts

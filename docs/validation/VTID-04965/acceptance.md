# VTID-04965 acceptance

- Subscribing ("Erinnern") to a pending, future Live Room gives the member one calendar entry (`source_type` and `source_ref_type` `live_room`, length = room duration or 60 min).
- Un-subscribing cancels it; subscribing again revives the same row, never a duplicate.
- Rooms that are not pending, have no date or already started never reach the calendar.
- Registered service/test accounts get no entry (trigger and backfill).
- Existing reminders for pending, future rooms are backfilled once.

Evidence: `scripts/ci/sql-tests/run-live-room-calendar-test.sh` (PASS, plus one mutation: dropping the pending filter makes it fail), `npx jest test/vtid-04965-live-room-calendar-migration.test.ts` (8/8).

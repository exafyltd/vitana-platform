# VTID-04976 acceptance

AC-1 Creating a pending, future live room gives its host one calendar entry (source live_room, marked host, length = duration or 60 min); a host who is a registered test/service account gets none; a past room gets none.
TEST: scripts/ci/sql-tests/vtid-04976-live-room-host-calendar.test.sql (steps 1, 12)

AC-2 When the host reschedules, renames or changes the length of a room, every live entry (host and fans) moves with it; a cancelled entry is not moved and never revived by an edit.
TEST: scripts/ci/sql-tests/vtid-04976-live-room-host-calendar.test.sql (steps 5, 9)

AC-3 Cancelling a room, removing its date, or deleting it cancels every entry; starting or ending a room (status live / ended, or any future value) leaves the entries alone.
TEST: scripts/ci/sql-tests/vtid-04976-live-room-host-calendar.test.sql (steps 8, 10, 11)

AC-4 The host's own entry survives the host tapping and un-tapping Erinnern, and keeps the host flag; a fan's un-notify still cancels theirs.
TEST: scripts/ci/sql-tests/vtid-04976-live-room-host-calendar.test.sql (steps 3, 4)

AC-5 A fan who un-notified, then re-notifies after a reschedule, gets the entry back at the current time and title.
TEST: scripts/ci/sql-tests/vtid-04976-live-room-host-calendar.test.sql (step 6)

AC-6 A change to a column the trigger does not watch touches no calendar entry.
TEST: scripts/ci/sql-tests/vtid-04976-live-room-host-calendar.test.sql (step 7)

AC-7 The one-time host backfill revives a cancelled host entry, merges the host flag into an existing live one, adds nothing for past rooms or bot hosts, and adds nothing on a second run.
TEST: scripts/ci/sql-tests/vtid-04976-live-room-host-calendar.test.sql (backfill block, migration run twice)

AC-8 The migration keeps its safety properties: trigger-level WHEN on the change trigger, a status whitelist, set-based statements only, functions not executable by clients.
TEST: services/gateway/test/vtid-04976-live-room-host-calendar-migration.test.ts

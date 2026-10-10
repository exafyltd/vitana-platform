# VTID-04997 acceptance

AC-1 A health test order that is ordered, sample_kit_shipped, sample_received or processing and has an expected result date in the future gets one calendar entry at that date (15-minute span, event_type health, titled with the test name only); no entry for past dates, missing dates, cancelled/failed/quarantined/result_ready/delivered orders, or test/service accounts.
TEST: scripts/ci/sql-tests/vtid-04997-test-results-in-calendar.test.sql (backfill block, steps 1, 8)

AC-2 The entry moves with expected_result_at and follows a renamed test; nothing but the test name (no status text, partner reference or result data) is written into the row.
TEST: scripts/ci/sql-tests/vtid-04997-test-results-in-calendar.test.sql (steps 1, 2, 3)

AC-3 The entry is cancelled when the order becomes result_ready, delivered, cancelled, failed or quarantined, when the date is cleared or passes, or when the order is deleted; a cancelled entry is revived when the order is pending with a future date again; changing a column the trigger does not watch writes nothing.
TEST: scripts/ci/sql-tests/vtid-04997-test-results-in-calendar.test.sql (steps 4, 5, 6, 7, 10)

AC-4 A failing calendar write never blocks the order write (the function catches every error and only logs a warning).
TEST: scripts/ci/sql-tests/vtid-04997-test-results-in-calendar.test.sql (step 11)

AC-5 The entries create no reminders (reminder_offsets empty), belong only to the order's own user, and the one-time backfill adds only pending future entries and nothing on a second run.
TEST: scripts/ci/sql-tests/vtid-04997-test-results-in-calendar.test.sql (backfill block, steps 1, 9, migration run twice)

AC-6 The gateway's source-type list and the newest CHECK agree on 'test_result', all three triggers exist with trigger-level WHEN on the update trigger, and the functions are not executable by clients.
TEST: services/gateway/test/vtid-04997-test-results-in-calendar-migration.test.ts

AC-7 An expected test-result date is information, not committed time: it neither conflicts with a proposed time nor blocks a free slot.
TEST: services/gateway/test/vtid-04995-calendar-conflicts.test.ts
TEST: services/gateway/test/vtid-04996-calendar-find-a-time.test.ts

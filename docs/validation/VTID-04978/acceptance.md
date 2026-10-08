# VTID-04978 acceptance

AC-1 A new one-shot reminder made by the member (voice or app) that is pending gets one calendar entry (source reminder, personal, starts at the fire time, no extra calendar reminder); it carries the reminder's text and description.
TEST: scripts/ci/sql-tests/vtid-04978-reminders-in-calendar.test.sql (step 1)

AC-2 Snoozing moves the entry; a fired reminder leaves it where it is; completing marks it completed without cancelling it.
TEST: scripts/ci/sql-tests/vtid-04978-reminders-in-calendar.test.sql (steps 2, 3)

AC-3 Cancelling or failing a reminder, or deleting it, cancels the entry; setting it pending again revives the entry with the new text and time.
TEST: scripts/ci/sql-tests/vtid-04978-reminders-in-calendar.test.sql (steps 4, 5)

AC-4 Recurring reminders, the calendar's own system reminders, reminders already linked to a calendar entry, and test/service accounts are never mirrored (no loop with the calendar's reminder reconcile).
TEST: scripts/ci/sql-tests/vtid-04978-reminders-in-calendar.test.sql (steps 6, 8)

AC-5 Changing a column the trigger does not watch writes nothing to the calendar.
TEST: scripts/ci/sql-tests/vtid-04978-reminders-in-calendar.test.sql (step 7)

AC-6 The one-time backfill adds entries only for pending, future, member-made, one-shot reminders, and adds nothing on a second run.
TEST: scripts/ci/sql-tests/vtid-04978-reminders-in-calendar.test.sql (backfill block, migration run twice)

AC-7 The gateway's source-type list and the database CHECK agree on 'reminder', all three triggers carry the scope in their WHEN clause, and the function is not executable by clients.
TEST: services/gateway/test/vtid-04978-reminders-in-calendar-migration.test.ts

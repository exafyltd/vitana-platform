# VTID-04994 acceptance

AC-1 A Stripe subscription that is active, trialing or past due and ends in the future gets one calendar entry at its period end: "renews" while it will renew, "ends" when set to cancel at period end; no entry for past dates, other statuses, or test/service accounts.
TEST: scripts/ci/sql-tests/vtid-04994-subscription-dates-in-calendar.test.sql (steps 1, 2, 8)

AC-2 A grant (no Stripe subscription: redemption, founding, launch, earned) gets an "ends" entry at its end date.
TEST: scripts/ci/sql-tests/vtid-04994-subscription-dates-in-calendar.test.sql (step 6)

AC-3 A trialing subscription also gets a "trial ends" entry, which goes when it stops trialing.
TEST: scripts/ci/sql-tests/vtid-04994-subscription-dates-in-calendar.test.sql (step 7)

AC-4 The entry moves with the period end, is cancelled when the subscription stops being active or is deleted, and is revived when it is active again; changing a column the trigger does not watch writes nothing.
TEST: scripts/ci/sql-tests/vtid-04994-subscription-dates-in-calendar.test.sql (steps 3, 4, 5, 9)

AC-5 A failing calendar write never blocks the billing write (the function catches every error and only logs a warning).
TEST: scripts/ci/sql-tests/vtid-04994-subscription-dates-in-calendar.test.sql (step 10)

AC-6 The entries create no reminders (reminder_offsets empty), and the one-time backfill adds only active future entries and nothing on a second run.
TEST: scripts/ci/sql-tests/vtid-04994-subscription-dates-in-calendar.test.sql (backfill block, migration run twice)

AC-7 The gateway's source-type list and the newest CHECK agree on 'subscription', all three triggers exist with trigger-level WHEN on the update trigger, and the functions are not executable by clients.
TEST: services/gateway/test/vtid-04994-subscription-dates-in-calendar-migration.test.ts

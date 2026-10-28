# VTID-04673 — EventBridge cron migration script: valid expressions, visible errors

First live apply of `scripts/aws/setup-eventbridge-cron-migration.sh` (owner,
AWS CloudShell, 2026-09-26 16:38 UTC, 11 member-notification jobs, staging
shadow mode): Lambda and both IAM roles created, then
`Done. 0/11 schedules created/updated, 11 failed.` — every line said "see above
for the error" with nothing above, because the script sent the AWS output to
/dev/null. Root cause, `to_eventbridge_cron()` only appended a year:

- `0 8 * * *` became `cron(0 8 * * * *)`, which EventBridge rejects (exactly one
  of day-of-month / day-of-week must be `?`);
- weekday numbers were passed through, but EventBridge counts 1 = Sunday where
  unix counts 0 = Sunday, so `0 20 * * 5` (Friday) would have fired on Thursday
  and `0 18 * * 0` was invalid.

The owner created the 11 schedules by hand with corrected expressions (all 11 OK).

AC-1: daily and hourly jobs get `?` in day-of-week.
  TEST: services/gateway/test/vtid-04673-eventbridge-cron-conversion.test.ts
AC-2: unix weekday numbers map to names (0/7 = SUN, 5 = FRI, ranges kept).
  TEST: services/gateway/test/vtid-04673-eventbridge-cron-conversion.test.ts
AC-3: `*/N` becomes `0/N`; an expression EventBridge cannot express is refused, never guessed.
  TEST: services/gateway/test/vtid-04673-eventbridge-cron-conversion.test.ts
AC-4: every job the script defines converts to a valid shape.
  TEST: services/gateway/test/vtid-04673-eventbridge-cron-conversion.test.ts
AC-5: the AWS error is printed (no `> /dev/null 2>&1` on the schedule call), existing schedules are updated not re-created, and no pager stops the script.
  TEST: services/gateway/test/vtid-04673-eventbridge-cron-conversion.test.ts

The test runs the converter block embedded in the script itself (between the
`eventbridge-cron-converter` markers), so script and test cannot drift. Mutation
check: turning the day-of-week `?` back into `*` fails 2 of the 6 tests.

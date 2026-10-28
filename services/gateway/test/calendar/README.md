# Calendar regression suite (VTID-04458)

Protects the calendar's existing behaviour whenever calendar code changes.

    npm run test:calendar                              # what CI runs
    UPDATE_CALENDAR_GOLDEN=1 npm run test:calendar     # re-record after an intended change

| File | Protects |
|---|---|
| `calendar-logic.golden.test.ts` | Recurrence (DST, 31st, BYDAY/INTERVAL, COUNT/UNTIL, zones), role lenses and busy blocks, move rules, default reminders and quiet hours with their text, Google / Outlook / iCloud / `.ics` mapping and push plans, work lenses, rescheduler, "today", producer diffs, journey stage, request schemas |
| `calendar-routes.contract.test.ts` | Every `/api/v1/calendar` route: existence and order, 401 for anonymous callers, staff-only jobs, validation errors, response shapes, what reaches the services |
| `calendar-coverage.guard.test.ts` | Every calendar source file is in `manifest.json` with at least one test that imports it; the CI workflow watches the code and runs every listed suite |
| `__golden__/*.json` | The recorded expected outputs |

When a change is **meant** to alter calendar behaviour, re-record and commit
the `__golden__` diff in the same PR: the reviewer then sees exactly which
scenario changed. When it is not meant to, a failure here is the bug.

A new calendar file (any `src/**/*calendar*.ts`) must be added to
`manifest.json` with the test that covers it, or the guard fails.

Runs fully offline: every service below the routes is a scripted fake, and
nothing reads or writes a database.

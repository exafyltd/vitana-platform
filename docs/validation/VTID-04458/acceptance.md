# VTID-04458 — Calendar regression suite (gateway)

Goal: a new calendar feature can no longer silently change existing calendar
behaviour. Any calendar change runs one suite; any moved rule fails it.

## Acceptance criteria

AC-1: Golden scenarios pin the pure calendar logic: recurrence across DST, the 31st, BYDAY+INTERVAL, COUNT/UNTIL and fallback zones; role lenses and busy blocks; move rules; default reminders, quiet hours and reminder text; Google / Outlook / iCloud / .ics output and push plans; work lenses; rescheduler; today; producer diffs; journey stage; request schemas.
TEST: services/gateway/test/calendar/calendar-logic.golden.test.ts (49 tests)

AC-2: Every /api/v1/calendar route is pinned: route table, 401 for anonymous callers with no service call, staff-only jobs, validation errors, response shapes, and what reaches the services.
TEST: services/gateway/test/calendar/calendar-routes.contract.test.ts (37 tests)

AC-3: A calendar source file without a covering test fails the build; a listed test that stops importing its file fails the build.
TEST: services/gateway/test/calendar/calendar-coverage.guard.test.ts (24 tests)

AC-4: `npm run test:calendar` runs the new suite plus every existing calendar feature suite (17 suites, 366 tests), and gives the same result under TZ=UTC, Pacific/Auckland and America/Los_Angeles.
TEST: docs/validation/VTID-04458/outputs/test-calendar.txt

AC-5: The suite catches real regressions. Four deliberate breaks were each caught: default reminder 10→15 min (4 failures), monthly rule no longer skipping months without a 31st (1), a busy block carrying a title (1), window limit 62→90 days (1).
TEST: docs/validation/VTID-04458/outputs/mutation-check.txt

AC-6: CI runs it on every change to calendar code, connected apps, calendar migrations or the suite itself (`.github/workflows/CALENDAR-REGRESSION.yml`), offline, with no secrets, and fails if the run re-records a golden file.
TEST: services/gateway/test/calendar/calendar-coverage.guard.test.ts (workflow assertion)

## Scope

Test code, a package.json script and a CI workflow only. No calendar source,
no migration, no database access.

# VTID-04680 — a member's calendar holds only what they created or accepted

Reported by the platform owner 2026-09-26: every day of the calendar, looking
forward, was full of entries nobody asked for. Measured the same day (read-only):

- The VTID-04356 goal-plan trigger wrote each plan habit as a daily series
  (08:00 local, until the plan's target date — up to 2036) and each weekly
  check-in as its own entry: 555 generated entries (61 habit series, 444
  check-ins, 50 milestones) across 19 members, up to 6 entries on a day.
- The staff work lens added every deploy (~10 a day, 300 in 30 days) to the
  calendar of anyone in the admin or developer role.

What changes:

AC-1: a goal-plan habit or check-in no longer creates a calendar entry; only milestones do.
  TEST: services/gateway/test/vtid-04680-calendar-stays-clean.test.ts
AC-2: no daily series is written for a goal plan (no RRULE in the new function).
  TEST: services/gateway/test/vtid-04680-calendar-stays-clean.test.ts
AC-3: a plan leaving 'active' still cancels its open entries; milestone completion still follows the step.
  TEST: services/gateway/test/vtid-04680-calendar-stays-clean.test.ts
AC-4: the window route returns work items only with include_work=true.
  TEST: services/gateway/test/calendar/calendar-routes.contract.test.ts
AC-5: the developer lens never reads deploys.
  TEST: services/gateway/test/vtid-04357-calendar-work-lenses.test.ts
AC-6: the one-shot fix cancels (never deletes) only untouched habit/check-in entries the trigger wrote, with their pending reminders.
  TEST: services/gateway/test/vtid-04680-calendar-stays-clean.test.ts

Dry run of the data fix against the live project (read-only SELECT of the
same WHERE clause, 2026-09-28): 505 entries (61 habits / 19 members, 444
check-ins / 16 members), 31 pending reminders. Milestones (50) stay.

The data fix is NOT applied by this PR. It is run separately, after the
platform owner has reviewed the rows.

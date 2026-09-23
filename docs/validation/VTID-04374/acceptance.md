# VTID-04374 — Calendar maintenance: rescheduler, reprioritizer, move, retire /meetup-reminders

Follow-on to the Vitanaland calendar redesign (VTID-04320 … VTID-04358). The
owner asked for the rest of the plan to be built without waiting for input.

## What was wrong (all measured, 2026-09-23)

- `POST /calendar/reschedule` and `/reprioritize` run a job over **every**
  user's calendar, but any signed-in member could call them.
- Nothing called them on a schedule. Their only caller was GCP Cloud
  Scheduler, which was shut down on 2026-08-16.
- The rescheduler's candidate rules would have done harm the moment anything
  ran it:
  - It picked up recurring series, because a habit's first row always lies in
    the past. It would move them and, after three runs, cancel them.
  - It picked up entries already marked done.
  - It moved journey milestones and sentinels, which mark out the 90-day
    journey rather than being tasks.
  - It shifted times by an hour across daylight-saving changes, because it
    added 24 h in UTC.
  - It had no lookback limit. There are **849** missed suggestions going back
    to April, and **0** from the last three days. The first run would have
    dragged all 849 onto tomorrow, and default reminders would have fired
    for each one.
- `/scheduled-notifications/meetup-reminders` read `community_meetup_attendance`,
  a table that does not exist. `community_meetups` has 0 rows, and **0**
  `meetup_starting_*` notifications have ever been sent.
- A member had no way to move their own entry. `PATCH /events/:id` exists,
  but it would move a booked appointment or a lab order too, and the source
  would move it back.

## Acceptance criteria

- **AC-1:** Only one-off Autopilot recommendations and journey tasks are
  moved. They must be not completed, not activated, from the last 3 days, and
  their local day must be over. Recurring series, milestones and completed
  entries never move.
  TEST: `vtid-04374-calendar-maintenance.test.ts` › rescheduleUnactivatedTasks.
- **AC-2:** A moved entry keeps its local wall-clock time, including across a
  daylight-saving change, and never lands in the past.
  TEST: › nextSlot.
- **AC-3:** After 3 moves the entry is dropped (`cancelled` / `skipped`).
  Each write re-checks that the row is still open, so racing with "mark done"
  is safe.
  TEST: › "drops an entry after 3 moves", › "a row completed in the meantime".
- **AC-4:** `/reschedule` and `/reprioritize` return 403 for members and work
  for Exafy staff.
  TEST: › flags and routes.
- **AC-5:** The in-process loop runs only when `CALENDAR_MAINTENANCE_ENABLED`
  is exactly `true`. That value is pinned on staging only, never on prod.
  TEST: › "the loop runs only on exactly true", › "wired at boot and pinned on
  staging only".
- **AC-6:** `/meetup-reminders` is a no-op, and nothing reads the missing
  table.
  TEST: › "/meetup-reminders is retired",
  `routes/scheduled-notifications-meetup-rsvp-error-logging.test.ts`.
- **AC-7:** `POST /events/:id/move` moves your own entry and keeps its
  length. It refuses entries owned by their source, completed, cancelled or
  recurring with 409 `NOT_MOVABLE` plus a reason. Bad input and work items
  get 400. `/events/window` reports `movable` for each entry.
  TEST: › moving your own entry.

OASIS_IMPACT:
- `calendar.event.moved` is new.
- `calendar.event.rescheduled` and `calendar.event.auto_cancelled` now carry
  `VTID-04374` instead of `SYSTEM`.
- The prioritizer's `calendar.prioritization.completed` is unchanged.

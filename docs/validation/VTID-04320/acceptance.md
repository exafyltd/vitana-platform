# VTID-04320 — Calendar step 1: reminders fire again (+ VTID-04321 backend repair)

Step 1 of the Vitanaland calendar redesign, approved by the platform owner in
conversation on 2026-09-23. This PR carries two VTIDs: VTID-04320 (reminder
dispatch) and its companion VTID-04321 (calendar backend repair). The
frontend half, VTID-04322, is a separate PR in `exafyltd/vitana-v1`.

## What was broken (read live, 2026-09-23, read-only)

- **No reminder has fired since 2026-07-07.** Five `reminders` rows were
  `pending` with `next_fire_at` 1-12 days in the past and
  `dispatch_attempts = 0`. The tick and sweeper existed only as
  `POST /scheduled-notifications/reminders-tick|-sweeper`, called by the GCP
  Cloud Scheduler that was switched off 2026-08-16; the EventBridge
  replacement (`scripts/aws/setup-eventbridge-cron-migration.sh`) was never
  applied.
- **Community event sign-ups never reached the calendar.** The RSVP trigger
  (`fn_rsvp_to_calendar`) sits on `event_attendance` (0 rows); real sign-ups
  go to `global_event_participants`, which had no calendar trigger. Only the
  web join button wrote a row itself; voice RSVPs and ticket flows wrote none.
- **`backoffice` had no calendar view** — missing from `ROLE_TO_CONTEXTS`, so
  it fell back to the community view.
- **`/upcoming-events` computed "today" and the pushed time in UTC**
  (`setHours` / `getHours` on the gateway clock).
- **`calendar_add_event` wrote `tenant_id`**, a column `calendar_events` does
  not have, so every consent-gated calendar write failed; any unrecognised
  `event_type` would also have failed the CHECK.

## What changed

- `services/reminders-dispatch.ts`: the tick, sweeper and push moved out of the
  route file; the routes delegate. `startRemindersDispatchLoop()` runs them
  in-process (tick 30 s, sweeper 5 min) behind
  `REMINDERS_INPROCESS_DISPATCH_ENABLED=true`, pinned on the staging workflow
  only. The claim RPC is `FOR UPDATE SKIP LOCKED`, so several tasks are safe.
- Stale guard: a pending reminder more than `REMINDERS_STALE_AFTER_MINUTES`
  (60) past due is closed `failed` / `delivery_via='stale_skipped'` with a
  `reminder.stale_skipped` OASIS event, never pushed. This decides the five
  overdue rows: they are closed, not pushed 1-12 days late (the `/stream` SSE
  poll has no time bound either, so marking them `fired` would pop a
  full-screen interrupt on the web).
- Migration `20260923120000_vtid_04321_rsvp_calendar_global_events.sql`:
  trigger on `global_event_participants` (join creates one `community_rsvp`
  row, leave cancels every live row for that user+event) plus a dedupe trigger
  so the web client's own row replaces the trigger row instead of duplicating.
  **Applied to the live project 2026-09-23 via Supabase MCP `apply_migration`
  before merge**; both triggers confirmed present. No backfill needed: all 18
  existing sign-ups are for past events.
- `types/calendar.ts`: `backoffice` → admin + personal; shared
  `CALENDAR_EVENT_TYPES`.
- `services/calendar-today.ts` + `/upcoming-events`: per-user timezone.
- `action-executors.ts`: no `tenant_id`, validated `event_type`,
  `source_type='assistant'`.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — Reminder tick/sweeper logic lives in one service the routes and the in-process loop share; the loop starts only with `REMINDERS_INPROCESS_DISPATCH_ENABLED` exactly `true`.
TEST: services/gateway/test/vtid-04320-reminders-dispatch.test.ts

AC-2 — Pending reminders older than the stale threshold are closed without a push, before the claim, and a failing guard never blocks the tick.
TEST: services/gateway/test/vtid-04320-reminders-dispatch.test.ts

AC-3 — Staging pins the flag with strip-then-add; the prod workflow does not carry it.
TEST: services/gateway/test/vtid-04320-reminders-dispatch.test.ts

AC-4 — A sign-up in `global_event_participants` creates exactly one calendar row on every path (voice, web), leaving cancels it, rejoining reactivates it.
TEST: services/gateway/test/vtid-04321-calendar-backend-repair.test.ts (migration contract) + outputs/rsvp-trigger-local-pg.txt (behaviour, 8 scenarios on a local Postgres)

AC-5 — `backoffice` sees and writes the admin calendar view.
TEST: services/gateway/test/vtid-04321-calendar-backend-repair.test.ts

AC-6 — `/upcoming-events` picks each user's first event on their local date and prints the local time.
TEST: services/gateway/test/vtid-04321-calendar-backend-repair.test.ts

AC-7 — `calendar_add_event` never writes `tenant_id` and falls back to `wellness_nudge` for an invalid type.
TEST: services/gateway/test/services/action-executors.test.ts

AC-8 — Live, after the staging deploy: a `[reminders-tick]` log line and `reminder.fired` / `reminder.stale_skipped` OASIS events appear without any external scheduler; the five overdue rows end `failed` / `stale_skipped`.
TEST: outputs/ — recorded after merge; NOT verified at PR time.

## Not done here, on purpose

- Production: the prod gateway workflow does not set the flag. Staging and
  prod share one database, so the staging loop dispatches every user's
  reminders; turning it on for prod as well is safe (SKIP LOCKED) but is a
  PUBLISH decision.
- Pushes come from the staging task's FCM credentials; whether that task def
  carries them was not verified from this session. In-app SSE delivery does
  not depend on it.
- `/calendar/reschedule` and `/reprioritize` are still unscheduled and
  JWT-gated — they need a user-free entry point, which belongs with step 2.
- `/meetup-reminders` still reads the never-deployed `community_meetups`
  tables; replaced by per-entry default reminders in step 3.

OASIS_PROOF: new topic `reminder.stale_skipped` (warning) from the tick; `reminder.fired` unchanged.

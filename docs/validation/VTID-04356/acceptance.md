# VTID-04356 — Calendar step 5: every plan, order, booking and room lands in the calendar

Step 5 of the Vitanaland calendar redesign (steps 1–3: VTID-04320/04321/04331/04338,
step 4 UI: VTID-04351 in `exafyltd/vitana-v1`). The owner asked that "every
accepted plan — nutrition, exercise, health plan, lab test order — lands in
the calendar", and approved the build in conversation on 2026-09-23.

## What was broken (read live, 2026-09-23, read-only)

- **Goal plans never reached the calendar.** 1,024 `goal_plan_steps` across
  25 active plans, 0 calendar rows. `goal-planner-service.mirrorStepsToCalendar`
  posted ONE bulk insert where habit rows carried `recurring_pattern` and
  milestone rows did not; PostgREST rejects a bulk insert with mismatched
  keys, and the error was caught as non-fatal. `goal_plan_steps.calendar_event_id`
  existed and was never set.
- **Health plans, provider appointments, lab orders and live-room tickets
  had no path to the calendar at all.** They are written by an edge function
  (`generate-personalized-plan`), the Stripe booking webhook, the lab order
  flow and the ticket flow — none of which the gateway sees.
- **Autopilot activation inserted a new row every time**, so a snoozed and
  re-activated recommendation got a second entry.
- **Voice-created entries mapped `professional`/`backoffice` to the
  community view** with a hand-written ternary instead of the shared
  `toWritableRoleContext`.
- **Ticking a goal-plan entry off in the calendar did not tick the step off
  in My Journey.**

## What changed

- Migration `20260923160000_vtid_04356_calendar_source_producers.sql`
  (applied live 2026-09-23): one SQL upsert, `calendar_upsert_from_source`,
  the twin of `calendar-producers.ts` (idempotent on the source-ref index,
  keeps completions, reactivates cancelled entries, no rewrite when
  unchanged), and a trigger per source table — see `DATABASE_SCHEMA.md`
  "calendar_events ← plans, bookings, orders, rooms". Every trigger body
  catches its own errors so the source write is never lost. The helpers and
  per-source sync functions are not executable by `anon`/`authenticated`.
  Future-only backfill.
- `goal-planner-service.ts`: the broken mirror is removed; the trigger
  replaces it.
- `calendar-producers.completeSourceForCalendarEvent`: `goal_plan_step`
  write-back (scoped to the user, never a habit series).
- `autopilot-recommendations.ts`: activation goes through
  `upsertCalendarEntryFromSource` keyed on the recommendation.
- `orb-live.ts` `create_calendar_event`: `toWritableRoleContext(role)`.

## Acceptance criteria

| AC | Criterion | Evidence |
|---|---|---|
| AC-1 | A goal plan's milestones/checkpoints appear at 09:00 local on their date, habits as a daily series 08:00 local (staggered 30 min) until the target date, each step linked by `calendar_event_id`. | TEST: `outputs/local-pg-scenarios.out` S1, S11 · live: 555 entries, 61 series, 555 steps linked |
| AC-2 | Re-touching a source is idempotent (no duplicate, no rewrite); moving it moves the entry; a completed entry is never moved. | TEST: S2, S3, S4 |
| AC-3 | Done ↔ completed both ways for goal steps; a superseded plan cancels its open entries. | TEST: S4, S5 · TEST: `services/gateway/test/vtid-04356-calendar-source-producers.test.ts` (write-back) |
| AC-4 | An active health plan becomes a daily series for its duration at a time that fits its type; deactivating cancels it. | TEST: S6 |
| AC-5 | An unpaid booking never shows; a paid one does with its duration; cancelling cancels; rebooking reactivates the same row. | TEST: S7 |
| AC-6 | A confirmed lab order is a lab entry (lab reminder rules); a collected sample completes it. | TEST: S8 |
| AC-7 | Live-room host and ticket holders get the session; moving it moves both; a revoked ticket cancels only the holder's. | TEST: S9 |
| AC-8 | A calendar failure never fails the source write. | TEST: S10 |
| AC-9 | Browsers cannot call the helpers. | TEST: `vtid-04356-calendar-source-producers.test.ts` · local: `permission denied` as `authenticated` · live: `has_function_privilege` false |
| AC-10 | Autopilot activation is idempotent; voice entries use the shared role mapping. | TEST: `services/gateway/test/routes/autopilot-recommendations.test.ts`, `vtid-04356-calendar-source-producers.test.ts` |

## Verification

- Local throwaway Postgres 16 with a schema mirroring the live columns and
  CHECKs: 34/34 scenario assertions pass (`outputs/local-pg-scenarios.*`).
- Gateway: `tsc --noEmit` clean; affected suites green (see PR).
- Live, read-only after apply: counts match the pre-apply dry run exactly
  (555 goal-plan entries / 22 users / 61 series, 3 health-plan series, 0
  entries with no timezone, 7 triggers, no browser execute).

## Not done here

- `partner_health_test_orders` — no appointment time; results surface via
  the partner-health provider.
- The 3 existing health plans were generated in January with 4-week
  durations, so their series ended in February; they show in history only.
- Assistant ad-hoc entries (`create_calendar_event`, `calendar_add_event`)
  have no source record, so they stay plain inserts.
- Step 6 (work lenses) and step 7 (ICS / Google) are next.

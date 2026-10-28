# VTID-04595 — the new-day greeting starts at 05:00 local

Owner rule (2026-09-26): "New day greeting is always after 5am. So if user has
a break of 5 hours within the same day, no new day greeting."

## What happened

Read-only in `oasis_events` / `user_journey` (owner's account, Europe/Berlin):
a conversation at 00:39 on 2026-09-26 counted as the first conversation of a
new calendar day. It fired the new-day briefing and stamped
`last_full_briefing_date` and `last_session_date` as `2026-09-26`. The
member's real first conversation of the morning (~08:00, after sleeping)
was then a same-day repeat, so there was no morning greeting. The opener
talked about what they had "already achieved this morning".

The day boundary was midnight in three places: the briefing guard
(`briefingDue`), the journey `daily_morning` greeting that stamps
`last_session_date`, and the new-day-return provider.

## Change

- `new-day-return.ts`: `NEW_DAY_START_HOUR = 5`, `isBeforeNewDayStart()`,
  `logicalDayInTimezone()`. The provider is suppressed between 00:00 and
  04:59 (`before_new_day_start`) and does not stamp then.
- `compute-greeting-decision.ts`: `briefingDue()` is false between 00:00 and
  04:59, so neither briefing rung (safe-fast or normal) fires or stamps then.
  An unknown hour (the `-1` placeholder) keeps the date-only rule.
- `journey-greeting.ts` / `live-session-controller.ts`: `decideGreetingKind`
  takes the local hour; no `daily_morning` (and so no `last_session_date`
  stamp) before 05:00. The one-time first-session welcome is unaffected.
- `login-briefing.ts`: days since the last session is measured against the
  Vitana day, matching what `last_session_date` records.
- `orb-live.ts`: the `newday_briefing_eval` diag reports
  `before_new_day_start`, and its `briefing_due` field follows the new guard.

The day-close (goodnight) rung is unchanged. It already treats 21:00–04:59
as the night.

## Acceptance criteria

AC-1: No new-day briefing, journey morning greeting or new-day-return greeting between 00:00 and 04:59 local, and none of them stamps a date then.
TEST: services/gateway/test/vtid-04595-new-day-starts-at-5am.test.ts

AC-2: The first conversation at or after 05:00 gets the new-day greeting, including after a 00:39 conversation the same calendar date (the reported case).
TEST: services/gateway/test/vtid-04595-new-day-starts-at-5am.test.ts

AC-3: A gap inside the same day (briefed at 07:00, back at 13:00, 22:00 or 23:00) never re-triggers it.
TEST: services/gateway/test/vtid-04595-new-day-starts-at-5am.test.ts

AC-4: The two copies of the 05:00 rule (provider and pure greeting brain) agree on every hour, and the Vitana day rolls back correctly across month and year ends.
TEST: services/gateway/test/vtid-04595-new-day-starts-at-5am.test.ts

## Data change (owner-approved in conversation)

The owner's own `user_journey.last_full_briefing_date` was reset from
`2026-09-26` to `2026-09-25`, so their next conversation gets today's
briefing. No other row was touched.

## Not verified

This was not observed in a live spoken session. The next real signal is the
owner's next conversation after 05:00 on staging, which should report
`wake_opener: newday_overview` (or `safe_fast_newday_overview`).

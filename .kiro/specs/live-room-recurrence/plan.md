---
change_class: standard
---
# plan(live-room-recurrence): repeating Live Rooms (weekly, monthly and more)

Owner, 6 Nov 2026 (Claude Code session `session_01Cp885FGVuZp27dQmDP6eMH`, on the owner's instruction in conversation):
*"It must also be possible to set an event, a live room, that repeats: once a week, once a month, etc. That option must
also be enabled."* Builds on `live-room-edit-cohost` (plan PR #4708): it reuses the shared session form and the edit
dialog that plan introduces, so it runs after those lanes.

<!-- plan:begin -->
## Goal
1. **Repeat option in Go Live and Edit.** The shared session form gets a "Repeat" control: never, daily, weekly, every
   two weeks, monthly, with an end rule (after N occurrences, or on a date). Edit shows the same control, prefilled.
2. **A series is many sessions.** Each occurrence is an ordinary `live_room_sessions` row, so the lobby, start, end,
   access grants, calendar entries and co-host rules of `live-room-edit-cohost` apply to every occurrence unchanged.
3. **Edit scope.** Editing a repeating session asks "this session" or "this and all following". Scheduled, unstarted
   occurrences follow the series; a live or ended one is never changed by a series edit.

## Today (file:line evidence on origin/main, 84a488d282)
- No live-room recurrence exists: `live_room_sessions` (`supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:48-70`)
  has one `starts_at`, no series column; `CreateSessionSchema` (`services/gateway/src/routes/live.ts:186-200`) has no repeat field.
- Recurrence exists for calendar entries: `calendar_events.rrule` (RFC 5545 body, validated by
  `supabase/migrations/20260923130000_vtid_04331_calendar_data_model.sql:26-33`) expanded by the gateway in
  `services/gateway/src/services/calendar-recurrence.ts` (`parseRRule` `:24`, `expandOccurrences` `:118`, zone handling
  `:66-92`). This plan reuses that parser and expander; it does not write a second one.
- Calendar entries for sessions come from `fn_live_room_session_to_calendar` (`20260923160000_vtid_04356_calendar_source_producers.sql`),
  which fires per session row, so every materialised occurrence reaches the calendar with no extra work.

## Interfaces between lanes
1. **SQL** (lane `db-live-series`, platform): table `public.live_room_series` (`id uuid pk`, `tenant_id`, `room_id`
   references `live_rooms` on delete cascade, `host_user_id`, `rrule text` with the same CHECK as `calendar_events`
   plus `FREQ=DAILY|WEEKLY|MONTHLY` and `INTERVAL`, `time_zone text`, `starts_at_first timestamptz`, `until_at timestamptz
   null`, `max_occurrences int` 2 to 52, `status` active|cancelled, `created_at`). Column
   `live_room_sessions.series_id uuid null references live_room_series(id) on delete set null` and
   `live_room_sessions.series_index int null`. A unique index on `(series_id, series_index)`. RLS: tenant members read
   their tenant's series; writes only via `service_role` (gateway). No browser writes.
2. **Create contract** (lane `gateway-live-series`): `POST /api/v1/live/rooms/:id/sessions` accepts an optional
   `recurrence: { frequency: "daily"|"weekly"|"biweekly"|"monthly", end: { count: 2..52 } | { until: ISO date } }`.
   The gateway expands the first occurrence from `starts_at` with `expandOccurrences`, creates the series row and then one
   session per occurrence through the existing `live_room_create_session` path, with `idempotency_key =
   series:<series_id>:<index>` so a retry converges. Maximum 52 occurrences and at most 12 months ahead. The reply adds
   `series: { id, occurrences: n, next_starts_at }`. A request without `recurrence` is unchanged.
3. **Rolling window:** the gateway materialises occurrences up to 8 weeks ahead. A scheduled run (`services/gateway`
   existing scheduler, one tick per hour, one run at a time) creates the missing rows for active series, using the same
   idempotency key, so the job is safe to repeat. A series stops at `until_at` or `max_occurrences`.
4. **Edit contract** (lane `gateway-live-series`, extends interface 3 of the edit plan): `PATCH .../sessions/current` gains
   `scope: "this" | "series"` (default `"this"`) and `recurrence` (change the rule or end, or `null` to stop repeating).
   `scope: "series"` updates the series row and every occurrence with `status = 'scheduled'` and `starts_at > now()`
   (time of day and title/description/other fields), never a `lobby`, `live` or `ended` one. Replies add
   `updated_occurrences: n`. `409 SERIES_NOT_FOUND` for a session without a series when `scope` is `"series"`.
   Cancelling a series: `POST .../sessions/series/cancel` (creator only) sets `status = 'cancelled'` on the series and on
   its scheduled occurrences; live and ended occurrences are untouched.
5. **Frontend** (lane `v1-live-series`): `LiveStream` and `LiveRoom` gain `seriesId`, `seriesIndex`, `recurrence`.
   `SessionFormFields` renders the Repeat control in both modes; `EditSessionDialog` shows the scope choice when the session
   has a series; `liveRoomService` types `recurrence` and `scope`.

## Change
### Lane `db-live-series` (exafyltd/vitana-platform, seat exafy)
One migration `supabase/migrations/20261106120000_live_room_series.sql` (timestamp after the cohost migration
`20261105170000`, so the two are sequenced): the table, the two columns, the unique index, RLS and the rrule CHECK.
Additive only: no existing function or row changes. `DATABASE_SCHEMA.md` changelog row. A throwaway-Postgres test
`scripts/ci/sql-tests/run-live-room-series-test.sh` with workflow `SQL-LIVE-ROOM-SERIES.yml`, same pattern as
`SQL-LIVE-ROOM-CALENDAR`. Applying the migration is an owner stop (`collaboration.md` §7d).

### Lane `gateway-live-series` (exafyltd/vitana-platform, seat exafy), depends on `db-live-series` and `gateway-cohost`
`services/gateway/src/services/live-series.ts` (expansion, validation, materialisation, series edit and cancel) and the
routes in `routes/live.ts`: the create `recurrence`, the PATCH `scope`, the cancel endpoint, and the scheduled
materialisation tick. It builds on `gateway-cohost`'s `live-cohosts.ts` and `live.ts` edits, so it must not start before
that lane is `done`. Tests `services/gateway/test/live-room-series*.test.ts`.

### Lane `v1-live-series` (exafyltd/vitana-v1, seat exafyltd), depends on `v1-edit-session` and `gateway-live-series`
The Repeat control in `SessionFormFields` (shared with Go Live), the scope prompt in `EditSessionDialog`, a "Repeats weekly"
label on cards and in the drawer, and the i18n keys (de first, du-form). It depends on `v1-edit-session` because that lane
owns `EditSessionDialog.tsx` and the list files.

## Decisions taken (conservative, listed for Gate 2)
- **Materialise, do not expand on read.** Each occurrence is a real session row, so every existing screen, grant and
  calendar entry works without change. Cost: a bounded number of rows (at most 52 per series, 8 weeks ahead at a time).
- **Frequencies are daily, weekly, biweekly and monthly.** Monthly repeats on the same day of month as the first start. No custom rules in
  this plan (no "every 3 days", no "first Monday of the month" choice).
- **Time zone:** the series keeps the creator's IANA zone (`time_zone`), so a weekly 18:00 stays 18:00 across DST.
- **Series edit touches only scheduled, future occurrences.** Anything that has started is never rewritten.
- **Access grants:** an occurrence created by a series follows the same access rule as a one-off session. Paid access on
  a series is not part of this plan (refused with `400 RECURRENCE_ACCESS_UNSUPPORTED` when `access_level` is paid).
- **Co-hosts:** the co-host list is copied to each occurrence at creation, as the edit plan's per-session rule says;
  a series edit with `scope: "series"` that changes `co_hosts` applies it to scheduled occurrences only.
- **No notification** to subscribers when a series is created or changed (same as the edit plan's "Not in this plan").
- **No What's New card:** a repeat option on an existing feature is an improvement, not a new finished feature.

## Lanes
- `db-live-series` (platform, seat exafy, `depends_on: []`)
- `gateway-live-series` (platform, seat exafy, `depends_on: [db-live-series]`)
- `v1-live-series` (v1, seat exafyltd, `depends_on: [gateway-live-series]`)
Shared and hot files: `services/gateway/src/routes/live.ts` (also `gateway-cohost`, sequenced by `depends_on`),
`src/i18n/*/liveRooms.json` and `docs/SCREEN_INVENTORY.md` (also the edit plan's v1 lanes, sequenced), `DATABASE_SCHEMA.md`.
The chain is serial on purpose: a Repeat control that saves nothing must never be visible on staging.

## External prerequisites (not expressible as `depends_on`)
The collab validator only accepts `depends_on` between lanes of the same spec. Two lanes of `live-room-edit-cohost` must be
`done` before any lane of this plan is claimed: `gateway-cohost` (before `gateway-live-series`, which edits the same
`routes/live.ts` and builds on `live-cohosts.ts`) and `v1-edit-session` (before `v1-live-series`, which edits the same
dialog and list files). Until both are `done` the lanes stay `ready` and unclaimed.

## Tests and commands
- SQL (throwaway Postgres): a series row with a valid rule is accepted, an invalid rule and `max_occurrences` outside 2 to 52
  are refused; the unique `(series_id, series_index)` holds; a browser session (`authenticated`) cannot insert a series row.
  Red on base: the table does not exist.
- Gateway Jest `test/live-room-series*.test.ts`: weekly and monthly expansion from a Monday and a month end, DST-safe
  time in the series zone, count and until ends, 52 cap, idempotent retry creates no duplicates, rolling window adds only
  missing occurrences, `scope: "series"` skips live and ended occurrences, cancel leaves live occurrences alone, a
  non-creator gets `403 NOT_HOST`. Existing suites stay green: `vtid-04904-live-daily-rooms`, `vtid-04905-live-enter-exit`,
  `vtid-04834-live-session-start-stop-once`, `vtid-04602-04604-go-live`, and `live-room-cohost*`. Plus `npm run typecheck`
  and `npm run build`.
- v1 Vitest: the Repeat control offers every frequency and end rule in both modes, the payload carries `recurrence`,
  the edit scope prompt appears only for a series session, "Repeats weekly" label shows on a series card. `npm test`,
  `npm run lint`, `npm run build`, `npm run i18n:inventory`.
- Staging (read-only): `staging-tests.json` probes `/alive` and `PATCH .../sessions/current` without a token (expects 401);
  the v1 lane ships a Playwright spec that opens Go Live, opens the Repeat control and asserts the options are listed. No
  series is created on staging (live write, vitana-v1 CLAUDE.md absolute rule); the Jest and SQL suites cover creation.

## Measurement (collaboration §8b)
`docs/validation/<plan VTID>/timings.json` as usual. Product check at Gate 2: every Repeat option the plan lists is
asserted by a test, not counted by hand.

## Risks
- Materialisation writes many rows. Mitigation: 52 cap, 8-week window, idempotency keys, hourly single-run tick.
- A rule that expands differently in the client and the gateway. Mitigation: only the gateway expands; the client sends
  the choice, not the dates.
- The shared form and the edit dialog are touched by three lanes in sequence. Mitigation: the `depends_on` chain above.

## Unchanged
Protected gate files, production workflows and deploys, the sidebar, the Spotlight design contract, Stripe and refund
logic, `live_room_create_session`, the calendar model, tenant isolation and the test-account allowlists, every existing test.
<!-- plan:end -->

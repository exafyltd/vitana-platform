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
   references `live_rooms` on delete cascade, `host_user_id`, `rrule text` with a tighter CHECK than `calendar_events`:
   `^FREQ=(DAILY|WEEKLY|MONTHLY)(;(INTERVAL=[1-9][0-9]*|COUNT=[1-9][0-9]*|UNTIL=[0-9]{8}T[0-9]{6}Z))*$` (no `BYDAY`: the
   gateway never generates it, so the table refuses it), `time_zone text`, `starts_at_first timestamptz`, `until_at timestamptz
   null`, `max_occurrences int` 2 to 52, `status` active|cancelled, `created_at`, and the session template
   `session_defaults jsonb not null` (`session_title`, `topic_keys`, `access_level`, `auto_admit`, `lobby_buffer_minutes`,
   `max_participants`, `metadata` incl. `stream_type`), and `co_host_user_ids uuid[] not null default '{}'` (validated by the
   gateway through `live_room_filter_co_hosts` of `live-cohosts`, the same rule as the edit plan). Column
   `live_room_sessions.series_id uuid null references live_room_series(id) on delete set null` and
   `live_room_sessions.series_index int null`. A unique index on `(series_id, series_index)`. RLS: tenant members read
   their tenant's series; writes only via `service_role` (gateway). No browser writes.
2. **Create contract** (lane `gateway-live-series`): `POST /api/v1/live/rooms/:id/sessions` accepts an optional
   `recurrence: { frequency: "daily"|"weekly"|"biweekly"|"monthly", end: { count: 2..52 } | { until: ISO date } }`.
   The gateway expands the occurrences from `starts_at` with `expandOccurrences` (`calendar-recurrence.ts:118`) over the
   window `{ from: now, to: now + 8 weeks }` only, and creates the series row. Occurrences after that window are created
   later by the hourly materialisation loop (Interface 3), so the POST creates at most about 8 weeks of rows and the
   materialiser is the single owner of rows beyond the window; the same idempotency key is used at the boundary. Occurrence 0
   is created through the existing `live_room_create_session` path, which makes it the room's `current_session_id`. Because
   that function's INSERT does not know the series columns, the gateway then sets `series_id` and `series_index = 0` on that
   row with a service_role UPDATE in the same request (after the series row exists). A retry repeats both steps: the
   idempotency key returns the same row and the UPDATE is idempotent, so occurrence 0 always belongs to its series. The
   remaining occurrences are inserted with `live_room_series_insert_occurrence` (idempotent, `series:<series_id>:<index>`),
   so they are scheduled rows that are not the room's current session. A retry converges.
   **Single-current-session rule:** a room has one `current_session_id` at a time (`live_rooms`, fk at
   `20260210100000_vtid_01228_live_room_session_mgmt.sql:95`). Only the nearest upcoming occurrence is ever linked to the
   room; the others are plain scheduled rows until promoted (Interface 6). Maximum 52 occurrences and at most 12 months ahead. The reply adds
   `series: { id, occurrences: n, next_starts_at }`. A request without `recurrence` is unchanged.
3. **Rolling window and two loops:** the gateway materialises occurrences up to 8 weeks ahead. A new worker
   `startLiveSeriesMaterialiser()` in `services/gateway/src/services/live-series.ts`, registered in `services/gateway/src/index.ts`
   behind the env gate `LIVE_SERIES_MATERIALISER_ENABLED` (default off until verified), runs two independent loops, each with
   its own in-process lock so no two runs of the same loop overlap:
   - **Promotion loop, every 5 minutes:** calls `live_room_series_promote_next` (Interface 6) for every room with an active series.
   - **Materialisation loop, every hour:** creates the missing occurrence rows inside the 8-week window (below). Heavier, so
     it runs less often and never blocks promotion. It does not use the user-JWT RPC `live_room_create_session`: it calls the new
   SQL function `live_room_series_insert_occurrence(p_series_id uuid, p_index int)` (service_role only, SECURITY DEFINER).
   That function reads host, tenant, rule, time, the `session_defaults` template and `co_host_user_ids` from the
   `live_room_series` row, checks that the series is `active` and that the room exists, inserts one `live_room_sessions` row
   with those values (so every occurrence carries the title, topics, access, stream type and co-hosts the host chose),  with `idempotency_key = series:<series_id>:<index>` and
   `ON CONFLICT DO NOTHING`, and returns the row or nothing. Host ownership is therefore checked against the stored series
   row, not a JWT. A series stops at `until_at` or `max_occurrences`.
   Every series lifecycle operation emits an OASIS event: `live.series.created`, `live.series.updated`,
   `live.series.cancelled` (the same emission pattern as session lifecycle in `room-session-manager.ts`).
4. **Edit contract** (lane `gateway-live-series`, extends interface 3 of the edit plan): `PATCH .../sessions/current` gains
   `scope: "this" | "series"` (default `"this"`) and `recurrence` (change the rule or end, or `null` to stop repeating).
   `scope: "series"` updates the series row first (its `session_defaults`, `co_host_user_ids`, and the rule when given), then
   every occurrence with `status = 'scheduled'` and `starts_at > now()` (time of day, title, topics, access, co-hosts and the
   other template fields), so later materialised rows read the new template. It never changes a `lobby`, `live` or `ended` one. Replies add
   `updated_occurrences: n`. `409 SERIES_NOT_FOUND` for a session without a series when `scope` is `"series"`.
   Cancelling a series: `POST .../sessions/series/cancel` (creator only) sets `status = 'cancelled'` on the series and on
   its scheduled occurrences; live and ended occurrences are untouched. If the room's `current_session_id` was one of the
   cancelled occurrences, the gateway then resets the room with a service_role UPDATE to `status = 'idle'`,
   `current_session_id = NULL`, `host_present = false` (the same effect as `live_room_end_session`), so the room is never left
   pointing at a cancelled session. Both steps run in one request and a retry repeats them safely.
5. **Frontend** (lane `v1-live-series`): `LiveStream` and `LiveRoom` gain `seriesId`, `seriesIndex`, `recurrence`.
   `SessionFormFields` renders the Repeat control in both modes; `EditSessionDialog` shows the scope choice when the session
   has a series; `liveRoomService` types `recurrence` and `scope`.

6. **Next-occurrence promotion** (lane `db-live-series`, called by lane `gateway-live-series`). SQL function
   `live_room_series_promote_next(p_room_id uuid) returns uuid` (service_role only, SECURITY DEFINER). When the room is
   `idle` (its session ended or was cancelled, `live_room_end_session` at `...session_mgmt.sql:469` resets it), it picks the
   earliest occurrence of a series on that room with `status = 'scheduled'` and `starts_at > now() - lobby_buffer` and sets
   `live_rooms.current_session_id` to it and `status` to `scheduled`. The function first runs
   `SELECT ... FROM public.live_rooms WHERE id = p_room_id FOR UPDATE`, so concurrent callers on any instance are serialised
   by the row lock and a room cannot be promoted twice or skipped (the platform runs on ECS, so instances are not in-process). It returns that session id, or NULL when none is left.
   A room that is not `idle` is never changed. A live or ended occurrence is never promoted.
   Trigger: the 5-minute promotion loop of Interface 3 runs it for every room that has an active series, so the next
   occurrence is linked at most about 5 minutes after the previous one ends. `live_room_end_session`,
   `room-state-machine.ts` and the room status values are unchanged.
   A scheduled occurrence whose `starts_at` is more than 1 hour in the past and was never opened is set to `cancelled`
   with `metadata.cancel_reason = 'missed'` by the hourly materialisation loop, so it cannot block the next promotion.
   (Promotion skips it in the meantime, so a missed occurrence never delays the next one by more than an hour.)

## Change
### Lane `db-live-series` (exafyltd/vitana-platform, seat exafy)
One migration `supabase/migrations/20261106120000_live_room_series.sql` (also the SQL functions
`live_room_series_insert_occurrence` (Interface 3) and `live_room_series_promote_next` (Interface 6), both service_role only) (timestamp after the cohost migration
`20261105170000`, so the two are sequenced): the table, the two columns, the unique index, RLS and the rrule CHECK.
Additive only: no existing function or row changes. `DATABASE_SCHEMA.md` changelog row. A throwaway-Postgres test
`scripts/ci/sql-tests/run-live-room-series-test.sh` with workflow `SQL-LIVE-ROOM-SERIES.yml`, same pattern as
`SQL-LIVE-ROOM-CALENDAR`. Applying the migration is an owner stop (`collaboration.md` §7d).

### Lane `gateway-live-series` (exafyltd/vitana-platform, seat exafy), depends on `db-live-series` and `gateway-cohost`
`services/gateway/src/services/live-series.ts` (expansion, validation, materialisation, series edit and cancel, the
worker `startLiveSeriesMaterialiser`, OASIS events) and the routes in `routes/live.ts`: the create `recurrence`, the PATCH
`scope`, the cancel endpoint. Registration of the worker is a one-line change in `services/gateway/src/index.ts`, which every
gateway worker touches: `index.ts` is a shared hot file, and only this lane edits it in this plan. It builds on `gateway-cohost`'s `live-cohosts.ts` and `live.ts` edits, so it must not start before
that lane is `done`. Tests `services/gateway/test/live-room-series*.test.ts`.

### Lane `v1-live-series` (exafyltd/vitana-v1, seat exafyltd), depends on `v1-edit-session` and `gateway-live-series`
The Repeat control in `SessionFormFields` (shared with Go Live), the scope prompt in `EditSessionDialog`, a "Repeats weekly"
label on cards and in the drawer, and the i18n keys (de first, du-form). It depends on `v1-edit-session` because that lane
owns `EditSessionDialog.tsx` and the list files.

## Decisions taken (conservative, listed for Gate 2)
- **One linked session per room.** Only the nearest upcoming occurrence is the room's `current_session_id`; the rest are
  promoted one at a time, about 5 minutes after the previous session ends. A missed occurrence (never opened, more than
  1 hour late) is cancelled so it cannot stall the series.
- **The materialiser is a new worker with its own env gate and lock**, not a shared scheduler (none exists).
- **Creation window:** the POST creates only the 8-week window; the materialiser owns everything after it.
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
Shared and hot files: `services/gateway/src/routes/live.ts` and `services/gateway/src/index.ts` (the latter only this lane
in this plan; `gateway-cohost` also edits `live.ts`, sequenced by the external prerequisite),
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
- Gateway Jest, added for session-2 round 3: cancelling a series whose occurrence is the room's current session returns the
  room to `idle` with no current session.
- Gateway Jest, added for session-2 round 2: after a create with a series, occurrence 0 has `series_id` and `series_index = 0`;
  a retried create leaves exactly one occurrence 0; series edit and cancel reach occurrence 0.
- SQL (throwaway Postgres), added for session-2 round 1: a series row with `BYDAY` is refused; a materialised occurrence
  carries the series `session_defaults` and `co_host_user_ids`; two concurrent promotions on one room promote exactly one
  occurrence (the `FOR UPDATE` serialises them).
- SQL (throwaway Postgres), added for round 2: a series of 3 creates one linked session and two scheduled rows; ending
  occurrence 0 and running promotion links occurrence 1 and nothing else; promotion never changes a `live` or `ended`
  session or a non-idle room; a missed occurrence is cancelled, not promoted.
- Gateway Jest `test/live-room-series*.test.ts`: the worker never calls the user-JWT RPC and inserts only through
  `live_room_series_insert_occurrence`; an overlapping tick is skipped by the lock; OASIS events emitted on create, edit and
  cancel; weekly and monthly expansion from a Monday and a month end, DST-safe
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
logic, `live_room_create_session` (unchanged; the gateway links occurrence 0 after it, see Interface 2), the calendar model, tenant isolation and the test-account allowlists, every existing test.
<!-- plan:end -->

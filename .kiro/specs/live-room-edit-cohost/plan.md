---
change_class: standard
---
# plan(live-room-edit-cohost): one session form for create and edit, and co-hosts who can run the live

Owner, 5 Nov 2026 (Kiro Web): *"When we want to edit a Live Room, the edit window must be the same as when we create
it, so that we can edit everything we entered, and the current state is that we can only edit what is shown in the
screenshot (title, description, cover image). Also, when adding a co-host, it does not offer me a drop-down menu with
existing accounts, which I would add as a co-host and which could run the live as well."*

<!-- plan:begin -->
## Goal
1. **Edit = create.** The Edit Session dialog shows every field the Go Live dialog shows (title, description, stream
   type, duration, cover, tags, access level, schedule, chat, polls, recording, co-hosts), prefilled, and saves all of
   them. Both dialogs render one shared form component, so they cannot drift apart again.
2. **Co-host picker.** The co-host field becomes a searchable drop-down of existing community members (chips for the
   chosen ones), in both dialogs.
3. **Co-hosts run the live.** A chosen co-host can open the room from the cards, enter it with moderator rights
   (Daily owner token) and moderate it, exactly where the creator can, except for the money and ownership actions
   listed under Decisions taken.

## Today (file:line evidence on origin/main)
- Edit dialog: `vitana-v1/src/components/liverooms/EditSessionDialog.tsx:39-211` has title, description, cover only.
  It saves with `useUpdateStream` (`src/hooks/useLiveStreams.ts`, `supabase.from('community_live_streams').update`),
  a browser write to the listing table that never reaches `live_room_sessions` / `live_rooms`.
- Create dialog: `vitana-v1/src/components/GoLivePopup.tsx:59,601-615` has the co-host box as a plain `<Input>` whose
  value (`coHostInput`) is never read again; `sessionRequest` (`:255-276`) carries no co-hosts.
- `community_live_streams.co_hosts` (TEXT[], `vitana-v1/supabase/migrations/20251022080341_*.sql:10`) is written by
  nobody. Its only reader is the `stream_recordings` SELECT policy
  (`20251022113129_*.sql:18-31`, `auth.uid()::text = ANY(co_hosts)`).
- Host identity is `live_rooms.host_user_id` everywhere: gateway `routes/live.ts:1122` (`enter`, decides the Daily
  `isOwner` token at `:1189-1193`), `:1373` (`/daily`), `room-session-manager.ts:376` (`cancelSession`), and the SQL
  functions `live_room_transition_status`, `live_room_end_session`, `live_room_set_host_present`,
  `live_room_get_lobby`, `live_room_admit_user`, `live_room_reject_user`, `live_room_admit_all`, `live_room_kick_user`,
  `live_room_ban_user`, `live_room_join_session` (role at `:568`), `live_room_get_state` (viewer role at `:824`,`:839`),
  `live_room_check_access` and `live_room_update_metadata`. Latest definitions: `20260210100000_vtid_01228_live_room_session_mgmt.sql`
  and `20260209_vtid_01228_daily_co_live_rooms_fixed.sql`. A co-host is therefore a plain guest today.
- No gateway endpoint edits a session after creation (`PATCH /rooms/:id`, `routes/live.ts:2192`, only changes the
  permanent room's name, slug, cover and description). The creator-only UPDATE policy on `community_live_streams` also
  lets a browser write any user id into `co_hosts` (no tenant check, test and service accounts included).
- Member search already exists: `src/hooks/useMentionCandidates.ts` calls `search_mention_candidates`
  (`vitana-v1/supabase/migrations/20261006140000_vtid_04926_mentions.sql:22-61`), which is tenant-scoped, excludes the
  caller, `notification_test_actors` and `service_bot_accounts`, and returns at most 10 rows.

## Interfaces between lanes
1. **SQL** (lane `db-cohost-authz`, platform):
   - `public.live_room_is_host(p_room_id uuid, p_user_id uuid) returns boolean` (STABLE, SECURITY DEFINER): true when
     `live_rooms.host_user_id = p_user_id`, or when `p_user_id` is in `community_live_streams.co_hosts` for that room id
     and shares the room's tenant (`user_tenants`).
   - `public.live_room_filter_co_hosts(p_creator uuid, p_ids uuid[]) returns uuid[]` (SECURITY DEFINER, EXECUTE for
     `service_role` only): keeps the ids that pass `_mention_recipient_ok(p_creator, id)` (same tenant, not the creator,
     not a test or service account), de-duplicated, order kept.
   - Every host gate listed under Today, except the creator-only ones below, calls `live_room_is_host(room, auth.uid())`.
   - Trigger on `community_live_streams` (BEFORE INSERT OR UPDATE OF co_hosts): a statement whose JWT role is
     `authenticated` or `anon` cannot set or change `co_hosts` (error `CO_HOSTS_GATEWAY_ONLY`). `service_role` and the
     migration owner are unaffected.
2. **Create contract** (lane `gateway-cohost`): `POST /api/v1/live/rooms/:id/sessions` accepts a top-level optional
   `co_hosts: uuid[]` (max 5). The gateway runs it through `live_room_filter_co_hosts` with the service role; if any id
   is dropped it answers `400 INVALID_CO_HOSTS` with the dropped ids (never a silent drop). The listing upsert always
   writes `co_hosts` (the validated list or `[]`), and now also writes `enable_chat`, `enable_polls`, `enable_recording`
   from `metadata` (today `enable_chat` is hard-coded `true` and the other two are not written).
3. **Edit contract** (lane `gateway-cohost`): `PATCH /api/v1/live/rooms/:id/sessions/current`, `requireAuth`, creator
   only (`live_rooms.host_user_id = identity.user_id`, read with the service role; the unverified JWT decode used by the
   create route is not reused). Body, every key optional: `session_title`, `description`, `cover_image_url` (string or
   null), `stream_type` (audio|video), `topic_keys` (1 to 3), `access_level` (public|group), `starts_at`,
   `duration_minutes` (integer 5 to 480), `enable_chat`, `enable_polls`, `enable_recording`, `co_hosts`. Replies:
   `200 { ok, session }`, `400 VALIDATION | INVALID_CO_HOSTS | START_IN_PAST`, `401`, `403 NOT_HOST`,
   `404 ROOM_NOT_FOUND`, `409 NO_ACTIVE_SESSION | SESSION_LOCKED (field list) | HAS_ACCESS_GRANTS`,
   `502 LISTING_SYNC_FAILED` (the same request is safe to repeat). It writes `live_room_sessions` first (title, topics,
   access, `starts_at`, `ends_at = starts_at + duration`, merged `metadata`), then `live_rooms.access_level`, then the
   `community_live_streams` row, so the three stay consistent. While the session is `live` or `lobby`, `starts_at`,
   `duration_minutes`, `access_level` and `stream_type` are locked (409 `SESSION_LOCKED`).
4. **Enter / host gate** (lane `gateway-cohost`): `isHost` in `enter` and `/daily` is `host_user_id === caller` or, for
   other callers, the RPC `live_room_is_host` (service role). An RPC failure means "not host". The creator path makes no
   extra call. `cancelSession` keeps comparing `host_user_id` (creator only).
5. **Frontend**: `LiveStream` rows already carry `co_hosts`, `enable_*`, `stream_type`, `tags`, `access_level`,
   `duration_minutes`, `scheduled_for` (`useLiveStreams.ts:5-31`). `LiveRoom` gains `coHosts`, `accessLevel`,
   `enableChat`, `enablePolls`, `enableRecording`. "Can run" (Start, Manage, host controls) = creator or listed co-host;
   "can edit or delete" stays creator only.

## Change
### Lane `db-cohost-authz` (exafyltd/vitana-platform)
One migration `supabase/migrations/20261105170000_live_room_cohost_authz.sql`: the two functions, the host gates (each
`CREATE OR REPLACE` restates the latest body, defaults and grants; only the host comparison changes), the
`co_hosts` trigger, and a rollback note in the header. `kick` and `ban` refuse a target for whom
`live_room_is_host(room, target)` is true (`TARGET_IS_HOST`), so a co-host cannot remove the creator or another
co-host. Creator-only and unchanged: `live_room_create_session`, `live_room_update_room_name`, `live_room_start`,
`live_room_end`. `DATABASE_SCHEMA.md` gets its changelog row. A throwaway-Postgres test
(`scripts/ci/sql-tests/run-live-room-cohost-test.sh`) and its workflow `SQL-LIVE-ROOM-COHOST.yml` follow the
`SQL-LIVE-ROOM-CALENDAR` pattern. Applying the migration is an owner stop (`collaboration.md` §7d).

### Lane `gateway-cohost` (exafyltd/vitana-platform), depends on `db-cohost-authz`
`routes/live.ts`, `room-session-manager.ts`, a new `services/live-cohosts.ts` (validation call, `isRoomHost`, edit
orchestration) and tests. Implements interfaces 2 to 4. Until the migration is applied, a request that carries
`co_hosts` answers `503 CO_HOST_VALIDATION_UNAVAILABLE` (it never accepts unvalidated ids), and a non-creator caller is
"not host", which is today's behaviour.

### Lane `v1-session-form` (exafyltd/vitana-v1), depends on `gateway-cohost`
New shared `SessionFormFields` (all fields of today's Go Live form, with `mode="create" | "edit"`) and `CoHostPicker`
(popover list fed by `useMentionCandidates`, avatar and name rows, chips with remove, max 5, keyboard and screen-reader
support, loading, empty and error states). `GoLivePopup` renders `SessionFormFields` and sends `co_hosts` in the create
request; its create flow, retry and navigation logic are unchanged. `liveRoomService` gets `updateSession`. New i18n
keys, de first.

### Lane `v1-edit-session` (exafyltd/vitana-v1), depends on `v1-session-form`
`EditSessionDialog` renders the same `SessionFormFields` in edit mode, prefilled from the `LiveStream`, sends only the
changed fields to `PATCH .../sessions/current`, shows locked fields as disabled with a one-line reason while the session
is live. `useUpdateStream` stops writing the listing table from the browser. Co-host awareness: `LiveRoom` mapping in
`LiveRooms.tsx`, the Start / Manage buttons and drawer on `LiveRoomCard`, `LiveRoomDrawer`, `LiveRoomEventCard`,
`MobileLiveRoomCarousel`, `EventsLiveRooms`, and `LiveRoomViewer` (host controls follow the gateway's `entry.is_host`).
Native parity: if NATIVE-CI asks for it, the ledger row of `/comm/live-rooms` records an exception naming the in-flight
native live rooms port (VTID-05532).

## Decisions taken (conservative, listed for Gate 2)
- **Co-host powers:** enter with the moderator token, open the lobby and start the room, mark host present, admit,
  reject and admit all, kick and ban guests, end the session. **Not:** cancel (it refunds paid grants), create a
  session, edit the session, delete it, manage the co-host list, rename the room.
- **Who can be a co-host:** a member of the creator's tenant, not the creator, not a test or service account, at most 5.
- **Per session:** each new session starts with exactly the co-hosts picked when it was created; nothing carries over.
- **Locked while live:** start time, duration, access level, stream type. An access-level change is refused when the
  session already has valid access grants (paid or granted).
- **Removing a co-host** removes every SQL-gated power at once. A Daily token already issued stays valid until the
  Daily room expires; the creator can kick that person.
- **Not in this plan:** notifying an invited co-host, notifying subscribers of a time change (the calendar triggers
  already move calendar entries), a What's New card (an improvement of an existing feature).

## Lanes
- `db-cohost-authz` (platform, seat exafy, `depends_on: []`)
- `gateway-cohost` (platform, seat exafy, `depends_on: [db-cohost-authz]`)
- `v1-session-form` (v1, seat exafyltd, `depends_on: [gateway-cohost]`)
- `v1-edit-session` (v1, seat exafyltd, `depends_on: [v1-session-form]`)
Shared and hot files: `src/i18n/*/liveRooms.json` (v1 lanes, sequenced by `depends_on`), `docs/SCREEN_INVENTORY.md`
(both v1 lanes, sequenced), `services/gateway/src/routes/live.ts` (one lane), `DATABASE_SCHEMA.md` (one lane).
The chain is serial on purpose: a picker that saves nothing, or an edit form that calls a missing route, must never be
visible on staging.

## Tests and commands
- SQL (throwaway Postgres): creator and listed co-host are hosts; an unlisted member, a co-host of another tenant and a
  listed id outside the room's tenant are not; `kick`/`ban` of a host is refused; an `authenticated` JWT cannot change
  `co_hosts`, `service_role` can; the filter drops creator, other tenant, test and service accounts.
  Red on base: the functions do not exist.
- Gateway Jest `test/live-room-cohost*.test.ts`: `enter` as co-host gets `isOwner: true` and `is_host: true`; unlisted
  member gets a participant token; RPC failure means participant; creator makes no extra call; `/daily` follows the
  same rule; `cancel` by a co-host is `NOT_HOST`; create validates, writes and resets `co_hosts`; `PATCH` is creator
  only, honours the locks, writes the three stores consistently and survives a listing failure with a repeatable retry.
  Existing suites stay green: `vtid-04904-live-daily-rooms`, `vtid-04905-live-enter-exit`,
  `vtid-04834-live-session-start-stop-once`, `vtid-04602-04604-go-live`; plus `npm run typecheck` and `npm run build`.
- v1 Vitest: `CoHostPicker` (search, select, remove, max, keyboard, states), `SessionFormFields` renders the same
  fields in both modes, `GoLivePopup` sends `co_hosts`, `EditSessionDialog` prefills every field and sends only changed
  ones, locked fields, co-host sees Start and Manage but not edit or delete, viewer uses `entry.is_host`. Existing
  `GoLivePopup.*` and `LiveRoom*` tests stay green; `npm test`, `npm run lint`, `npm run build`, `npm run i18n:inventory`.
- Staging (read-only): `staging-tests.json` of the gateway lane probes `PATCH /api/v1/live/rooms/<nil-uuid>/sessions/current`
  without a token (expects 401) and `/alive`; the v1 session-form lane ships a Playwright spec that opens Go Live,
  expands Advanced options, types in the co-host field and asserts the member drop-down appears (a read through the
  existing RPC, nothing is created). Saving an edit or running a live as co-host needs a live write, so it is **not
  verified on staging**; the unit and SQL tests above cover it (vitana-v1 CLAUDE.md absolute rule).

## Measurement (collaboration §8b)
`docs/validation/<plan VTID>/timings.json` as usual. Product check at Gate 2: the number of fields in the Edit dialog
equals the number in Go Live (asserted by a test, not counted by hand).

## Risks
- The migration changes the host gate of 13 functions that every live room uses. Mitigation: each function keeps its
  latest body; the creator branch is evaluated first; the SQL test runs every function for the creator, a co-host and a
  stranger.
- Migration and gateway deploy through separate pipelines to one database. Mitigation: the gateway treats a missing
  helper as "not host" and refuses `co_hosts` with 503, so a deploy in either order leaves creators unaffected.
- A co-host's Daily owner token can outlive removal until the Daily room expires (see Decisions taken).
- The shared-form refactor touches the Go Live dialog. Mitigation: only the field markup moves; `handleGoLive`, the
  stuck-room retry and the navigation stay in `GoLivePopup`, and the existing source-pinning tests stay green.
- Existing browser UPDATE policy: the trigger blocks `co_hosts` only; title and description edits by the creator through
  the browser stay possible until `useUpdateStream` is removed from the dialog (lane `v1-edit-session`).

## Unchanged
Protected gate files, production workflows and deploys, the sidebar, the Spotlight design contract, Stripe and refund
logic, `live_room_create_session`, the permanent-room model, tenant isolation and the test-account allowlists, every
existing test.
<!-- plan:end -->

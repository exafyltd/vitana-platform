# Plan sparring record — VTID-04905 (LR-A2; shared plan with LR-A1 VTID-04904, LR-A2 VTID-04905, LR-B, LR-C)

Plan hash (sha256 of the text between the plan markers): `163af71f5724a3daa539a3072fc379ef7450c8061fde141aec6dceb0216452c5`. Partner: plan-sparring-partner, 2 rounds, CONVERGED. Owner approved in session 2026-10-05 ("Fix everything i have listed and dont stop").

# Plan: Live Rooms end to end — create, list in the Events catalog, join counter, enter and run the room

Planner: Claude Code session (owner: d.stevanovic@exafy.io). Date: 2026-10-05.

<!-- plan:begin -->
## Owner request (2026-10-05)
"Investigate the whole process of setting up a new event and in this case Live Room. Then posting and make visible in Events catalog. Then show counter of people joining. Then enter the Live room and make it work. The whole Live Room features need a rebuild." — "Fix everything … don't stop."

## Verified current state (code, read-only; four investigations + spot checks)
Architecture: video = Daily.co prebuilt iframe (`vitana-v1 src/components/liverooms/DailyVideoRoom.tsx`), joined by bare URL, no token. Lifecycle tables `live_rooms` (one permanent room per user, trigger on `user_tenants`) + `live_room_sessions`; listing table `community_live_streams` (id = live_rooms.id) kept in sync by best-effort service-role writes in gateway `routes/live.ts`. Events are a separate table `global_community_events`; no link between events and live rooms.

Blocking defects (why a room does not work today):
- B1 Rate limits are per IP (`live.ts` L53-90, express-rate-limit, no `trust proxy`, no `keyGenerator` anywhere in the gateway — grep verified). Behind the ALB every member shares one IP: `/rooms/:id/daily` (5 / 15 min, called on demand by every VIEWER, `LiveRoomViewer.tsx` ~L149-173) and `/rooms/:id/sessions` (5 / 15 min, Go Live) are exhausted community-wide → "Too many …" / "Videoraum konnte nicht geladen werden".
- B2 `DAILY_API_KEY` is wired only in the GCP-era `scripts/deploy/deploy-service.sh:155`; no AWS workflow/script references it (grep verified). If absent on the ECS task def, `/daily` throws → 500 for everyone. Not verifiable from the session (no AWS CLI, production probes forbidden).
- B3 Daily rooms are created once per permanent room (`vitana-<roomId>`) with `exp` = now+24h (`daily-client.ts` L53-91); on later sessions the 400 path returns the existing (expired) room without refreshing `exp`; `/daily` short-circuits on the stored URL (`live.ts` ~L948). Every session >24h after the first, and every session scheduled >24h ahead, gets an unjoinable room.
- B4 `live_room_update_metadata` replaces the whole column; `createSession` passes only Daily keys (`room-session-manager.ts` ~L192) → price/description lost.
- B5 Rooms are public (no `privacy`), no meeting tokens (`createMeetingToken` unused); host and viewers identical; paid/`group` access never enforced; `/daily` host check is a TODO (`live.ts` ~L941).
- B6 The viewer never calls a join endpoint → `live_room_attendance` empty, `community_live_streams.viewer_count` always 0, no presence counter.
- B7 Host pressing Daily's Leave ends the room for everyone (`LiveRoomViewer.tsx` ~L202-216); the only exit inside the room is in the iframe; no app-level exit, no safe-area.
- B8 Lifecycle: Go Live never sets `ends_at` (auto-end never fires); a scheduled room drops out of both Live and Scheduled at its start time (`useLiveStreams.ts` `scheduled_for >= now`); `checkAutoTransitions` flips the listing to LIVE even when the host-only RPC failed (`room-session-manager.ts` ~L526-556); `stream_type` always `'audio'` (`live.ts` ~L1694).
- B9 Notifications: `live-repository.ts` reads `community_live_streams.tenant_id` (no such column), `live_rooms.user_id` (it is `host_user_id`), `live_room_attendees` (table does not exist) → go-live / joined / ended notifications never send; deep links `/live/:id` have no route.
- B10 Creation: the Events "+" offers only Event / MeetUp; virtual events store the literal `'Virtual Event'` in `virtual_link` (CreateEventPopup L257, CreateMeetupPopup L217, EditMeetupPopup L356) → a broken "Join" link; Go Live offers "Followers only", rejected by the gateway validation + DB check (400).
- B11 Event join counter: realtime UPDATE handler overwrites the computed `participant_count` with the stale column (`useCommunityEvents.ts` ~L350); card count seeded once (`useEventParticipation.ts` L28); drawer shows invented attendees ("User 1…", Unsplash, 3 fake followers, `MeetupDetailsDrawer.tsx` ~L670-679, L1049-1084) and "x / 30" when unlimited (L654); drawer join is insert not upsert (L495); drawer never opens on the Following tab (`EventsAndMeetups.tsx` L462-464).
- B12 Live rooms never appear in the Events catalog.
- i18n: hardcoded English in `LiveRoomViewer.tsx` (L218, L271, L325-333), `GoLivePopup.tsx` (L52, L247, L357, L438), `LiveRooms.tsx` (L144, L283, L953), `MeetupDetailsDrawer.tsx` (L569-570), gateway notification texts in `live.ts`.

## Decisions for the owner (recommendation first)
- D-1 Keep Daily.co (rebuild around it, do not switch providers): the integration exists, LiveKit is ORB-only and not provisioned for rooms.
- D-2 Rooms become private Daily rooms; entry only through a gateway `enter` call that checks access and issues a meeting token (owner token for the host, participant token for viewers). Existing public URLs stop being the way in.
- D-3 A Live Room is listed in the Events catalog as its own card type (from `community_live_streams`), not by copying it into `global_community_events` — one source of truth per thing. "Followers only" is removed from Go Live (never worked); access stays Public / Paid.
- D-4 The "+" on Events gets a third option "Live Room" that opens the existing Go Live popup (instant or scheduled).

## Work items
### Prerequisite (owner, outside code)
The Daily.co API key must be present on the AWS gateway task definitions (staging and production) as `DAILY_API_KEY`. I cannot read or place it (no AWS access from the session; secrets are the owner's). LR-A1's health flag and deploy check make its absence visible; if it is absent, Live Rooms cannot work whatever the code does, and I raise it to the owner as a blocker.

### LR-A1 Gateway: Daily rooms that can be joined (vitana-platform, VTID 1)
1. Rate limits keyed per authenticated user: `optionalAuth` (`middleware/auth-supabase-jwt.ts`, verifies the JWT) runs before the limiter; `keyGenerator` = verified `req.identity` user id, else the first `X-Forwarded-For` hop, else `req.ip` — a forged token never gets its own bucket. Applied to `dailyRoomLimiter`, `purchaseLimiter`, `sessionCreateLimiter`; `/daily` limit raised to 30 / 15 min per user (viewers call it). No global `trust proxy` change.
2. `DailyClient`: `ensureRoom(roomId, {expiresAt})` — create with `privacy: 'private'`, or on "exists" update (`POST /rooms/:name`) `exp` + `privacy`. `exp` = `ends_at` if set, else `starts_at + (metadata.duration_minutes ?? 60) min`, plus 2h; never earlier than now+4h. `createMeetingToken(roomName, {userId, userName, isOwner, exp})` used.
4a. `/rooms/:id/daily`: host check from the verified JWT (resolves the TODO); non-hosts get 403 — viewers enter only through `enter` (LR-A2), so no token-less URL is handed out; the host response refreshes `exp` via `ensureRoom`.
4b. `/api/v1/live/health` adds `daily_configured: boolean` (presence of the key only). Stage + prod deploy workflows: a read-only post-deploy step reports whether `DAILY_API_KEY` is in the live task definition (warning annotation, not a failure — the secret is an owner prerequisite).
5a. Metadata merge: `createSession` and `/daily` read the current metadata and send the merged object (no SQL change).
6a. Tests (jest): per-user limiter key incl. forged-token fallback; `ensureRoom` create / exists→update exp+privacy; exp fallbacks; token owner vs participant; `/daily` 403 for non-host; health flag; metadata merge.

### LR-A2 Gateway: enter/exit, lifecycle, notifications (vitana-platform, VTID 2)
3. New `POST /api/v1/live/rooms/:id/enter` (`requireAuth`): loads room + current session (`live_rooms.current_session_id`); refuses if no live/lobby session (409 `NOT_LIVE`, host is allowed for scheduled → starts it, see 6); access: public → ok; `group` with price → requires an access grant (existing `live_room_access_grants` check RPC) else 402; calls `ensureRoom`, records attendance via `live_room_join_session` (existing, unused RPC), returns `{daily_room_url, token, is_host, counts}`. `POST /rooms/:id/exit` records the leave for THIS session: service-role update of `live_room_attendance` set `left_at = now()` where `live_room_id`, `session_id = current_session_id`, `user_id`, `left_at IS NULL` (the legacy `live_room_leave` RPC matches room+user only and is not used). Both update `community_live_streams.viewer_count` from the attendance count (service role).
6. Lifecycle: `/sessions` sets `ends_at = starts_at + duration_minutes` (default 60) via the existing payload field; `stream_type` validated as `z.enum(['audio','video'])` in the session schema's metadata and written to the listing; `checkAutoTransitions` PATCHes the listing only when the RPC succeeded — for BOTH the scheduled→lobby/live and the live→ended transitions; host `enter` on a scheduled/lobby session transitions it to live (existing host-only RPCs).
7. `live-repository.ts`: `community_live_streams` tenant via join on `live_rooms.tenant_id`; `live_rooms.host_user_id`; `live_room_attendance` instead of `live_room_attendees`; notification URLs → `/comm/live-rooms/<id>/view`; notification texts through `tt()` catalog keys.
9. Tests (jest): `enter` access matrix (public, paid without/with grant, not live, host starts scheduled); exit scoped to the current session; transitions guarded both ways; stream_type enum; repository column names. A `test/routes` harness for the new routes with mocked RPC/Daily.
10. Known residual (documented, follow-up VTID): `community_live_streams` has no `tenant_id`, its SELECT policy is not tenant-scoped — tenant isolation of the listing needs a migration and is out of scope here.

### LR-B Frontend: enter and run the room (vitana-v1, VTID 3)
1. `liveRoomService.enter/exit`; `LiveRoomViewer` uses `enter` (url + token), passes `token` to `DailyVideoRoom` (`join({url, token})`), calls `exit` on leave / unmount / `pagehide`.
2. Host controls: "Leave" (keep the room running, host-absent) vs "End for everyone" (confirm dialog → existing `/end`); viewers' Leave only leaves.
3. App-level header over the iframe with a ≥44px exit button, safe-area top/bottom padding, `h-[100dvh]` minus header so Daily's tray stays on screen; error/black-iframe state always has the exit.
4. Live viewer count in the room header and on cards (from `viewer_count`, refreshed by the existing listing realtime/poll).
5. `useLiveStreams`: Scheduled shows `pending` rooms with `scheduled_for >= now - 2h` ("starting soon" when past due); Join enabled for the host on due rooms (enter starts it).
6. Remove the browser-side force-reset writes to `live_room_sessions`/`live_rooms` in `GoLivePopup`/`LiveRoomViewer` — `live_room_sessions` has only `sessions_select_tenant` and `sessions_service_role` policies (migration 20260210100000 L85-93), so the browser update is a silent no-op today; use the gateway `/cancel` only and surface its error.
7. i18n for all strings listed above (DE first, then en/es/sr/ar); RTL-safe classes.
8. Tests (vitest): viewer calls enter and passes token; host leave vs end; exit always rendered (loading/error); scheduled-due listing.

### LR-C Create, list and count (vitana-v1, VTID 4)
1. `CreateSelectionDialog`: third option "Live Room" → `GoLivePopup` (instant/scheduled). "Followers only" removed from Go Live.
2. Events catalog: `useLiveStreams` data (live + scheduled) merged into the Events page as live-room cards — Hot: live-now first; Today/Upcoming: scheduled by `scheduled_for`; card opens `/comm/live-rooms/<id>/view` (live) or the existing `LiveRoomDrawer` (scheduled).
3. `virtual_link`: create/edit no longer write `'Virtual Event'`; the drawer renders the join link only for an http(s) URL (existing rows with the literal are ignored, no data migration).
4. Event join counter: realtime UPDATE keeps the computed `participant_count`; `useEventParticipation` re-seeds when `initialCount` changes; drawer join uses upsert; no client-side `participant_count` column writes for non-creators (they were silent no-ops) — counts always come from participant rows; drawer: remove fake attendees/followers, show real count and capacity only when `max_participants` is set; drawer opens on the Following tab.
5. What's New entry (`src/whats-new/entries/live-rooms-in-events.json`, DE du-form + EN, deep link `/comm/events-meetups`): Live Rooms can be started from Events and appear in the catalog.
6. Screen registry: no new route (`/comm/live-rooms/:roomId/view` and `/comm/live-rooms` are already in `screens.json`).
7. Tests (vitest) for each item above.

## Verification / release
Per VTID: unit tests, lint (i18n rules), typecheck, build; `docs/validation/<VTID>/staging-tests.json` + `plan-sparring.md`. Staging is read-only: a Playwright spec opens `/comm/events-meetups` and `/comm/live-rooms` as the test user and asserts the Live Room option, the catalog live cards and the room page's exit button render; the gateway suite asserts `/api/v1/live/health` → `daily_configured: true` and `POST /rooms/<uuid>/enter` without auth → 401 (no writes). Entering a real room writes attendance → not done on staging/production by me; the owner (or a designated member) does the first real live session after deploy, and I give the exact checklist. Production only on the owner's "yes", pinned commits, commit range shown.

## Out of scope
New provider, recording/replay, in-room app chat/polls, paid-room price UI in Go Live, tenant isolation of `community_live_streams` (needs a migration — follow-up), SECURITY DEFINER count RPCs, meetup reminders.

## Change class
standard (gateway routes, deploy workflows (read-only check step), frontend; no migration). Four VTIDs: LR-A1, LR-A2, LR-B, LR-C; released in that order (A1 alone already unblocks joining when the key is present).

## Scope
vitana-platform: `services/gateway/src/routes/live.ts`, `routes/live-repository.ts`, `services/daily-client.ts`, `services/room-session-manager.ts`, i18n catalog for notification keys, `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` + `AWS-PROD-DEPLOY-GATEWAY.yml` (check step only), tests. vitana-v1: `src/services/liveRoomService.ts`, `src/pages/community/LiveRoomViewer.tsx`, `src/components/liverooms/DailyVideoRoom.tsx`, `src/components/GoLivePopup.tsx`, `src/pages/community/LiveRooms.tsx`, `src/hooks/useLiveStreams.ts`, `src/components/CreateSelectionDialog.tsx`, `src/pages/community/EventsAndMeetups.tsx`, `src/components/CreateEventPopup.tsx`, `CreateMeetupPopup.tsx`, `EditMeetupPopup.tsx`, `MeetupDetailsDrawer.tsx`, `src/hooks/useCommunityEvents.ts`, `useEventParticipation.ts`, i18n shards, tests, `docs/validation/`.
<!-- plan:end -->

## Planner responses (round 1)
- F1 ACCEPTED — exit is scoped to the current session by a service-role update on `live_room_attendance` (room, session, user, `left_at IS NULL`); `live_room_leave` is not used.
- F2 ACCEPTED as documented residual — notifications fixed via the `live_rooms.tenant_id` join; tenant isolation of `community_live_streams` listed as a known residual with a follow-up VTID (needs a migration).
- F3 ACCEPTED — both transition directions guarded by the RPC result.
- F4 ACCEPTED — the Daily key is now an explicit owner prerequisite section; the deploy workflows only report its presence (I do not create or move secrets).
- F5 ACCEPTED — the limiter key uses the identity verified by `optionalAuth`; unverified tokens fall back to the forwarded IP.
- F6 ACCEPTED — `stream_type` enum in the session schema.
- F7 REJECTED — `live_room_sessions` has no UPDATE policy for authenticated users, only `sessions_select_tenant` and the service-role policy (migration 20260210100000 L85-93), so the host's browser update is already a silent no-op; removing it changes no behaviour, and the gateway `/cancel` error is now surfaced.
- F8 ACCEPTED — the gateway work is split into LR-A1 (rooms joinable) and LR-A2 (enter/exit, lifecycle, notifications); four VTIDs total.
- F9 ACCEPTED — What's New entry in LR-C.
- F10 ACCEPTED (verified) — both routes are already in `screens.json` (L1326, L1353); no new route is added.
- Q1 — yes, `live_rooms.current_session_id`.
- Q2 — `ends_at` else `starts_at + (duration_minutes ?? 60)`, plus 2h, minimum now+4h.
- Q3 — `/daily` returns 403 to non-hosts; viewers only get in through `enter`, which issues a token.

## Sparring rounds

Round 1 — the partner's findings (summary) and the planner's answers:

| # | Finding (summary) | Answer |
|---|---|---|
| F1 | `exit` via the legacy `live_room_leave` RPC matches room + user only, so it could close attendance of another session | ACCEPTED — exit is a service-role update on `live_room_attendance` scoped to room, current session, user and `left_at IS NULL`; `live_room_leave` is not used |
| F2 | Notification tenant lookup reads a non-existent `community_live_streams.tenant_id`; the listing itself is not tenant-scoped | ACCEPTED as documented residual — notifications use the `live_rooms.tenant_id` join; tenant isolation of `community_live_streams` needs a migration (follow-up VTID) |
| F3 | `checkAutoTransitions` updates the listing even when the host-only RPC failed; only one direction was guarded | ACCEPTED — both transition directions (scheduled→lobby/live and live→ended) are guarded by the RPC result |
| F4 | `DAILY_API_KEY` is not wired on the AWS task definitions; code cannot fix that | ACCEPTED — explicit owner prerequisite section; the deploy workflows only report presence (no secret is created or moved) |
| F5 | A per-user limiter keyed on an unverified token lets a forged token mint its own bucket | ACCEPTED — the key uses the identity verified by `optionalAuth`; unverified tokens fall back to the forwarded IP |
| F6 | `stream_type` was hardcoded / unvalidated | ACCEPTED — `stream_type` enum (`audio`/`video`) in the session schema |
| F7 | Removing the browser-side force-reset writes changes behaviour | REJECTED — `live_room_sessions` has no UPDATE policy for authenticated users (only `sessions_select_tenant` and the service-role policy, migration 20260210100000 L85-93), so the browser update is already a silent no-op; the gateway `/cancel` error is now surfaced |
| F8 | Gateway work too large for one VTID | ACCEPTED — split into LR-A1 (rooms joinable) and LR-A2 (enter/exit, lifecycle, notifications); four VTIDs total |
| F9 | Member-visible feature without a What's New entry | ACCEPTED — What's New entry in LR-C |
| F10 | Routes used by the plan may be missing from the screen registry | ACCEPTED (verified) — both routes are already in `screens.json` (L1326, L1353); no new route |

Questions answered: Q1 `live_rooms.current_session_id`; Q2 `ends_at` else `starts_at + (duration_minutes ?? 60)`, plus 2 h, minimum now + 4 h; Q3 `/daily` returns 403 to non-hosts, viewers only get in through `enter`, which issues a token.

Round 2 — the partner re-checked every answer against the code: CONVERGED, no open finding.

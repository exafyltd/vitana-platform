# Tasks — live-room-edit-cohost

Code starts only after each lane has its CI-allocated VTID. Every lane writes its tests first and records them red on
`origin/main` in `docs/validation/<VTID>/red-on-base.txt`.

<!-- lane: db-cohost-authz -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Write `scripts/ci/sql-tests/run-live-room-cohost-test.sh` and `SQL-LIVE-ROOM-COHOST.yml` (throwaway Postgres,
      same pattern as `SQL-LIVE-ROOM-CALENDAR.yml`). Record the run red on base (the functions do not exist).
- [ ] T2 Migration `supabase/migrations/20261105170000_live_room_cohost_authz.sql`: `live_room_is_host`,
      `live_room_filter_co_hosts` (EXECUTE for `service_role` only), the `co_hosts` trigger, and the 13 host gates
      (`transition_status`, `end_session`, `set_host_present`, `get_lobby`, `admit_user`, `reject_user`, `admit_all`,
      `kick_user`, `ban_user`, `join_session`, `get_state`, `check_access`, `update_metadata`). Copy each latest body from
      the migration files named in the plan, restate defaults and grants, change only the host comparison. `kick` and
      `ban` refuse a host target. Add a rollback note in the header.
- [ ] T3 `DATABASE_SCHEMA.md` changelog row.
- [ ] T4 Save the SQL test output to `docs/validation/<VTID>/commands.log`; `staging-tests.json` with one read-only
      `/alive` probe and the note "migration not applied: not verified on staging".
- [ ] T5 PR titled `VTID-xxxxx (live-room-edit-cohost/db-cohost-authz): …`.

Acceptance:
- Change types: Database.
- **Outcome** — a member the creator lists as co-host is treated as a host by every moderation step of that room; an
  unlisted member, a member of another tenant and a test or service account are not; nobody can remove the creator or
  another host with kick or ban; a browser session cannot write `co_hosts`.
- **States** — a room with no `co_hosts` (null or empty), a listing row missing for the room id, a co-host who left the
  tenant: all behave as "not host" without an error.
- **Surfaces** — callers: the gateway live routes and the Daily token path (lane `gateway-cohost`).
- **Contract** — signatures and grants of the two new functions; every redefined function keeps its argument list,
  return type, defaults, `SECURITY DEFINER`, `search_path` and grants (compare with the previous definition, `file:line`).
- **Staging proof** — not verified on staging: applying the migration is an owner stop (§7d). Covered by the throwaway
  Postgres test for every redefined function (creator, co-host, stranger).
- Diff only inside the lane `paths`.

<!-- lane: gateway-cohost -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first (`services/gateway/test/live-room-cohost*.test.ts`), red on base (see plan, Tests).
- [ ] T2 `services/gateway/src/services/live-cohosts.ts`: `filterCoHosts` (RPC `live_room_filter_co_hosts` with the
      service role, `503 CO_HOST_VALIDATION_UNAVAILABLE` when the function is missing), `isRoomHost`, session edit
      orchestration.
- [ ] T3 `routes/live.ts`: `enter` and `/daily` use `isRoomHost`; `CreateSessionSchema` gets `co_hosts`; the create
      upsert writes `co_hosts`, `enable_chat`, `enable_polls`, `enable_recording`; new `PATCH /rooms/:id/sessions/current`;
      `open-lobby` and `cancel` get `requireAuth` and use `identity.user_id`, the body `user_id` is no longer read.
      `room-session-manager.ts`: the gate in `transition()` (`:277`) uses `isRoomHost`. `cancelSession` (`:378`) stays
      creator-only. Grep the gateway for any other `host_user_id` comparison before finishing; each one is either
      changed here or listed in the lane log as creator-only on purpose.
- [ ] T4 `npx jest` on the changed tests and the four existing live suites, `npm run typecheck`, `npm run build`; save
      to `docs/validation/<VTID>/commands.log`.
- [ ] T5 `staging-tests.json`: `/alive` 200 and `PATCH /api/v1/live/rooms/00000000-0000-0000-0000-000000000000/sessions/current`
      without a token, `expect_status` 401. Read-only.
- [ ] T6 PR titled `VTID-xxxxx (live-room-edit-cohost/gateway-cohost): …`.

Acceptance:
- Change types: Backend, Integration.
- **Outcome** — a co-host who opens a scheduled live room starts it, gets the moderator view and token and can run it
  (open the lobby, admit, end); a creator can change every field of a scheduled session after creating it and the Live
  Rooms list shows the new values at once.
- **States** — a request whose body names another user as the actor (the JWT identity decides); no token (401 on
  `open-lobby` and `cancel`); helper missing or RPC failing (not host, creator unaffected); session `live` (locked fields refused with
  the field list); session has access grants (access change refused); start time in the past; listing write fails
  (502, retry converges); more than 5 or invalid co-hosts (400 with the ids).
- **Surfaces** — callers: `GoLivePopup` (create), `EditSessionDialog` (edit), `LiveRoomViewer` (`enter`), the ORB tools
  that call `/sessions` (`live-rooms-tools.ts`, unchanged contract).
- **Contract** — request and reply shapes, status codes and auth gate of `PATCH .../sessions/current`, `POST .../sessions`,
  `POST .../enter`, `POST .../open-lobby` and `POST .../cancel` with `file:line` on the gateway and on the
  `liveRoomService` side (`openLobby` sends no body, `cancelRoom` sends `user_id`); JSON error bodies.
- **Staging proof** — the unauthenticated probe returns 401 on the deployed route (proves it is mounted and guarded).
  Behaviour for a real co-host is not verified on staging (needs a live write); the Jest suites cover it.
- Diff only inside the lane `paths`; no Stripe or refund code touched.

<!-- lane: v1-session-form -->
Repo `exafyltd/vitana-v1`.
- [ ] T1 Tests first: `CoHostPicker`, `SessionFormFields`, `GoLivePopup` sends `co_hosts`; red on base.
- [ ] T2 `CoHostPicker.tsx` over `useMentionCandidates` (no new dependency, no new RPC), `SessionFormFields.tsx` (mode
      `create | edit`), `GoLivePopup.tsx` uses it, `liveRoomService.createSession` / `updateSession` typed with
      `co_hosts`.
- [ ] T3 i18n: new keys in `src/i18n/de/liveRooms.json` first, then `en`, then the other nine shards (`_pending_review`
      where not translated by a human); du-form; logical properties only; `npm run i18n:inventory` and commit
      `docs/SCREEN_INVENTORY.md`.
- [ ] T4 `npm test`, `npm run lint`, `npm run build`; the existing `GoLivePopup.*` tests unchanged and green.
- [ ] T5 Playwright screenshots at 1400×900 and 390×844 (and `ar`) of Go Live with Advanced options open, the drop-down
      open, two chips chosen; view them.
- [ ] T6 Read-only staging spec `tests/e2e/staging/vtid-xxxxx-live-room-cohost-picker.staging.spec.ts`;
      `npx playwright test --list` before push; `staging-tests.json` pointing at it.
- [ ] T7 PR titled `VTID-xxxxx (live-room-edit-cohost/v1-session-form): …`.

Acceptance:
- Change types: UI, Integration.
- **Outcome** — in Go Live the co-host field is a search box: typing shows existing community members (name and
  picture), choosing one adds a chip, up to five, and the chosen members are saved with the live room.
- **States** — nothing typed; searching; no match ("no members found"); search failed (same message, no fabricated
  list); five already chosen (field disabled with a hint); long names truncate; member already chosen is not offered.
- **Surfaces** — Go Live dialog on desktop and phone (it is one dialog, `useIsMobile` not involved), all
  `GoLivePopup` entry points.
- **Locales** — de first (du-form), en, all shards present; ar (RTL) screenshot, no `left`/`right`.
- **Accessibility** — combobox role with `aria-expanded`, `aria-activedescendant`, arrow keys and Enter select,
  Escape closes, each chip's remove button has an accessible name, visible focus, 24 px targets.
- **Contract** — `POST .../sessions` body `co_hosts: uuid[]` and the 400 `INVALID_CO_HOSTS` reply shown as a toast with
  catalog text (`file:line` both sides).
- **Staging proof** — the spec asserts the drop-down lists members after typing; creating a room is not done on staging
  (live write), covered by the Vitest `GoLivePopup` test.
- Diff only inside the lane `paths`; no browser write to `live_rooms`, `live_room_sessions` or `community_live_streams`.

<!-- lane: v1-edit-session -->
Repo `exafyltd/vitana-v1`.
- [ ] T1 Tests first: `EditSessionDialog` (prefill of every field, changed-fields payload, locked fields, error
      mapping), co-host visibility on the card and drawer, viewer host controls; red on base.
- [ ] T2 `EditSessionDialog.tsx` renders `SessionFormFields mode="edit"`; saves through `liveRoomService.updateSession`
      (cover upload stays a `covers` storage upload from the browser, the URL goes in the PATCH); `useUpdateStream` no
      longer used by the dialog.
- [ ] T3 `LiveRoom` gains `coHosts`, `accessLevel`, `enableChat`, `enablePolls`, `enableRecording`; `LiveRooms.tsx`
      maps them. "Can run" = creator or co-host drives Start / Manage in `LiveRoomCard`, `LiveRoomDrawer`,
      `LiveRoomEventCard`, `MobileLiveRoomCarousel`, `EventsLiveRooms`; edit and delete stay creator only.
      `LiveRoomViewer` host controls follow `entry.is_host`, and the pre-enter screen includes co-host membership.
- [ ] T4 i18n keys (de first, then en, then the other shards), `npm run i18n:inventory`, `docs/SCREEN_INVENTORY.md`;
      if NATIVE-CI requires it, the parity ledger exception for `/comm/live-rooms` (`apps/mobile/parity/ledger.json`).
- [ ] T5 `npm test`, `npm run lint`, `npm run build`; Playwright screenshots (1400×900, 390×844, ar) of the Edit dialog
      for a scheduled session and for a live one (locked fields), viewed.
- [ ] T6 `staging-tests.json`: the existing community-app smoke ref plus "not verified on staging: an edit and a
      co-host run need a live write"; PR titled `VTID-xxxxx (live-room-edit-cohost/v1-edit-session): …`.

Acceptance:
- Change types: UI, Integration.
- **Outcome** — Edit Session shows the same fields as Go Live, filled with what was entered, and Save changes all of
  them; the list and the card show the new values straight away. A co-host sees Start now / Manage on the room card,
  enters as a moderator and can end the live, but sees no edit or delete menu.
- **States** — scheduled vs live (locked fields disabled with a reason); saving; save failed (gateway message mapped to
  a catalog toast, dialog stays open with the input kept); session already ended; no permission (not creator); cover
  removed; co-host removed.
- **Surfaces** — Live Rooms list rows and cards (desktop and `MobileLiveRoomCarousel`), the drawer, the events
  live-rooms strip, the viewer page; phone and desktop both checked.
- **Locales** — de first, en, all shards; ar (RTL) screenshot; dates through the `fmt*` helpers.
- **Accessibility** — same combobox and focus rules as the picker; disabled fields explain why in text, not colour only.
- **Contract** — `PATCH .../sessions/current` payload only contains changed keys; error codes `SESSION_LOCKED`,
  `HAS_ACCESS_GRANTS`, `NOT_HOST`, `INVALID_CO_HOSTS` each have a catalog message (`file:line` both sides).
- **Staging proof** — not verified on staging: needs a live write (vitana-v1 CLAUDE.md absolute rule). Covered by the
  Vitest suites; the smoke suite proves the Live Rooms page still renders for the test account.
- Diff only inside the lane `paths`.

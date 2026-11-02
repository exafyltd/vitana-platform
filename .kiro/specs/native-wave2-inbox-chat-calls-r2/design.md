# Design — Native Wave 2: Inbox / Chat / Calls screen ports (native-wave2-inbox-chat-calls-r2)

How the two lanes port the `inbox-chat-calls` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. Nothing here changes the program plan or the design contract.

## 1. Where native screens live and how they resolve

Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found. Porting a
screen means **adding its own Expo Router file under `apps/mobile/app/`** whose route path equals the web path, so the
resolver no longer catches it, the push `data.url` / universal link / ORB directive resolve the same, and the parity
row can go `native` (`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`).

Route-file plan (Expo Router, paths = web paths):

| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) / ledger key |
|---|---|---|
| `inbox-list` | `(app)/inbox/index.tsx`, `(app)/inbox/archived.tsx`, `(app)/inbox/inspiration.tsx` | `/inbox` (`INBOX.OVERVIEW`), `/inbox/archived` (`INBOX.ARCHIVED`), `/inbox/inspiration` (`INBOX.INSPIRATION`) |
| `conversation-chat` | `(app)/inbox/u/[recipientId]/index.tsx`, `(app)/inbox/u/[recipientId]/msg/[messageId].tsx`, `(app)/inbox/g/[groupId]/index.tsx`, `(app)/inbox/g/[groupId]/msg/[messageId].tsx`, `(app)/inbox/t/[threadId]/index.tsx`, `(app)/inbox/t/[threadId]/msg/[messageId].tsx` | `/inbox/u/:recipient_id` (`INBOX.CONVERSATION`), `/inbox/u/:recipientId/msg/:messageId`, `/inbox/g/:chat_group_id` (`INBOX.GROUP`), `/inbox/g/:groupId/msg/:messageId`, `/inbox/t/:threadId`, `/inbox/t/:threadId/msg/:messageId` |

Notes on route shape:
- The web `:recipient_id` / `:chat_group_id` ledger `web_path` and the `:recipientId` / `:groupId` exclusion rows both
  reduce to the same `shapeOf()` segment type (one dynamic segment), so the native file `[recipientId]` satisfies the
  ledger match. `parity-ledger.mjs` matches by exact `shapeOf()` (query dropped), **not** prefix — so each `/msg/`
  deep-link is a distinct row needing its own route file, not "covered under the parent". The six rows therefore map
  to six native route files; if the files exist but the rows stay `not_started`, `--check` passes silently (the
  exclusion rows are seen by check (d) via `shapeOf`, check (c) only fires on `native`/`in_progress`) while the ledger
  reports the lane permanently incomplete. The lane acceptance REQUIRES flipping all 6 rows to `native`.
- `/inbox/t/:threadId` is the **thread form** of a conversation: web routes it to the same `<Messages />` screen
  (`src/App.tsx:1370-1374`), which resolves the thread id to a conversation and strips the deep-link segment back to
  `/inbox` once resolved (`src/App.tsx:571-572`). The native `t/[threadId]` route renders the same conversation screen
  with a thread-id resolver; it is a separate ledger row (own file) but the same screen component.
- The `/msg/:messageId` deep-links open the conversation/group screen and scroll-to + highlight the target message
  (web reaction/scroll deep-links, `src/App.tsx:1376-1389,1398-1401`). The native `msg/[messageId].tsx` route renders
  the same screen component passing `scrollToMessageId`.

## 2. Screen source: the N2/N3 structure, not the web DOM

Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:
- Imports go through ports only: `@vitana/core/*` (pure helpers, types, query keys where class A), `@vitana/ui` (UI
  kit), `@vitana/tokens` (visual values), `src/ports/*` from the shell (`core`, `ui`, `links`, `badges`,
  `soundscape`, `orb-slot`). No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`, shadcn
  `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll → `FlatList`/`ScrollView`, long-press context menu →
  the kit's menu.

### 2a. Inbox-list lane specifics
Mobile web inbox (`src/pages/Messages.tsx`, ≤1024 branch) is a **single-pane list** — the conversation list
(`MobileConversationCard` twin), empty state (`MobileInboxEmptyState` twin), loading skeleton
(`MobileConversationSkeleton` twin), the unread badges (from a re-implemented `useChatUnreadCount`), and the header
with the new-conversation entry (`NewConversationPopup` twin → a bottom sheet) and create-group entry
(`CreateGroupPopup` twin). Tapping a conversation navigates to the conversation route (owned by the other lane via a
`src/ports/links` navigation call, not a direct import — the two lanes share the shell's link port, not each other's
screens). `/inbox/archived` (`Archived.tsx` twin) and `/inbox/inspiration` (`Inspiration.tsx` twin) are two further
list screens. **Member-listing exclusion (R5.5)**: the new-conversation / create-group member search reuses the web
search query (re-implemented against the native gateway client hitting the same excluding endpoint); no new
member-listing query is added.

### 2b. Conversation-chat lane specifics (the hard part — realtime + calls)
`ConversationView.tsx` (1307) is the 1:1 DM thread; `GroupChat.tsx` (629) is the group chat. Both render an
**inverted `FlatList`** of message bubbles (`MessageBubble` twin, 1439-line web source — reactions, mentions, image
attachment, event link, reply quote, vitana-card), a `MessageInput` twin (689 — mentions, enter/newline, attachment
menu), the typing indicator (`TypingIndicator` twin, `useTypingIndicators` re-implemented), presence
(`PresenceIndicator` twin), reaction cluster/popover, reply preview/quote, swipeable message (→ native gesture),
system/divider messages, the attachment menu (→ the kit's bottom sheet + `expo-image-picker`), the image viewer
(`ChatImageViewer` → `expo-image` + zoom), forward-message sheet, and the conversation error boundary
(`ConversationErrorBoundary` twin). The message stream, send, reactions, unread marking and realtime subscription
come from a **native re-implementation of `useMessages` / `useChatApi` / `useRealtimeRelayStream` /
`useChatMessagesRealtimeRelay`** against the native Supabase/gateway client (these are class-B — they runtime-import
`@/integrations/supabase/client.ts` — so they are NOT moved into core; see §4 Core purity). The group screen adds the
group header (`GroupAvatarStack`), the group members modal (`GroupMembersModal`, member-search excluded per R5.5), and
calendar-invite cards.

**Calls (1:1 WebRTC), embedded — no route of its own.** Web mounts `CallProvider` + `CallManager` inside
`Messages.tsx:1227-1569`; `useWebRTC.ts` (312) does the signalling, `useCallState.ts` (338) the state machine,
`CallingScreen` / `IncomingCallModal` / `MessengerCall` the UI. The native port mounts a `CallProvider` twin at the
inbox/conversation root and re-implements `useWebRTC`/`useCallState` natively (`react-native-webrtc` or the Expo
config-plugin equivalent per the program library map §3), with the incoming-call modal and in-call screen as native
twins. **These are written and unit-tested against mocked signalling; the live call journey is deferred to G1
(R5.3)** — a real call needs two sessions, device media permissions and ICE connectivity, none of which exist
offline.

## 3. Disjointness (no overlap, no orphan)

- **Ledger rows:** the 9 `inbox-chat-calls` rows partition cleanly — `inbox-list` **3** (`INBOX.OVERVIEW`,
  `INBOX.ARCHIVED`, `INBOX.INSPIRATION`), `conversation-chat` **6** (`INBOX.CONVERSATION`, `INBOX.GROUP`, and the four
  `/msg/` + `/t/` exclusion routes). 3 + 6 = 9. Each row named explicitly in the lane file.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/` and `apps/mobile/src/screens/`:
  `inbox-list` owns `app/(app)/inbox/{index,archived,inspiration}.tsx` + `src/screens/inbox/`; `conversation-chat`
  owns `app/(app)/inbox/{u,g,t}/**` + `src/screens/chat/` (conversation, group, message bubble/input twins, call
  twins). No file is in two lanes. (The shared `app/(app)/inbox/` **folder** is split by file, not by folder: the
  list lane owns the three leaf files directly under it, the chat lane owns the `u`/`g`/`t` subfolders — no file
  collision.)
- **Tests:** each lane owns `apps/mobile/src/screens/<its folder>/__tests__/**`, `apps/mobile/tests/inbox-chat/**`
  (split by lane subpath), `apps/mobile/maestro/inbox-chat/**` (split by lane subpath) and its
  `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/src/**` closure (each lane adds only the pure re-exports it needs, if
  any), `apps/mobile/src/ports/**` and `apps/mobile/src/navigation/resolve.ts` (shared native infra — touched
  additively), and the DE-first i18n shards (`src/i18n/*/inboxNative.json` for the list lane,
  `src/i18n/*/chatNative.json` + `src/i18n/*/callsNative.json` for the chat lane — distinct files, no key collision).
  These are listed in each lane's `paths`.

## 4. Core purity (stated per the prompt's CORE PURITY RULE)

**Never move a data-fetching hook or any module that runtime-imports `@/integrations/supabase/client.ts` (class B:
vite env / localStorage / prod URL) into `@vitana/core` — `core-closure --check` rejects it (`core-closure.mjs`,
`m.own !== 'A'`).** Verified class-B for this cluster: `useMessages.ts`, `useChatApi.ts`, `useTypingIndicators.ts`,
`useChatUnreadCount.ts`, `useRealtimeRelayStream.ts`, `useCallState.ts`, `useWebRTC.ts` all runtime-import the
supabase client. These are **re-implemented natively** against the native Supabase/gateway client + native auth
context, never re-exported through core. Only genuinely pure IO-free helpers (a message-grouping / date-divider
helper, a markdown/escape helper, a call-state pure reducer if cleanly separable) may go into `@vitana/core` via a
manifest re-export; type-only imports need no core entry (the native tsconfig `@/*` alias resolves them at compile
time). A lane that adds a core re-export MUST run `node scripts/native/core-closure.mjs --write` and commit the
regenerated `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` **in the same
PR**, then `--check` passes — otherwise NATIVE-CI fails with "stale generated file". If a lane extracts no pure
module, it adds no core files and runs no `--write`.

## 5. Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)

1. **Two disjoint lanes, not three.** The ledger has exactly 9 rows and no separate call/room row; the natural cut is
   **`inbox-list`** (the three list surfaces, 3 rows) and **`conversation-chat`** (DM + group + the four deep-link/
   thread exclusion routes + the embedded 1:1 calling, 6 rows). The two touch disjoint route files and component
   folders, build and review independently, and each leaves the app buildable. A separate `calls` lane was rejected:
   calling has no ledger row of its own, it is mounted inside the conversation surface (`Messages.tsx:1227-1569`), and
   splitting it out would force both lanes to touch the same `CallProvider`/conversation files — breaking
   disjointness. Calls therefore ride with `conversation-chat`.
2. **The chat/call data layer is re-implemented natively, not moved into `@vitana/core`** (R1.4, §4 Core purity):
   every chat and call hook is class B (runtime-imports the supabase client), so core extraction would fail the
   closure gate. Only pure IO-free helpers are candidates for a core re-export, and only with `--write` + committed
   generated files in the same PR.
3. **The two lanes communicate only through the shell's `src/ports/links` navigation port**, never by importing each
   other's screens — the list lane navigates to the conversation route by path, the conversation screen is owned
   solely by `conversation-chat`. So the lanes' `paths` stay disjoint and either can land first (**no `depends_on`**
   between them — unlike the home batch, there is no shared component twin owned across lanes here).
4. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`).
5. **Device-runtime verification deferred to G1 (owner gate), and this is load-bearing for realtime + calls** (R5.3).
   Presence, typing, the live message stream, unread realtime and the full WebRTC call cannot be exercised offline;
   the lanes land with that code written and unit-tested against **mocked** realtime/signalling, and the live journeys
   are a `next_actor: owner` task in the lane and `staging-tests.json`. Matches the program's "fixture / fake-gateway
   tests only until G1" model.
6. **Mobile-web parity, not desktop.** Mobile web inbox is single-pane (list OR conversation); the native inbox is
   two navigable screens (list → conversation), mirroring the `useIsMobile()` ≤1024 branch of `Messages.tsx` /
   `ConversationView.tsx`. Every visual value from `@vitana/tokens`; the four N2-documented web defects are not
   reproduced and no web file is touched beyond a DE-first i18n key and a `@vitana/core` re-export for a pure helper.
7. **Never write to a live system from chat/calls** (R5.1). This is called out as a decision, not just a rule, because
   the cluster is the highest-risk one in Wave 2: a single test message insert fans out to real members
   (`trg_notify_community_post` precedent), and a real call is outward-facing. All tests use fixtures / a fake gateway;
   the staging spec reads an existing conversation only, never sends or calls.

## 6. Test design (per lane)

- **Unit (jest-expo + RNTL, fake gateway / fixtures, no network):**
  - `inbox-list`: conversation list loaded / empty / error / skeleton; unread badge count from fixture; new-conversation
    sheet opens; create-group member search renders (member-listing exclusion inherited from the reused query —
    asserted by a fixture that includes a bot/test actor and checking it is absent); archived + inspiration list
    loaded/empty.
  - `conversation-chat`: message list loaded / empty / error; each `MessageBubble` variant (text, image attachment,
    mention, event link, reply quote, reaction cluster, system/divider) renders; send input (enter vs newline,
    mentions); typing indicator shows from a **mocked** typing event; message deep-link (`/msg/:messageId`) scrolls to
    + highlights the target; thread route (`/t/:threadId`) resolves to the conversation; group header + members modal
    (member-listing exclusion); **call state machine** (`useCallState` native reducer) transitions (idle → outgoing →
    connected → ended; incoming → accept/decline) driven by **mocked** signalling — no real WebRTC; incoming-call
    modal + in-call screen render per state.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end and own-vs-other bubble alignment flips.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Core (only if a pure helper is extracted):** `node scripts/native/core-closure.mjs --write` run and generated
  files committed, `--check` green.
- **Parity:** `node scripts/native/parity-ledger.mjs --check` from the repo root (rows `native`, routes present).
- **Deferred (G1, `next_actor: owner`):** Maestro `maestro/inbox-chat/<lane>/*.yaml`, iOS simulator + Android emulator
  screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen (reads an
  existing conversation, never sends), and — for the chat lane — the **live realtime + WebRTC call journey** (presence,
  typing, live stream, a real 1:1 call across two sessions). Listed in `docs/validation/<VTID>/staging-tests.json`
  (sign in, navigate, read; network guard aborts every non-GET except sign-in; never `vitanaland.com`).

## 7. Open items for the owner / sparring

- G1 isolated test environment (program gate) — required before any device-runtime parity check, and specifically
  before the realtime + WebRTC call journey can be verified; the deferred tasks stay `next_actor: owner` until it
  exists. Two devices / sessions + media permissions are needed for a real call.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Native WebRTC library choice (`react-native-webrtc` vs an Expo config-plugin equivalent) per program library map §3
  — default `react-native-webrtc`; confirmable at build time, does not affect the plan's scope.
- Whether the thread-form route `/inbox/t/:threadId` should render the conversation screen inline or redirect after
  resolving the thread id (web strips the segment back to `/inbox`); default: render the conversation screen with a
  thread-id resolver, matching the web screen component.

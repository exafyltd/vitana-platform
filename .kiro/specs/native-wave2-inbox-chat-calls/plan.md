# Plan — native-wave2-inbox-chat-calls
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process only if a pure helper is extracted, `apps/mobile/parity/ledger.json`, DE-first i18n
shards, `docs/validation/**`; no backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`,
`tasks.md`, `lanes/*.md` in this folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5
Wave 2.
<!-- plan:begin -->
## Cross-repo sparring
This plan's implementation lives in `exafyltd/vitana-v1` (native app `apps/mobile/**`, `packages/core/**`, the parity
ledger, i18n shards), while the plan PR itself is in `exafyltd/vitana-platform`. Every load-bearing premise the
sparring partner must verify — `CallProvider`/`CallManager` mounted inside `Messages.tsx`, the chat/call hooks'
class-A/class-B classification, the 9 parity-ledger rows and `src/App.tsx` routes — is a vitana-v1 file, read through
the `spar_refs` (`exafyltd/vitana-v1: main`) declared in `handoff.md`.

## Sparring status
Rounds 1–2 ran blind: `spar_refs` is applied only at `client.create`, never at `client.round`
(`scripts/collab/plan-spar.mjs:333`), so the in-progress round-1 session could never acquire vitana-v1 read access
(`responses-2.md`, findings R1-F1 / R2-F1). A fresh session is required so the partner can verify the frontend
premises; this plan-text change sets up the `replan` path (a changed plan on an escalated, non-infra session creates a
new session with `spar_refs` applied). The permanent pipeline fix (forwarding `extra_refs` from `client.round`) is
flagged for the owner/operator and is out of scope for this screen-port plan PR.
## Goal
Wave 2 screen-port batch of the native Maxina app: port the **inbox / chat / calls** cluster — the 9 web destinations
the parity ledger assigns to `"lane": "inbox-chat-calls"` — to the native app (`apps/mobile/`) at 1:1 parity with
today's **mobile web** screens (the `useIsMobile()` ≤ 1024 branch), built on `@vitana/core` + `@vitana/tokens` + the
N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with fixture / fake-gateway unit tests. Covers the inbox list
(`/inbox`, `/inbox/archived`, `/inbox/inspiration`), the 1:1 DM thread (`/inbox/u/:recipient_id`), the group chat
(`/inbox/g/:chat_group_id`), their four message/thread deep-link routes, and the **embedded 1:1 WebRTC calling**
(mounted inside the conversation surface — no ledger row of its own). Does **not** need G1 planned or built to land
the ports; every device-runtime verification step — and specifically the realtime (presence / typing / live message
stream) and the live WebRTC call — is marked depends-on-owner (G1). No redesign (program §4), no new web screen, no
`App.tsx` route, no registry/manifest change — only native route files and parity-row status flips.

## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json`)
- **9 rows carry `"lane": "inbox-chat-calls"`, all `status: "not_started"`** — **5 `screen` (`source: registry`)** +
  **4 `route` (`source: exclusion`)**. Counted with `node -e` over the committed ledger JSON filtering
  `lane === "inbox-chat-calls"` (NOT from prose — the home batch had a double-count bug). The exact rows:
  1. `INBOX.OVERVIEW` → `/inbox` (screen)
  2. `INBOX.ARCHIVED` → `/inbox/archived` (screen)
  3. `INBOX.INSPIRATION` → `/inbox/inspiration` (screen)
  4. `INBOX.CONVERSATION` → `/inbox/u/:recipient_id` (screen, 1:1 DM)
  5. `INBOX.GROUP` → `/inbox/g/:chat_group_id` (screen, group chat)
  6. `/inbox/u/:recipientId/msg/:messageId` (exclusion route, DM reaction/scroll deep-link)
  7. `/inbox/g/:groupId/msg/:messageId` (exclusion route, group reaction/scroll deep-link)
  8. `/inbox/t/:threadId` (exclusion route, thread form of a conversation)
  9. `/inbox/t/:threadId/msg/:messageId` (exclusion route, thread deep-link to a message)
- **There is no separate call/room ledger row in this lane.** Live Rooms (Daily.co) rows — `COMM.LIVE_ROOMS`,
  `COMM.LIVE_ROOMS_{ALL,LIVE,PAST,SCHEDULED}`, `COMM.LIVE_ROOM_VIEWER` — are in the `events-calendar` lane (verified
  by `node -e` over the ledger). The 1:1 WebRTC calling is a **feature embedded in the inbox/conversation surface**
  (`CallProvider` + `CallManager` mounted inside `src/pages/Messages.tsx:52-53,1227-1569`), not a route of its own, so
  it ports with the conversation lane and flips no extra row.
- Web sources verified present with line counts: `src/pages/Messages.tsx` (1571), `src/pages/messages/GroupChat.tsx`
  (629), `src/pages/messages/Archived.tsx` (262), `src/pages/messages/Inspiration.tsx` (270),
  `src/components/messages/ConversationView.tsx` (1307), `src/components/messages/MessageBubble.tsx` (1439),
  `src/components/messages/MessageInput.tsx` (689); calling `src/components/CallManager.tsx` (125),
  `src/components/MessengerCall.tsx` (244), `src/components/CallingScreen.tsx` (~55),
  `src/components/IncomingCallModal.tsx` (~65), `src/context/CallContext.tsx` (40), `src/hooks/useWebRTC.ts` (312),
  `src/hooks/useCallState.ts` (338). Routes at `src/App.tsx:1352-1410`. (Line counts are an **approximate** snapshot
  for scoping — not load-bearing. The ONE load-bearing check — that every chat/call data hook is class B — is
  confirmed: `useMessages.ts`, `useChatApi.ts`, `useTypingIndicators.ts`, `useChatUnreadCount.ts`,
  `useRealtimeRelayStream.ts`, `useCallState.ts`, `useWebRTC.ts` all runtime-import
  `@/integrations/supabase/client.ts`, so none can enter `@vitana/core`.)
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging
  hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Two disjoint lanes, by cluster** — **`inbox-list`** (the three list surfaces, **3 rows**) and
   **`conversation-chat`** (DM + group + the four deep-link/thread exclusion routes + the embedded 1:1 calling,
   **6 rows**). 3 + 6 = 9, 0 overlap, 0 orphan, counted against the ledger itself. The two touch disjoint route files
   and component folders, build/review independently, each leaves the app buildable. A separate `calls` lane was
   rejected: calling has no ledger row of its own and is mounted inside the conversation surface
   (`Messages.tsx:1227-1569`); splitting it out would force both lanes to touch the same `CallProvider`/conversation
   files. Calls therefore ride with `conversation-chat`.
2. **The chat/call data layer is re-implemented natively, NOT moved into `@vitana/core`** (CORE PURITY RULE): every
   chat and call hook is class B (runtime-imports `@/integrations/supabase/client.ts`), so a core re-export would fail
   `core-closure --check` (`m.own !== 'A'`). The native screens re-implement `useMessages` / `useChatApi` /
   `useRealtimeRelayStream` / `useTypingIndicators` / `useChatUnreadCount` / `useWebRTC` / `useCallState` against the
   native Supabase/gateway client + native auth context. Only a genuinely pure IO-free helper (message grouping /
   date divider / markdown, a pure call-state reducer if cleanly separable) is a core candidate — and only with
   `node scripts/native/core-closure.mjs --write` run and `packages/core/closure.generated.json` +
   `scripts/native/mobile-ci-paths.generated.json` committed in the SAME lane PR. If a lane extracts no pure module,
   it adds no core files and runs no `--write`. Type-only imports need no core entry (native tsconfig `@/*` alias).
3. **The two lanes communicate only through the shell's `src/ports/links` navigation port**, never by importing each
   other's screens — so their `paths` stay disjoint and there is **no `depends_on`** between them (unlike the home
   batch, no shared component twin is owned across lanes here). Either lane can land first; they run in parallel.
4. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips. The four exclusion routes each get their own
   native route file and their own status flip (ledger matches by exact `shapeOf`, not prefix —
   `parity-ledger.mjs:60`), so the lane acceptance REQUIRES flipping all 6 conversation rows (and all 3 inbox rows) to
   `native`, not just the two screen rows.
5. **Device-runtime verification deferred to G1 (owner gate) — load-bearing for realtime + calls.** Presence, typing,
   the live incremental message stream, unread realtime, and the full 1:1 WebRTC call (media permissions,
   ICE/signalling, a real call across two sessions) **cannot be exercised offline with fixtures**; the lanes land with
   that code written and unit-tested against **mocked** realtime/signalling, and the live journeys are a
   `next_actor: owner` task in the lane and `staging-tests.json`. Matches the program's "fixture / fake-gateway tests
   only until G1" model.
6. **Mobile-web parity, not desktop.** Mobile web inbox is single-pane (list OR conversation); the native inbox is two
   navigable screens (list → conversation), mirroring the `useIsMobile()` ≤ 1024 branch of `Messages.tsx` /
   `ConversationView.tsx`. Every visual value from `@vitana/tokens`; the four N2-documented web defects are not
   reproduced and no web file is touched beyond a DE-first i18n key and a `@vitana/core` re-export for a pure helper.
7. **Never write to a live system from chat/calls.** This is the highest-risk Wave 2 cluster: a single test message
   insert fans out to real members (the `trg_notify_community_post` precedent), and a real call is outward-facing. All
   tests use fixtures / a fake gateway; the staging spec reads an existing conversation only — it never sends a message
   or opens a call. Member-listing surfaces (new-conversation / create-group / group-members) exclude
   `service_bot_accounts` + `notification_test_actors` by reusing the web query (program NEVER 45).

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `inbox-list` | exafyltd → hotmail | `INBOX.OVERVIEW /inbox`, `INBOX.ARCHIVED /inbox/archived`, `INBOX.INSPIRATION /inbox/inspiration` (**3 rows**) | — |
| `conversation-chat` | exafyltd → hotmail | `INBOX.CONVERSATION /inbox/u/:recipient_id`, `INBOX.GROUP /inbox/g/:chat_group_id`, `/inbox/u/:recipientId/msg/:messageId`, `/inbox/g/:groupId/msg/:messageId`, `/inbox/t/:threadId`, `/inbox/t/:threadId/msg/:messageId`, **and the embedded 1:1 WebRTC calling** (**6 rows**) | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 9 parity rows partition **3 (inbox-list) + 6
(conversation-chat)** with 0 overlap and 0 orphan (counted against the ledger). The four `/msg/` + `/t/` deep-links
are dedicated exclusion rows the `conversation-chat` lane flips to `native` (exact `shapeOf` match, not prefix). Both
lanes run in parallel (no `depends_on`).

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (inbox-list: list loaded/empty/error/skeleton, unread badge, new-conversation sheet, create-group member-search
  exclusion, archived + inspiration; conversation-chat: message list loaded/empty/error, every `MessageBubble`
  variant, send input enter/newline + mentions, typing indicator from a mocked event, `/msg/` deep-link scroll +
  highlight, `/t/` thread resolve, group header + members-modal exclusion, **call state machine** idle→outgoing→
  connected→ended and incoming→accept/decline driven by mocked signalling), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction (only if a pure helper is extracted): run `--write` AND commit the generated files, not just
  `--check`.** A PR that adds a `feed-compose`-style pure helper re-export to `packages/core/src/` MUST also run
  `node scripts/native/core-closure.mjs --write` and commit the regenerated `packages/core/closure.generated.json` +
  `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then `--check` passes. Without `--write`+commit,
  `--check` fails in NATIVE-CI with "stale generated file". No chat/call data hook is ever a core candidate (all class
  B).
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; RTL (`ar`)
  rendered per screen, with own-vs-other bubble alignment flipping.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/inbox-chat/<lane>/*.yaml`, iOS simulator +
  Android emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen
  (reads an existing conversation, never sends), and — for `conversation-chat` — the **live realtime + WebRTC call
  journey** (presence, typing, live stream, a real 1:1 call across two sessions, media permissions). Listed in
  `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.

## Compliance (encoded in requirements.md / design.md)
- **Member-listing exclusion (NEVER rule 45):** the new-conversation picker (`NewConversationPopup`), create-group
  search (`CreateGroupPopup.tsx:51`), and group-members modal (`GroupMembersModal.tsx:161`) exclude
  `service_bot_accounts` + `notification_test_actors` — inherited by reusing the web search query, not re-implemented.
- **Never write to production (absolute rule):** chat/calls never send, post, open a real call, or write
  presence/typing to a live system; tests are fixture / fake-gateway only; staging specs are read-only.
- **Device-runtime for realtime/calls deferred to G1:** explicitly, because none of presence, typing, the live
  stream, or a WebRTC call can be proven offline.

## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check, and specifically
  before the realtime + WebRTC call journey; the deferred tasks stay `next_actor: owner` until it exists. Two devices
  / sessions + media permissions are needed for a real call.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Native WebRTC library choice (`react-native-webrtc` vs an Expo config-plugin equivalent, program library map §3) —
  default `react-native-webrtc`.
- Whether `/inbox/t/:threadId` renders the conversation inline or redirects after resolving the thread id (web strips
  the segment back to `/inbox`); default: render the conversation screen with a thread-id resolver.
<!-- plan:end -->

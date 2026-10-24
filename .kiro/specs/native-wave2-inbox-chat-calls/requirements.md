# Requirements — Native Wave 2: Inbox / Chat / Calls screen ports (native-wave2-inbox-chat-calls)

Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021, §5 Wave 2). Port the inbox, chat (1:1 DM and
group) and the embedded 1:1 calling cluster that the parity ledger assigns to the `inbox-chat-calls` lane to the
native app (`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` +
`@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime
verification on a device needs the isolated test environment G1 and is called out per task as `depends-on-owner`.
**Realtime (presence / typing / live message stream) and calls (WebRTC 1:1) cannot be proven offline — their
device-runtime verification is deferred to G1 explicitly (R5.3).**

Measured on the worktree (= `origin/main`), parity ledger `apps/mobile/parity/ledger.json` (`node -e` over the
committed ledger JSON, filtering `lane === "inbox-chat-calls"`): **9 rows carry `"lane": "inbox-chat-calls"`, every
one `status: "not_started"`** — **5 `screen` (`source: registry`)** and **4 `route` (`source: exclusion`)**. The two
lanes below partition those 9 rows with **disjoint `paths`**. There is **no separate `call`/`room` ledger row in
this lane**: Live Rooms (Daily.co) rows (`COMM.LIVE_ROOMS*`, `COMM.LIVE_ROOM_VIEWER`) are in the `events-calendar`
lane, not here; the 1:1 WebRTC calling is a **feature embedded in the inbox/conversation surface** (`CallProvider` +
`CallManager` mounted inside `src/pages/Messages.tsx:52-53,1227-1569`), not a route of its own, so it ports with the
conversation lane and flips no extra row.

The 9 rows (exact `key` → `web_path`, from the committed ledger):

| # | key | web_path | kind | source | lane |
|---|---|---|---|---|---|
| 1 | `INBOX.OVERVIEW` | `/inbox` | screen | registry | inbox-list |
| 2 | `INBOX.ARCHIVED` | `/inbox/archived` | screen | registry | inbox-list |
| 3 | `INBOX.INSPIRATION` | `/inbox/inspiration` | screen | registry | inbox-list |
| 4 | `INBOX.CONVERSATION` | `/inbox/u/:recipient_id` | screen | registry | conversation-chat |
| 5 | `INBOX.GROUP` | `/inbox/g/:chat_group_id` | screen | registry | conversation-chat |
| 6 | `/inbox/u/:recipientId/msg/:messageId` | `/inbox/u/:recipientId/msg/:messageId` | route | exclusion | conversation-chat |
| 7 | `/inbox/g/:groupId/msg/:messageId` | `/inbox/g/:groupId/msg/:messageId` | route | exclusion | conversation-chat |
| 8 | `/inbox/t/:threadId` | `/inbox/t/:threadId` | route | exclusion | conversation-chat |
| 9 | `/inbox/t/:threadId/msg/:messageId` | `/inbox/t/:threadId/msg/:messageId` | route | exclusion | conversation-chat |

Count check against the ledger itself (not prose): 3 (`inbox-list`) + 6 (`conversation-chat`) = **9**, with 0 overlap
and 0 orphan. (The home batch had a double-count bug; this count is `node -e` over the committed ledger.)

Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), and the Spotlight /
design rules via tokens. No new web screen, no `App.tsx` route, no `screens.json` / `exclusions.json` entry is added
by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity row — only
status flips on existing rows.

## R0 — Scope and the two lanes

0.1 The plan ports exactly the 9 web destinations the parity ledger lists under `"lane": "inbox-chat-calls"`, split
into two disjoint lanes by cluster. No row is in two lanes; no row in scope is left without a lane.

0.2 Lane **`inbox-list`** — the inbox list surfaces (3 ledger rows, all `not_started`):
`INBOX.OVERVIEW /inbox`, `INBOX.ARCHIVED /inbox/archived`, `INBOX.INSPIRATION /inbox/inspiration`. Web source
`src/pages/Messages.tsx` (1571 lines; the list/left-pane + routing shell; routes `src/App.tsx:1352-1410`) and the
sub-pages `src/pages/messages/Archived.tsx` (262 lines) and `src/pages/messages/Inspiration.tsx` (270 lines). Mobile
list cards from `src/components/messages/mobile/` (`MobileConversationCard.tsx` 110 lines,
`MobileConversationSkeleton.tsx` ~40, `MobileInboxEmptyState.tsx` ~70) and the Spotlight list in
`src/components/messages/spotlight/MessagesSpotlight.tsx`. The unread-count badge/sync
(`src/hooks/useChatUnreadCount.ts`, `useUnreadSync.ts`) is surfaced here.

0.3 Lane **`conversation-chat`** — the 1:1 DM thread, the group chat, their message deep-links, and the embedded 1:1
WebRTC calling (6 ledger rows, all `not_started`):
`INBOX.CONVERSATION /inbox/u/:recipient_id` (1:1 DM, web `src/pages/Messages.tsx` conversation pane +
`src/components/messages/ConversationView.tsx` 1307 lines; routes `src/App.tsx:1365-1389`), `INBOX.GROUP
/inbox/g/:chat_group_id` (group chat, web `src/pages/messages/GroupChat.tsx` 629 lines; routes
`src/App.tsx:1393-1401`), and the four exclusion routes — `/inbox/u/:recipientId/msg/:messageId` (DM reaction/scroll
deep-link), `/inbox/g/:groupId/msg/:messageId` (group reaction/scroll deep-link), `/inbox/t/:threadId` (thread-form
of a conversation — same `<Messages />` screen, `src/App.tsx:1370-1374`) and `/inbox/t/:threadId/msg/:messageId`
(thread deep-link to a message). The 1:1 calling UI — `CallManager.tsx` (125), `CallingScreen.tsx` (~55),
`IncomingCallModal.tsx` (~65), `MessengerCall.tsx` (244), `CallContext.tsx` (40), hooks `useCallState.ts` (338),
`useWebRTC.ts` (312) — mounts inside the conversation surface and ports here.

## R1 — 1:1 parity with the mobile web screen

1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`; `Messages.tsx` and `ConversationView.tsx` each read `useIsMobile()`) of its web source —
same layout, same sections, same navigation, same wording. No redesign, no added or removed section, no reordering
(program §4 "Allowed native improvements only": platform transitions, gestures, keyboard avoidance, safe areas,
haptics, system sheets — nothing else). Mobile web inbox is a **single-pane** experience (list OR conversation, not
the desktop split), so the native inbox is two navigable screens (list → conversation), matching the ≤1024 branch.

1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web
component, no raw colour, every visual value from `@vitana/tokens`. Message bubbles, reactions, typing indicator,
attachment menu, reply/quote, swipeable message, system/divider messages are native twins composed from the kit.

1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet, list/scroll →
`FlatList` with inverted message list, long-press context menu → the kit's menu, the documented
`Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four web defects the N2 README lists are **not**
reproduced and no web file is touched beyond a DE-first i18n key.

1.4 Business logic, query keys, hooks, types are reused from `@vitana/core` **only where the module is pure and
IO-free (class A)**. The chat/call data layer is **not** class A: every chat and call hook runtime-imports
`@/integrations/supabase/client.ts` (a class-B module — `import.meta.env` / `localStorage` / the prod Supabase URL):
confirmed for `useMessages.ts`, `useChatApi.ts`, `useTypingIndicators.ts`, `useChatUnreadCount.ts`,
`useRealtimeRelayStream.ts`, `useCallState.ts`, `useWebRTC.ts`. Those hooks are therefore **re-implemented natively**
against the native Supabase/gateway client + native auth context — never moved into core (`core-closure --check`
would reject them, `m.own !== 'A'`). Only genuinely pure IO-free helpers (e.g. a message-grouping / date-divider or
markdown helper, if any is extracted) go into `@vitana/core` via a manifest re-export + `core-closure.mjs --write` in
the same lane PR. Type-only imports need **no** core entry — the native tsconfig `@/*` → `../../src/*` alias resolves
them at compile time. `@vitana/core` is the only web→native bridge; ESLint bans `@/` and relative paths into the web
`src/` from app code.

## R2 — i18n (11 locales) + RTL

2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n"). The web inbox uses the `inbox.*` and `screens.messages.*` key namespaces (e.g.
`inbox.newConversation.*`, `screens.messages.*`).

2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/<screen>.json`) then mirrored to the other ten; DE is du-form.

2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). Message bubble alignment (own vs other) must be RTL-aware. A test
scans the lane's files for physical `left`/`right`.

2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it; a lane that can reuse an existing key does so and adds none.

## R3 — React 19 / native typing

3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.

## R4 — Parity ledger

4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived
fields), and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in
`apps/mobile/app/`, and no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). The four
exclusion routes match by exact `shapeOf()` (query dropped), not prefix — each needs its own native route file and
its own row flip.

4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The two lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.

## R5 — Verification and safety (never production)

5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the
production Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever"). **Chat and
calls must never write to a live system** — no test sends a message, posts to a group, opens a real call, or writes
presence/typing to the production gateway/Supabase. Tests are **fixture / fake-gateway unit tests only** (CLAUDE.md
absolute rule: a chat message insert fans out to real members; a call is outward-facing).

5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network — realtime subscriptions, the message stream and the WebRTC signalling are
mocked), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and Android), and
`APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` from the repo root. No live call is made.

5.3 **Runtime parity verification is a `depends-on-owner (G1)` step, and this is doubly true for realtime and calls.**
Presence, typing indicators, the live incremental message stream, unread-count realtime, and the full 1:1 WebRTC call
(permission prompts, ICE/signalling, media) **cannot be exercised offline with fixtures** — they need the isolated
test environment G1 (and macOS minutes / G3 for iOS on a device, plus two devices / sessions for a real call). Each
such task is marked `next_actor: owner` in `tasks.md`; the lane records G1 as a blocker in its log. It does not block
the build-time port landing: the ports land with the realtime/call code written and unit-tested against mocks, and
the live journeys are run on G1.

5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`. The conversation lane's staging spec reads an existing conversation only — it never
sends a message or opens a call.

5.5 **Member-listing exclusion (program NEVER rule 45).** The inbox's new-conversation picker
(`NewConversationPopup`), the create-group member search (`CreateGroupPopup.tsx:51 searchUsers`) and the group
members modal (`GroupMembersModal.tsx:161 searchUsers`) are **member-listing surfaces**: they must exclude
`service_bot_accounts` and `notification_test_actors`. The native screens reuse the **web search query logic**
(re-implemented against the native gateway client, calling the same gateway endpoint that already applies the
exclusion) — they add no new member-listing query, so the exclusion is inherited, not re-implemented. The lane states
this in its PR.

5.6 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New
rule).

## R6 — Done

6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered.

6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check` and `parity-ledger --check` green;
NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane scope PR-GATE checks green.
If a lane adds a core re-export, `node scripts/native/core-closure.mjs --check` is green with the generated files
committed in the same PR.

6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only
spec) and `plan-sparring.md` (copy of this plan's sparring record).

## Out of scope (named so a lane does not drift into them)

- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `ai`, `discover-commerce`,
  `profile-settings`, `health`, `memory-diary`, etc.) — each is its own plan.
- **Live Rooms (Daily.co) and the room viewer** (`COMM.LIVE_ROOMS*`, `COMM.LIVE_ROOM_VIEWER`) — those rows are in the
  `events-calendar` lane, not this one; this plan links to them by route only. The 1:1 WebRTC calling embedded in the
  conversation **is** in scope (no ledger row of its own — it ports with the conversation screen).
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and a `@vitana/core` re-export line for a pure helper.

---
lane: conversation-chat
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/inbox/u/**
  - apps/mobile/app/(app)/inbox/g/**
  - apps/mobile/app/(app)/inbox/t/**
  - apps/mobile/src/screens/chat/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/inbox-chat/conversation-chat/**
  - apps/mobile/maestro/inbox-chat/conversation-chat/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/chatNative.json
  - src/i18n/*/callsNative.json
  - docs/validation/**
updated: 2026-10-15T19:13Z
vtid:
---
# Conversation / chat + 1:1 calls port — DM, group, deep-links, embedded WebRTC calling
Plan: `.kiro/specs/native-wave2-inbox-chat-calls/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: conversation-chat -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do
not start before `vtid:` is set here. depends_on: none — runs in parallel with `inbox-list`.

**Measured on the worktree (= origin/main):** 6 ledger rows under `"lane": "inbox-chat-calls"` for this lane, all
`not_started` — `INBOX.CONVERSATION /inbox/u/:recipient_id` (1:1 DM), `INBOX.GROUP /inbox/g/:chat_group_id` (group
chat), and the four exclusion routes `/inbox/u/:recipientId/msg/:messageId`, `/inbox/g/:groupId/msg/:messageId`,
`/inbox/t/:threadId`, `/inbox/t/:threadId/msg/:messageId`. Web sources `src/components/messages/ConversationView.tsx`
(1307; routes `src/App.tsx:1365-1389`), `src/pages/messages/GroupChat.tsx` (629; routes `src/App.tsx:1393-1401`),
message twins `MessageBubble.tsx` (1439) / `MessageInput.tsx` (689) / reactions / typing / attachments / image viewer;
embedded calling `src/components/CallManager.tsx` (125), `MessengerCall.tsx` (244), `CallingScreen.tsx` (~55),
`IncomingCallModal.tsx` (~65), `src/context/CallContext.tsx` (40), `src/hooks/useWebRTC.ts` (312),
`src/hooks/useCallState.ts` (338). **This lane owns the embedded 1:1 WebRTC calling** — no ledger row of its own; it
is mounted inside the conversation surface (`src/pages/Messages.tsx:1227-1569`) and ports here.

**Goal.** Port the 1:1 DM thread, the group chat, their four message/thread deep-link routes, and the embedded 1:1
WebRTC calling to native on the N3 shell at 1:1 mobile-web parity: an inverted `FlatList` of `MessageBubble` twins
(text / image / mention / event-link / reply-quote / reaction / system / divider), a `MessageInput` twin
(enter/newline, mentions, attachment menu), typing indicator, presence, swipeable-message gesture, forward sheet,
`ChatImageViewer` twin, conversation error boundary; the group header + members modal (member-search excluded, R5.5)
+ calendar-invite cards; the `/msg/` deep-links scroll-to + highlight a target message and the `/t/` thread routes
resolve to the conversation; and the native `CallProvider` + incoming-call modal + in-call screen with
`useWebRTC`/`useCallState` re-implemented natively. The chat/call data layer is re-implemented natively (all class B —
NOT core, CORE PURITY RULE). Flips the 6 parity rows to `native`.

**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the DM / group / deep-link / thread surfaces and the embedded calling; mobile-web parity;
  `@vitana/core`-only for pure helpers (the chat/call data layer re-implemented natively, never in core);
  member-listing exclusion (group-members modal) inherited by reusing the web query.
- `npm run typecheck`, `npm test` (message list loaded/empty/error; every `MessageBubble` variant; send input
  enter/newline + mentions; typing indicator from a mocked event; `/msg/` deep-link scroll + highlight; `/t/` thread
  resolve; group header + members-modal exclusion; **call state machine** idle→outgoing→connected→ended and
  incoming→accept/decline driven by mocked signalling; incoming-call modal + in-call screen render per state),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- If a pure helper is extracted to core: `node scripts/native/core-closure.mjs --check` green with the generated files
  committed in the same PR; otherwise no core files touched. `node scripts/native/parity-ledger.mjs --check` green
  with all 6 rows `native` and their route files present in `apps/mobile/app/` (each `/msg/` + `/t/` route is its own
  file — exact `shapeOf` match, not prefix).
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered with
  own-vs-other bubble alignment flipping; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity + the live realtime/call journey (task 7)** — Maestro + sim/emulator screenshots + parity
  vs 390×844 staging (read-only, reads an existing conversation, never sends) AND live presence / typing / message
  stream + a real 1:1 WebRTC call across two sessions — is deferred to G1 as `next_actor: owner`; not a merge blocker
  for the port, recorded in this log and `staging-tests.json`.

**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 6 rows), `packages/core/manifest.json` +
closure + `src/**` (only this lane's re-exports, if any pure helper — never a chat/call data hook),
`apps/mobile/src/ports/**` + `apps/mobile/src/navigation/resolve.ts` (shared native infra — touched additively) and
the DE-first `src/i18n/*/chatNative.json` + `src/i18n/*/callsNative.json` shards are shared by row/line with
`inbox-list`; resolve a merge conflict by keeping both lanes' rows/keys. The `app/(app)/inbox/` folder is split by
file (this lane owns the `u`/`g`/`t` subfolders; `inbox-list` owns the three leaf files) — no file collision.

**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; chat and calls never write to a live system (no sent message, no real call,
no presence/typing write); staging specs are read-only; the native app has no production profile.

## Log
### 2026-10-15T19:13Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 6 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes; no `depends_on` — runs in parallel with `inbox-list`.
Confirmed the embedded 1:1 WebRTC calling has no ledger row of its own (mounted in `Messages.tsx:1227-1569`) and ports
with this lane, and that every chat/call data hook is class B (runtime-imports the supabase client) so none can enter
`@vitana/core`. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-inbox-chat-calls/conversation-chat --session <id>`). Reviewer seat `hotmail`.
Device-runtime parity and the live realtime/call journey (task 7) wait on the owner's G1 isolated test environment
(needs two devices/sessions + media permissions).

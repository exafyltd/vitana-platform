# Tasks — Native Wave 2: Inbox / Chat / Calls screen ports

Two lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow them
exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI after
PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.
**Chat and calls never write to a live system — tests are fixture / fake-gateway only; realtime + WebRTC live
journeys are deferred to G1 (`next_actor: owner`).**

<!-- lane: inbox-list -->
## Lane `inbox-list` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `INBOX.OVERVIEW /inbox`, `INBOX.ARCHIVED /inbox/archived`, `INBOX.INSPIRATION /inbox/inspiration`
(3 ledger rows under `"lane": "inbox-chat-calls"`). depends_on: none. Web sources `src/pages/Messages.tsx`
(1571 lines, list/left-pane + shell), `src/pages/messages/Archived.tsx` (262), `src/pages/messages/Inspiration.tsx`
(270); mobile list cards `src/components/messages/mobile/*`, Spotlight list
`src/components/messages/spotlight/MessagesSpotlight.tsx`.

- [ ] 1. Native inbox list screen on the N3 shell: `apps/mobile/app/(app)/inbox/index.tsx` +
  `apps/mobile/src/screens/inbox/InboxScreen.tsx` renders the conversation list (twin of
  `src/components/messages/mobile/MobileConversationCard.tsx`) in a `FlatList`, with the empty state
  (`MobileInboxEmptyState` twin), loading skeleton (`MobileConversationSkeleton` twin) and unread badges. The inbox
  list fetch + unread count are **re-implemented natively** (native gateway/Supabase client) — `useChatUnreadCount` /
  `useUnreadSync` are class B, NOT moved into core (design §4). Mobile-web branch of `Messages.tsx` only.
  Files: `apps/mobile/app/(app)/inbox/index.tsx`, `apps/mobile/src/screens/inbox/**`.
  Verify: `npm test` (list loaded/empty/error/skeleton; unread badge) + `npm run typecheck` green.
- [ ] 2. New-conversation + create-group entries: the new-conversation picker (twin of `NewConversationPopup`) and
  create-group sheet (twin of `src/components/messages/CreateGroupPopup.tsx`) as the kit's bottom sheets, opened from
  the inbox header. **Member-listing exclusion (R5.5 / program NEVER 45):** reuse the web member-search query
  (re-implemented against the native gateway client hitting the same excluding endpoint) — add NO new member-listing
  query; `service_bot_accounts` + `notification_test_actors` are excluded by inheritance. State this in the PR.
  Files: `apps/mobile/src/screens/inbox/**`.
  Verify: `npm test` (sheet opens; member-search fixture containing a bot/test actor renders it absent) +
  `npm run typecheck` green.
- [ ] 3. Archived + Inspiration list screens: `apps/mobile/app/(app)/inbox/archived.tsx` +
  `apps/mobile/src/screens/inbox/ArchivedScreen.tsx` (twin of `Archived.tsx`) and
  `apps/mobile/app/(app)/inbox/inspiration.tsx` + `apps/mobile/src/screens/inbox/InspirationScreen.tsx` (twin of
  `Inspiration.tsx`). Tapping a conversation navigates to the conversation route via `src/ports/links` (owned by the
  `conversation-chat` lane; navigate by path, do NOT import that lane's screen).
  Files: `apps/mobile/app/(app)/inbox/archived.tsx`, `apps/mobile/app/(app)/inbox/inspiration.tsx`,
  `apps/mobile/src/screens/inbox/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. i18n + RTL: user-visible strings from the web shards (`inbox.*`, `screens.messages.*`); any genuinely new key
  added to `src/i18n/de/inboxNative.json` first, then the other ten (ar de en es fr pl pt ru sr tr zh); render under
  `ar` with start/end only; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/inboxNative.json` (DE first), `apps/mobile/src/screens/inbox/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures, no network): inbox list loaded / empty / error / skeleton; unread badge
  count; new-conversation sheet opens; create-group member search excludes bot/test actors; archived + inspiration
  loaded/empty. React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/src/screens/inbox/__tests__/**`, `apps/mobile/app/(app)/inbox/__tests__/**`,
  `apps/mobile/tests/inbox-chat/inbox-list/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's 3 parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native` for `INBOX.OVERVIEW`, `INBOX.ARCHIVED`, `INBOX.INSPIRATION`), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (inbox-list rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/inbox-chat/inbox-list/*.yaml`, iOS simulator + Android emulator screenshots at the device
  sizes, screenshot parity vs the 390×844 **read-only** staging web `/inbox`, `/inbox/archived`, `/inbox/inspiration`.
  Blocked until G1 (and macOS minutes / G3 for iOS on a device). Read-only — never sends a message.
  Files: `apps/mobile/maestro/inbox-chat/inbox-list/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 8. PR: branch `kiro/native-wave2-inbox-chat-calls/inbox-list`, title
  `VTID-xxxxx (native-wave2-inbox-chat-calls/inbox-list): native inbox list port`, body names the Kiro session id,
  Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-inbox-chat-calls/inbox-list`. Lane → `in-review`, `next_actor: kiro` (reviewer seat
  `hotmail`). Never merge, deploy or write to a live system (protocol §7a).

<!-- lane: conversation-chat -->
## Lane `conversation-chat` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (6 ledger rows): `INBOX.CONVERSATION /inbox/u/:recipient_id`, `INBOX.GROUP /inbox/g/:chat_group_id`,
`/inbox/u/:recipientId/msg/:messageId`, `/inbox/g/:groupId/msg/:messageId`, `/inbox/t/:threadId`,
`/inbox/t/:threadId/msg/:messageId`. depends_on: none. Web sources `src/components/messages/ConversationView.tsx`
(1307; routes `src/App.tsx:1365-1389`), `src/pages/messages/GroupChat.tsx` (629; routes `src/App.tsx:1393-1401`),
message twins `MessageBubble.tsx` (1439) / `MessageInput.tsx` (689) / reactions / typing / attachments; calling
`CallManager.tsx` (125) / `MessengerCall.tsx` (244) / `CallingScreen.tsx` / `IncomingCallModal.tsx` /
`CallContext.tsx` (40) / `useWebRTC.ts` (312) / `useCallState.ts` (338). **This lane owns the embedded 1:1 WebRTC
calling (no ledger row of its own — it ports with the conversation screen).**

- [ ] 1. Native chat data layer (re-implemented, NOT core): native twins of `useMessages` / `useChatApi` /
  `useRealtimeRelayStream` / `useChatMessagesRealtimeRelay` / `useTypingIndicators` against the native
  Supabase/gateway client + native auth context. These are class B (runtime-import `@/integrations/supabase/client.ts`)
  so they are NOT moved into `@vitana/core` (design §4). Only a genuinely pure IO-free helper (message grouping /
  date divider / markdown) may be re-exported through core — if so, add the manifest line + re-export in
  `packages/core/src/**`, run `node scripts/native/core-closure.mjs --write` and commit
  `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json` IN THIS PR. If nothing pure
  is extracted, add no core files.
  Files: `apps/mobile/src/screens/chat/**`, and (only if a pure helper is extracted) `packages/core/manifest.json`,
  `packages/core/src/**`, `packages/core/closure.generated.json`, `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes (if core touched); `apps/mobile` →
  `npm run typecheck` green.
- [ ] 2. 1:1 DM conversation screen: `apps/mobile/app/(app)/inbox/u/[recipientId]/index.tsx` +
  `apps/mobile/src/screens/chat/ConversationScreen.tsx` — twin of `ConversationView.tsx` on the N3 shell: inverted
  `FlatList` of `MessageBubble` twins (text, image attachment via `expo-image`, mention, event link, reply quote,
  reaction cluster/popover, system/divider), `MessageInput` twin (enter/newline, mentions, attachment menu →
  `expo-image-picker`), typing indicator (mocked event in tests), presence, swipeable-message gesture, forward-message
  sheet, `ChatImageViewer` twin, conversation error boundary. Back-navigation. Mobile-web branch only.
  Files: `apps/mobile/app/(app)/inbox/u/[recipientId]/index.tsx`, `apps/mobile/src/screens/chat/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Group chat screen: `apps/mobile/app/(app)/inbox/g/[groupId]/index.tsx` +
  `apps/mobile/src/screens/chat/GroupChatScreen.tsx` — twin of `GroupChat.tsx`: same message list + input, plus the
  group header (`GroupAvatarStack` twin), the group members modal (`GroupMembersModal` twin — **member-search excluded
  per R5.5**, reuse the web query, add no new member-listing query) and calendar-invite cards.
  Files: `apps/mobile/app/(app)/inbox/g/[groupId]/index.tsx`, `apps/mobile/src/screens/chat/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. Deep-link + thread routes (4 exclusion rows): `apps/mobile/app/(app)/inbox/u/[recipientId]/msg/[messageId].tsx`
  and `apps/mobile/app/(app)/inbox/g/[groupId]/msg/[messageId].tsx` render the DM/group screen passing
  `scrollToMessageId` (scroll-to + highlight, web `src/App.tsx:1376-1389,1398-1401`);
  `apps/mobile/app/(app)/inbox/t/[threadId]/index.tsx` resolves the thread id to a conversation and renders the
  conversation screen (web `src/App.tsx:1370-1374,571-572`); `apps/mobile/app/(app)/inbox/t/[threadId]/msg/[messageId].tsx`
  does both. Each is its own route file (ledger matches by exact `shapeOf`, not prefix — design §1).
  Files: `apps/mobile/app/(app)/inbox/u/[recipientId]/msg/[messageId].tsx`,
  `apps/mobile/app/(app)/inbox/g/[groupId]/msg/[messageId].tsx`, `apps/mobile/app/(app)/inbox/t/[threadId]/index.tsx`,
  `apps/mobile/app/(app)/inbox/t/[threadId]/msg/[messageId].tsx`, `apps/mobile/src/screens/chat/**`.
  Verify: `npm test` — deep-link resolves to the right screen + scroll target; thread route resolves to the
  conversation; `npm run typecheck` green.
- [ ] 5. Embedded 1:1 WebRTC calling (no route): native `CallProvider` twin mounted at the inbox/conversation root,
  native twins of `CallingScreen` / `IncomingCallModal` / `MessengerCall`, and native re-implementations of
  `useWebRTC` / `useCallState` (class B — NOT core) using `react-native-webrtc` (or the Expo config-plugin equivalent,
  program library map §3). Signalling is **mocked** in unit tests; the live call is deferred to G1 (task 7). Call
  state machine: idle → outgoing → connected → ended; incoming → accept/decline.
  Files: `apps/mobile/src/screens/chat/**` (call components + hooks).
  Verify: `npm test` — call-state transitions driven by a mocked signalling fixture; incoming-call modal + in-call
  screen render per state; `npm run typecheck` green.
- [ ] 6. i18n + RTL: user-visible strings from the web shards; any genuinely new chat key added to
  `src/i18n/de/chatNative.json` first and any call key to `src/i18n/de/callsNative.json` first, then the other ten
  (ar de en es fr pl pt ru sr tr zh); render one chat screen under `ar` and assert start/end plus own-vs-other bubble
  alignment flips; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/chatNative.json`, `src/i18n/*/callsNative.json` (DE first), `apps/mobile/src/screens/chat/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity + the live realtime/call journey:
  Maestro `apps/mobile/maestro/inbox-chat/conversation-chat/*.yaml`, iOS simulator + Android emulator screenshots at
  the device sizes, screenshot parity vs the 390×844 **read-only** staging conversation (reads an existing
  conversation, never sends), AND the **live** presence / typing / incremental message stream and a real 1:1 WebRTC
  call across two sessions. Blocked until G1 (needs two devices/sessions + media permissions; macOS/G3 for iOS).
  Recorded in the lane log + `staging-tests.json`; not run in CI; never writes to production.
  Files: `apps/mobile/maestro/inbox-chat/conversation-chat/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only.
- [ ] 8. Flip the lane's 6 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (conversation-chat rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green with all 6 rows `native` and their route
  files present in `apps/mobile/app/`.
- [ ] 9. PR: branch `kiro/native-wave2-inbox-chat-calls/conversation-chat`, title
  `VTID-xxxxx (native-wave2-inbox-chat-calls/conversation-chat): native DM / group chat + 1:1 calls port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-inbox-chat-calls/conversation-chat`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.

## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge for
  pure helpers only (chat/call data layer re-implemented natively, never in core).
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; if core touched, `node scripts/native/core-closure.mjs --check` green with the
  generated files committed in the same PR.
- 11 locales, DE-first new keys, RTL covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Member-listing surfaces (new-conversation / create-group / group-members) exclude `service_bot_accounts` +
  `notification_test_actors` by reusing the web query (program NEVER 45).
- Chat and calls never write to a live system; all tests are fixture / fake-gateway. Device-runtime parity and the
  live realtime/call journey (chat task 7 / inbox-list task 7) are deferred to G1 as `next_actor: owner`; they are not
  a merge blocker for the port, they are recorded in the lane log and `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).

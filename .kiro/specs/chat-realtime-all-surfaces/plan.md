---
change_class: standard
---
# plan(chat-realtime-all-surfaces): new messages reach every chat surface without delay, and recover after a dropped connection
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611030923-a395`. Code repo: `exafyltd/vitana-v1` (area
`messenger`). The spec lives in vitana-platform because PLAN-SPAR only runs here. This plan replaces the group-only plan
`group-chat-realtime-status` (VTID-05534) for scope. Its group-chat change becomes lane `group-chat`. Line references are
pinned to vitana-v1 `origin/main` `fcc1e451b`. Detail: `tasks.md`; one lane file per lane under `lanes/`.

<!-- plan:begin -->
## Goal
The owner reports that new messages in the Vitana messenger appear late, unlike Telegram, WhatsApp or Slack. The owner
asked for every chat surface, not only group chat. The goal: while the connection is up, a new message from another person
appears in an open conversation within about a second, on every message surface in scope. After a dropped connection the
surface catches up from the server without waiting for a timer. Measurement comes first, so each fix is checked against a
device number.

## Scope
In scope (each has its own lane below):
- direct messages, the global DM stream (`src/hooks/useGlobalMessages.ts`);
- tenant threads, the community-tenant chat (`src/hooks/useTenantMessages.ts`);
- group chats (`src/pages/messages/GroupChat.tsx`);
- the legacy message hook, still used for sending and reading by payment and wallet popups (`src/hooks/useMessages.ts`);
- the thread lists and unread badges (`src/hooks/useChatGroupsAsThreads.ts`, `src/hooks/useChatUnreadCount.ts`);
- typing indicators and reactions (`src/hooks/useTypingIndicators.ts`, `src/hooks/useMessageReactions.ts`).

Out of scope, with the reason:
- AI assistant chats (`HealthCoachChat`, `OperatorChat`, `VitanaChatCard`, the voice ORB). They are request and reply, not
  live message streams. The owner may add them; that would be a re-plan.
- Calendar invite response cards (`src/components/messages/CalendarInviteStatus.tsx`). A single status card per invite.
  Listed as an open question below.
- The gateway SSE relay (`services/gateway/src/routes/realtime-relay.ts`, `chat-messages-poller.ts`). It is feature-flagged
  off and polls every 3 s. Turning it on is a separate decision.
- Database changes. The `chat_messages` publication migration is not changed here. The owner must confirm it is applied.
- Push notifications for a closed app.

## Today (vitana-v1 `origin/main` `fcc1e451b`, read-only)
1. **Only the DM stream handles dropped connections.** `useGlobalMessages.ts:1872` opens the realtime channel, and
   `:2003` tracks `SUBSCRIBED` / `CHANNEL_ERROR` / `CLOSED` / `TIMED_OUT` and backfills after a reconnect. It runs a
   6 s fallback poll only while disconnected (`:2054-2060`) and refetches on tab focus (`:2077`).
2. **Tenant threads have no status handling.** `useTenantMessages.ts:669` (`tenant_messages_realtime`) and `:776`
   (`tenant_threads_realtime`) end in `.subscribe();` with no callback (`:774`, `:791`). A drop goes unnoticed.
3. **Legacy messages have no status handling.** `useMessages.ts:362` (`messages-channel`) and `:397` (`threads-channel`)
   subscribe with no callback (`:394`, `:409`).
4. **Group chat has no status handling on main.** `GroupChat.tsx:267-273` subscribes with no callback. The fallback poll is
   8 s (`:67`, `setInterval` at `:279`).
5. **Thread list and badges.** `useChatGroupsAsThreads.ts:94` polls every 10 s (`POLL_INTERVAL_MS` at `:26`) and subscribes
   at `:107` with no callback (`:113`). `useChatUnreadCount.ts:86` and `:140` subscribe with no callback (`:97`, `:146`);
   a 60 s safety timer runs at `:153`.
6. **Typing and reactions.** `useTypingIndicators.ts:55`, `:81`, `:105` and `useMessageReactions.ts:147` subscribe with no
   status handling. Typing is best effort, so only reactions need a backfill.
7. **Each surface opens its own channel.** The same user can hold about seven realtime channels at once. Channel names are
   unique per surface (`tenant_messages_realtime`, `messages-channel`, `chat_unread_badge_dm_<user>`, and so on).
8. **Unverified: the publication.** Migration `supabase/migrations/20260618110546_chat_messages_realtime_publication.sql`
   adds `chat_messages` to the `supabase_realtime` publication. Whether it is applied to the database the app uses is not
   verified. Production must not be queried to check. The owner must confirm it. Every lane depends on it: without the
   publication no surface gets live INSERT events, and the polls are the only delivery path.
9. **Draft group-chat change.** On `kiro/groupchat-realtime-status` (vitana-v1 PR #1592, head `50a001d85`) the group
   change is ready. It is not merged. Lane `group-chat` re-applies the same change on top of the shared helper, and PR
   #1592 is closed as superseded when that lane opens.

## Change
Shared helper first, then each surface adopts it.

Lane `chat-realtime-helper` (vitana-v1, first):
- New module `src/lib/chat-realtime/subscribeChatChannel.ts`. Interface (fixed here for the other lanes):
  ```ts
  export type ChatChannelEvent = "connected" | "reconnected" | "dropped";
  export function subscribeChatChannel(opts: {
    name: string;                                   // channel name, must be unique per surface
    configure: (ch: RealtimeChannel) => RealtimeChannel; // attaches .on(...) handlers; does not call subscribe
    onEvent: (e: ChatChannelEvent) => void;         // "reconnected" = a SUBSCRIBED after a drop, the caller refetches
  }): () => void;                                    // returns the unsubscribe function
  ```
  It calls `realtimeChannel(name)`, then `configure`, then `.subscribe(status => …)`. `reconnected` fires once after each
  `SUBSCRIBED` that follows `CHANNEL_ERROR`, `CLOSED` or `TIMED_OUT`. The first `SUBSCRIBED` emits `connected` only.
- Latency logs in the helper, behind `localStorage["vitana:chat-latency"] === "1"`, one line per INSERT event with the
  surface name and the delay from `created_at` to receipt. No message content is logged.
- Unit tests for the state machine (`connected`, `dropped`, `reconnected`, the once-per-drop rule, unsubscribe).

Lanes that adopt the helper (each depends on `chat-realtime-helper`, each has its own file set):
- `dm-global`: `useGlobalMessages.ts` moves its channel to the helper. Behaviour is otherwise unchanged. The 6 s poll stays,
  and runs only while the status is not `connected`.
- `tenant-threads`: `useTenantMessages.ts` (both channels). On `reconnected`, refetch the open tenant thread and the thread
  list.
- `group-chat`: `GroupChat.tsx` (the PR #1592 change, re-applied). On `reconnected`, reload the open thread once. The 8 s
  poll stays while disconnected only.
- `legacy-messages`: `useMessages.ts` (both channels). On `reconnected`, refetch the open thread and thread list.
- `thread-list-badges`: `useChatGroupsAsThreads.ts` and `useChatUnreadCount.ts`. On `reconnected`, refetch the thread
  list and the badge counts. The 10 s and 60 s timers run only while disconnected, or once per minute as a reconciliation.
- `typing-reactions`: `useTypingIndicators.ts` (no backfill, best effort) and `useMessageReactions.ts` (on `reconnected`,
  refetch the reactions of the open message).

Lane `measurement` (docs only, no dependency):
- `docs/validation/<VTID>/device-runbook.md`: the device procedure for the owner (Wi-Fi and cellular, app in foreground and
  backgrounded for two minutes, one open thread per surface, a second account sends the message).
- A results table template, to be filled from the owner's report. The session never runs the device test.

## Lanes and order
- `chat-realtime-helper` (first, `depends_on: []`).
- `dm-global`, `tenant-threads`, `group-chat`, `legacy-messages`, `thread-list-badges`, `typing-reactions`:
  `depends_on: [chat-realtime-helper]`. Parallel, because their file sets do not overlap. Six lanes is the per-plan build cap.
- `measurement`: `depends_on: []`, parallel with everything.
Shared files: none. The helper's exported names are fixed in this plan; no lane may change them.

## Tests and proof
- Every lane writes its red test first on `origin/main`: the reconnect or the resume refetch must fail there. Red output
  goes to `docs/validation/<VTID>/red-on-base.txt`.
- Every lane keeps the existing tests of its files green (`npx vitest run src/…` for its paths). Commands go to
  `docs/validation/<VTID>/commands.log`.
- `tsc --noEmit` error count does not rise above the base count (176 at plan time).
- Staging: each lane's `staging-tests.json` runs read-only. Staging writes to production Supabase, so no lane writes
  test content (platform `CLAUDE.md`, rules 31, 32, 48).
- Device numbers come from the owner's runbook, not from CI. A lane is not "verified" for speed until the owner's numbers
  exist. Lanes can be verified for correctness on staging.

## Owner decisions this plan depends on (open for sparring)
1. AI assistant chats: out of scope (assumed). Confirm or change.
2. Calendar invite response cards: out of scope (assumed). Confirm or change.
3. PR #1592: closed as superseded when lane `group-chat` opens, not merged on its own.

## Risks
- If the `chat_messages` publication is not applied, live INSERT events never fire for any surface. The fix still
  improves reconnect and resume, but delivery stays at the poll interval. This is the single largest unknown; the owner
  must confirm it before device numbers are read as a result.
- Seven channels per user is a platform load question. This plan keeps one channel per surface and does not merge them.
  Merging them is a later plan, after the device numbers show whether channel count matters.
- Refetches on `reconnected` add load after every network blip. Each lane refetches only the open conversation and its
  thread list, not the whole inbox.

## Decisions taken
- Scope is every surface listed in "Scope" above. The group-only lane is a sub-lane, not the plan.
- The helper is the one shared change, so each surface does the same thing on reconnect.
- The plan adds no database change and no gateway change.
<!-- plan:end -->

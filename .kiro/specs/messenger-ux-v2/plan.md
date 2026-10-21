---
change_class: standard
---
# plan(messenger-ux-v2): reliable sending, scroll, replies, media, search, sharing and push suppression in the Messenger
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610211130-c65e`. Spans `exafyltd/vitana-platform` (gateway +
migrations) and `exafyltd/vitana-v1` (Messenger UI). Premises pinned to `exafyltd/vitana-platform@bc27dd354` and
`exafyltd/vitana-v1@69d39ef34`. Detail per lane: `tasks.md`; owner requirements and their mapping: `requirements.md`.

<!-- plan:begin -->
## 1. Goal
The owner's spec "Vitanaland Messenger — UX Improvements & Functional Requirements" (2026-10-21, 13 requirements,
priorities P0/P1/P2, quoted in `requirements.md`): *"deliver a modern, fast, compact, and reliable messaging experience
comparable to Slack, WhatsApp, and Telegram, while maintaining the Maxina/Vitanaland design system"*, built *"in the
priority order above. The most important foundation is reliable message state, real-time synchronization, and correct
scroll behavior; media, sharing, and search should build on that foundation."*

## 2. Already delivered or in flight — not rebuilt here
| Req | Where | State |
|---|---|---|
| R4 Enter sends / Shift+Enter, R5 paste screenshots | vitana-v1 plan `messenger-paste-enter`, lane `composer`, PR #1445 (VTID-05229), `MessageInput.tsx` | **merged** (`32a82e6b6 on 2026-10-19`) |
| R6 recent emojis (MRU in localStorage) | vitana-v1 `chat-ux/recent-emojis`, #1424 (VTID-05202), `src/components/ui/emoji-picker.tsx:13-75` | done; gap: one device-wide key `vitana:emoji:recent:v1`, not per user; reactions not recorded |
| R8 deep-link jump without glide | `chat-ux/instant-scroll-on-open`, #1423 (VTID-05201), `ConversationView.tsx:453-474` | done |
| R1 density (padding, gaps, bubble width) | `chat-ux/compact-density`, #1425 (VTID-05203) | in-review, draft held since 2026-10-15 for the owner's visual check |
| Unread badge not bumped for the open thread | `chat-ux/notifications-self-chat`, #1422 (VTID-05200), `src/lib/chatViewingThread.ts` | done; client-side only, pushes unchanged |
#1445 is merged, so `MessageInput.tsx` on `main` already has Enter-to-send and paste. #1425's density values are
landed first, by the exceptions seat under the owner's instruction (§8), and lane `ui-compact-grouping` builds on them.

## 3. Today (measured, file:line)
**Data model (vitana-platform owns `chat_messages`, `chat_groups`, `chat_group_members`).**
`chat_messages(id, tenant_id, sender_id, receiver_id|group_id XOR, content, message_type, metadata jsonb, read_at,
created_at, sender/receiver_vitana_id)` — `supabase/migrations/20260225200000_chat_messages.sql:6-14`,
`20260315000000_chat_messages_type_metadata.sql:12-16`, `20260525000000_VTID_03089_chat_groups.sql:39-56`. No client id,
no `delivered_at`, no reply column (sidecar `chat_message_replies` exists in vitana-v1 `20260313092854…sql:2-27` but the
gateway never writes it), no search index. Attachments and mentions live in `metadata`. Group read state:
`chat_group_members.last_read_at`.
**Writes go through the gateway.** `POST /api/v1/chat/send` (`services/gateway/src/routes/chat.ts:59-300`, plain insert
via `chat-repository.ts:21`, allowed types at :79), `POST /api/v1/chat/groups/:id/send` (`routes/chat-groups.ts:259`),
read `POST /chat/read` (`chat.ts:453`), conversation `GET /chat/conversation/:peerId?limit&before` (`chat.ts:355`),
group messages `GET /chat/groups/:id/messages` (`chat-groups.ts:233`). A retried POST inserts a second row.
**Pushes.** `/send` → `coalesceChatPushes` (`services/chat-push-coalescer.ts`, VTID-05137) → `notifyUser`
(`services/notification-service.ts:809`; prefs, category, DND; `NotifyUserOptions.suppressPush` only `'coalesced'`,
:274-283). Additionally the vitana-v1 trigger `trg_notify_chat_message` (`vitana-v1
supabase/migrations/20260317103720_86cda538…sql:1-62`) inserts a `new_chat_message` row with `push_sent_at` NULL,
which the `/push-dispatch` cron (`routes/scheduled-notifications.ts:1252`, `fetchPendingPushNotifications`
`scheduled-notifications-repository.ts:222`) can push. Nothing knows whether the recipient is viewing the conversation.
**Client (vitana-v1).** DMs: `pages/Messages.tsx` → `components/messages/ConversationView.tsx` (1306 lines, inline
`messages.map` :1162-1270, not virtualised) → `hooks/useHybridMessages.ts` → `hooks/useGlobalMessages.ts`. Groups:
`pages/messages/GroupChat.tsx` (own list, scroll, send). Shared: `MessageBubble.tsx`, `MessageInput.tsx`, `ReplyQuote.tsx`,
`ChatImageViewer.tsx`, `ForwardMessageSheet.tsx`; gateway client `hooks/useChatApi.ts`.
- Send: optimistic row `id: temp-${Date.now()}` (`useGlobalMessages.ts:1145`); on error the catch only rethrows
  (:1300-1305), so the temp row stays "sending" forever; `_parentMessageId` accepted and dropped (:1130); no client id,
  no retry. Status icons `MessageBubble.tsx:361-405` (sending/sent/delivered/read; no failed). Offline banner text with
  no queue (`ConversationView.tsx:510-514`); ErrorMessage "Retry" only clears the error (:1284-1290).
- Scroll: open = `useLayoutEffect` set `scrollTop` + retries at 50/150/300 ms (`ConversationView.tsx:436-451`); follow
  only when within 50 px (:400-406); no "new messages" pill, no unread divider. `GroupChat.tsx:219-314` pin model; when
  unpinned a new message smooth-scrolls to the bottom anyway (forced scrolling).
- Replies: DM UI exists (`ConversationView.tsx:217,940-946`, `ReplyPreview`, `ReplyQuote`), parent resolved only from
  loaded rows (:1190-1194), tap jumps only when the parent is in the DOM; not persisted (above); groups have none.
- Media: `lib/fileUpload.ts:86-149` (`chat-attachments` bucket, progress simulated at 100 %); attachments stacked
  `space-y-2` (`MessageBubble.tsx:1064-1116`), no album grid; viewer images only.
- Search: only inbox thread-name filter (`Messages.tsx:461-516`). Share-to-chat: none (forward only; calendar invites).
- Tests: Vitest suites per component (`*.vtid-0xxxx.test.tsx`), staging Playwright `tests/e2e/staging/*`; gateway Jest
  `vtid-05137-chat-push-coalescing.test.ts`, `vtid-04926-chat-group-mentions.test.ts`, `chat/dm-tool-actions.test.ts`.

## 4. Interfaces between lanes (fixed here; lanes implement exactly this)
**I1 send (api-send-reliability).** `POST /chat/send` and `POST /chat/groups/:id/send` accept optional
`client_message_id` (UUID v4) and `reply_to_message_id` (UUID). New nullable column `chat_messages.client_message_id
uuid` with partial unique index `(sender_id, client_message_id) WHERE client_message_id IS NOT NULL`. A repeat with the
same pair returns `200 {ok:true, data:<existing row>, duplicate:true}` and sends no second push; first insert stays
`201`. Concurrent duplicates: the insert's unique violation (SQLSTATE `23505` on that index) is caught, the existing row
re-fetched by `(sender_id, client_message_id)` and returned as the duplicate response — never a 500. `reply_to_message_id` must be a message of the same conversation (same DM pair or same group) visible to the
sender, else `400 invalid_reply_target`; stored as `metadata.reply_to = {message_id}` (no copied content, so an edit or
delete of the parent is reflected and nothing leaks). Read endpoints expose it as `reply_to_message_id`. **Server-side read check:** a direct RLS insert can set any `metadata.reply_to` (`users_send_messages` checks only
`sender_id`, `20260225200000_chat_messages.sql:23`). So every read endpoint exposes `reply_to_message_id` only after
one batched check per page: the target exists in the same DM pair or the same group; otherwise null. The client
also resolves quotes only from that conversation's rows or I3. A forged value shows no quote, never foreign
content. Rows returned by every read endpoint include
`client_message_id`, `delivered_at`.
**I2 delivery (api-send-reliability).** Nullable `chat_messages.delivered_at timestamptz`. `POST /chat/delivered
{message_ids: uuid[] ≤ 200}` sets `delivered_at = now()` only where `receiver_id = caller` and `delivered_at IS NULL`
(DMs only). `read_at` set by `/chat/read` also sets `delivered_at` when NULL. Senders observe both through realtime UPDATE on `chat_messages` (`sender_id=eq.<me>`): Realtime authorises an
UPDATE event with the row's SELECT policy, and `users_read_own_messages` admits `sender_id = auth.uid()`
(`20260225200000_chat_messages.sql:19-21`). The client does not depend on it alone: thread focus/visibility already
refetches (`useGlobalMessages.ts:1716-1730`), so a missed event converges on the next refetch. **Groups have no per-message delivered/read
state** (read state is `chat_group_members.last_read_at`, `20260525000000_VTID_03089_chat_groups.sql:26`): a group
message's ladder is Sending → Sent | Failed only, and the bubble never shows Delivered/Read for a group message.
**I3 context window (api-send-reliability).** `GET /chat/conversation/:peerId?around=<messageId>&limit=N` and
`GET /chat/groups/:id/messages?around=<messageId>&limit=N` return up to N/2 rows before and after the target,
ascending, plus `{has_older, has_newer}`; 404 when the target is not in that conversation. `before`/`limit` unchanged;
add `after=<iso>` for forward paging.
**I4 viewing presence (api-viewing-presence).** `POST /chat/viewing {conversation_key, device_id, active}` where
`conversation_key` is `dm:<peerId>` or `group:<groupId>` as seen by the viewer. `active:true` upserts
`chat_viewing_presence(user_id, tenant_id, device_id, conversation_key, expires_at = now()+45s)` (`tenant_id` =
`identity.tenant_id`, so rows are tenant-scoped for cleanup; the check also matches the push's tenant); `active:false` deletes the row.
The client sends `active:true` every 20 s while the conversation is open AND the document is visible AND focused
(Appilix: visible), and `active:false` on blur, hide, unmount and conversation change (on `pagehide` via
`fetch(…, {keepalive:true})` with the normal `Authorization` header — `sendBeacon` cannot carry it; a lost final call
is bounded by the 45 s expiry). Any unexpired row for (recipient, key) on any device or tab = "viewing".
**Key = the recipient's own view.** The viewer posts `dm:<the other party>` or `group:<id>`. A push to recipient R
from sender S is checked as `user_id = R AND conversation_key = dm:<S>` (DM) or `group:<group_id>` (group). For a DM
the other party R sees is exactly S, so `dm:<data.sender_id>` is the recipient-perspective key. This is the same
convention as the existing coalescer key (`chatConversationKey({senderId})` = `dm:<sender>`,
`chat-push-coalescer.ts:48`, used for the recipient's rows). `chatConversationKeyFromData` therefore uses
`group_id` first, then `sender_id`, then the `message_id` lookup, and uses `data.conversation_key` only to
cross-check (a mismatch is logged and `group_id`/`sender_id` wins).
**One check, at the two places every chat push passes.** Chat pushes are produced by many callers (`chat.ts` /send
incl. calendar invites and the new-member-greeting branch `chat.ts:252` → `new-member-greeting-push.ts`,
`chat-groups.ts` fanout `:570-673` incl. mentions and invites, `chat-groups.ts:867` welcome refanout,
`orb-tools-shared.ts:2752`, `orb-tools/messaging-depth-tools.ts:395,902,1013`, `orb-tools/calendar-social-tools.ts:418`,
`welcome-team/welcome-team-service.ts:284`); all of them end in `notifyUser` (`notification-service.ts:809`) or, for
rows written without it, in `/push-dispatch` (`scheduled-notifications.ts:1252`). So the check lives in a new
`services/chat-viewing-presence.ts`, called from exactly those two places, and no caller changes:
- `chatConversationKeyFromData(data)` = (`data.group_id` → `group:<group_id>`) ?? (`data.sender_id` →
  `dm:<sender_id>`) ?? (`data.message_id` → batched lookup in `chat_messages(sender_id, group_id)`) ?? null (null = not
  suppressed). Every caller above already sets `group_id` or `sender_id`.
- `notifyUser`, for `type ∈ {new_chat_message, chat_mention}` when the push would otherwise go out: viewing → the
  in-app row is written exactly like the `coalesced` branch (`notification-service.ts:870-899`): `push_sent_at` set at
  INSERT, no push, `push_outcome 'suppressed_viewing'`, so `/push-dispatch` never re-selects it after the presence
  expires. `NotifyUserOptions` is unchanged (the decision is internal). Mentions in a viewed group are suppressed too.
  **Deliberate behaviour change, flagged for the owner at Gate 2 ("Decisions taken"); owner R13: no push for incoming
  messages while the recipient views that conversation):** calendar invites sent into a viewed DM/group are messages of that conversation and are suppressed too — the
  invite card appears live in the open chat and the in-app row is kept. This replaces, for the viewing case only, the
  coalescer's rule that invites are never coalesced (`chat.ts:268`), which stays unchanged for bursts. Types other
  than `new_chat_message` / `chat_mention` (e.g. `listing_interest`, `chat.ts:228-236`) are never suppressed.
- `/push-dispatch`, for an unpushed chat row: viewing → marked handled with `suppressed_viewing` (the existing
  `markHandled`, :1306-1309). Keys are resolved for the whole batch before the loop: rows without `conversation_key`,
  `group_id` or `sender_id` get their sender/group from ONE `select id, sender_id, group_id from chat_messages where id
  = any($message_ids)`, then ONE presence read for all (recipient, key) pairs — no per-row query.
- **New outcome values persist.** `user_notifications_push_outcome_check` hard-codes the allowed values (live: the 9
  of VTID-04962 plus `coalesced`, `20261013180000_vtid_05137_chat_push_coalescing.sql:24`), and `recordPushOutcome`
  swallows a violation (`notification-service.ts:303`). The lane's migration therefore drops and re-adds that CHECK
  with `suppressed_viewing` and `suppressed_duplicate` added (`NOT VALID`, then `VALIDATE`, the VTID-05137 pattern),
  and `PushOutcome` (`notification-service.ts:265`) gains both values.
- One batched presence read per `notifyUser` call / per cron batch; fails open (read error → push as before); off
  switch `CHAT_PUSH_VIEWING_SUPPRESSION_ENABLED` (default on).
- Interplay: the coalescer counts only really pushed rows (`wasPushed` excludes `suppressed_*`,
  `chat-push-coalescer.ts:76-81`), so the first message after the member leaves the chat pushes normally; the email
  fallback runs only for `no_device`/`fcm_error` (`email/notification-email-fallback.ts:34`), never for
  `suppressed_viewing`.
**Duplicate rows (second writer).** The vitana-v1 trigger `notify_on_chat_message` can write a second
`new_chat_message` row (url `/inbox`, `push_sent_at` NULL) for a DM that the gateway also notifies; its guard runs at
INSERT time, before the gateway's row exists. Measured read-only 2026-10-21: no such row in the last 120 days (the
trigger's insert does not land today; its live body also differs from the repo's last migration — drift recorded by
the lane, trigger not changed by this plan). Defensive rule, owned by the push path, both orders: (a) `/push-dispatch`, before sending anything in a batch, groups its unpushed chat rows by (`user_id`,
`data->>'message_id'`): of rows in the same group the oldest is kept and the rest are marked `suppressed_duplicate`; a
kept row is also marked `suppressed_duplicate` when another row of that pair already has `push_sent_at`. Overlapping
cron ticks are already serialised by `markHandled` writing `push_sent_at` first (VTID-04962); a re-enabled or changed
trigger would only add rows this rule handles; (b) `notifyUser`, before writing a chat row with a `message_id`, marks unpushed rows of
the same user and `message_id` `suppressed_duplicate`.
**I5 search (api-message-search).** `GET /chat/search?q=&scope=all|dm:<peerId>|group:<groupId>&from=&to=&type=
any|image|video|file|voice|link&sender=<userId>&cursor=&limit≤50` → `{results:[{message_id, conversation_key,
sender_id, created_at, snippet, message_type}], next_cursor}`. `q` ≥ 3 characters (the shortest a trigram index serves; shorter → 400), ILIKE on `content` and attachment
file names backed by a `pg_trgm` GIN index; scope restricted server-side to DMs where the caller is sender or receiver
and groups where the caller is a member, within `identity.tenant_id`; rate-limited per user.
**I6 shared content (api-shared-content).** New `message_type 'shared_content'`, `content_data = {kind:
'post'|'event'|'product'|'profile', id}` (`product` = the Discover marketplace product of `GET
/api/v1/discover/product/:id`, `routes/discover-search.ts:473`, the item `pages/discover/ProductDetail.tsx` shows; member
community listings keep their existing "Message seller" flow) — no title/image copied. Send validates the SENDER can see the item.
`GET /chat/shared-preview?kind=&id=` resolves the card for the CALLER with the caller's own permissions (the
user-scoped Supabase client of `lib/supabase-user.ts`, so RLS decides, never the service role):
`{available:true, title, description, image_url, url}` or `{available:false, reason:'deleted'|'restricted'}`. Push body
for this type is a catalog entry (`tt()`), never the item's content.
**I7 client outbox (ui-send-status).** `src/lib/messaging/outbox.ts`: each send gets `client_message_id =
crypto.randomUUID()` and an optimistic row `id: temp-<client_message_id>`, status `sending → sent | failed` (DMs then
advance to delivered/read from I2; groups stop at sent); the row is reconciled by `client_message_id`, never by
position; retry re-posts the SAME id; reconnect retries pending items once. **Persisted:** every unsent item
(`client_message_id`, conversation, body, `message_type`, `content_data` incl. already-uploaded attachment paths,
`reply_to_message_id`, `created_at`, attempts) is kept in `localStorage` under `vitana:chat:outbox:v1:<userId>` until
the server accepts it; on mount after a reload, pending items are re-posted once (safe: same id, I1 dedup) and failed
ones render with Retry; items older than 7 days are dropped; a storage error falls back to in-memory for that session.
The outbox is cleared on sign-out. The gateway-failure fallback insert into `chat_messages`
(`useGlobalMessages.ts:1229-1250`) carries the same `client_message_id`, so the unique index (I1) also dedups it
(`23505` → treated as sent). Legacy `global_messages` threads (direct insert, no `client_message_id`) get the statuses
and manual Retry after a definite error response, but no automatic re-post after reload (no server dedup there).
**Swap sites migrated:** the id-based optimistic→real swaps (`useGlobalMessages.ts:1284-1286`
`prev.map(m => m.id === optimistic.id ? realMsg : m)`, the group swap in `GroupChat.tsx` `handleSend`) are replaced by
one `reconcileByClientId(rows, realRow)` that matches `temp-<client_message_id>` or `client_message_id`, so a real row
with any server id (gateway or fallback insert) replaces the optimistic one. `/chat/delivered` is posted only for DM
rows (`receiver_id` = me); group threads never call it.
`onSendMessage` resolves once the item is queued (the composer clears; a failure shows on the bubble, not by
restoring the composer), so `MessageInput.tsx` is not edited.
**I8 jump (ui-reply-jump).** `useJumpToMessage(conversation)` → `jump(messageId)`: if the row is rendered, scroll it
into view (`block:'center'`, no animation) and highlight 1.5 s; else load I3 `around`, replace the window, then jump;
returns `false` (toast "message not available") on 404. Used by reply quotes and search results.

## 5. Lanes
Every UI change: Maxina tokens (`bg-card`, `text-muted-foreground`, `rounded-vcard`, logical RTL utilities), i18n keys in
`src/i18n/<lang>/inbox.json` for every locale, WCAG 2.2 AA (focus order, labels, 44 px targets), Playwright screenshots
1400×900 and 390×844 of exactly what changed. Every lane: the new behaviour's tests written first and recorded red on
base.

**vitana-v1, first**
0. `test-fixture-05201` (P0 prerequisite) — `main`'s `Vitest (jsdom)` is red on one pre-existing test,
   `ConversationView.deeplink-scroll.vtid-05201.test.tsx`: its fixture hard-codes `created_at` 2026-10-15 and its
   `@/lib/i18n-toast` mock lacks `getI18nLocale`, which the date divider calls (`lib/locale-format.ts:56`). Fix the
   test only (relative dates, complete mock), assertions unchanged, so every later lane lands on a green suite. Files:
   that test file. No dependency; lands first in vitana-v1.

**vitana-platform**
1. `api-send-reliability` (P0) — I1, I2, I3. Files: one migration (`client_message_id`, unique partial index,
   `delivered_at`), `routes/chat.ts`, `routes/chat-groups.ts`, `routes/chat-repository.ts`,
   `routes/chat-groups-repository.ts`, `DATABASE_SCHEMA.md`, new test `test/vtid-xxxxx-chat-send-reliability.test.ts`.
2. `api-viewing-presence` (P1, R13) — I4. Files: one migration (the `push_outcome` CHECK extended with
   `suppressed_viewing` and `suppressed_duplicate`; `chat_viewing_presence`, PK `(user_id, device_id)`,
   RLS on with no client policies, index `(user_id, conversation_key, expires_at)`, the caller's expired rows deleted
   on write), new `routes/chat-viewing.ts` mounted from `chat.ts` (`router.use('/viewing', …)`), new
   `services/chat-viewing-presence.ts`, `services/notification-service.ts` (+ `notification-service-repository.ts`),
   `routes/scheduled-notifications.ts` (+ repository), `DATABASE_SCHEMA.md`, new test
   `test/vtid-xxxxx-chat-viewing-presence.test.ts`. No push caller is edited. Depends on `api-send-reliability`
   (`chat.ts`, migration order).
3. `api-message-search` (P2, R12) — I5. Files: one migration (`CREATE EXTENSION IF NOT EXISTS pg_trgm`, GIN trigram
   index on `chat_messages.content`; the lane measures the table size read-only and states the lock time in the PR),
   new `routes/chat-search.ts` mounted from `chat.ts`, `DATABASE_SCHEMA.md`, tests incl. an authorization
   test (a non-member never gets a group hit; a third user never gets a DM hit; other tenant never). Depends on
   `api-viewing-presence`.
4. `api-shared-content` (P2, R11) — I6. Files: `routes/chat.ts` + `routes/chat-groups.ts` (allowed type, sender check,
   push copy), new `services/chat-shared-content.ts` (per-kind resolvers over `profile_posts`, `global_community_events`,
   the Discover product lookup of `discover-search.ts`, `global_community_profiles`, each using the user-scoped client
   of `lib/supabase-user.ts` so RLS decides; profiles also
   exclude `service_bot_accounts` / `notification_test_actors` via `lib/excluded-test-service-accounts.ts`, CLAUDE.md IF–THEN 45), i18n catalog entries, tests.
   Depends on `api-message-search` (chat.ts).

**vitana-v1**
5. `ui-send-status` (P0, R7) — I7 + realtime UPDATE subscription for `delivered_at`/`read_at` on own sent DMs; the
   recipient posts I2 `/chat/delivered` for rows received by realtime or fetch; failed state + "Retry" on the bubble
   (one tap, keyboard reachable), "Sending/Sent/Delivered/Read/Failed" accessible labels; group send through the same
   outbox; replies send `reply_to_message_id`; DM text messages keep their `content_data.mentions` (today dropped unless
   attachments exist, `useGlobalMessages.ts` `isRich`). Files: `hooks/useGlobalMessages.ts`, `hooks/useChatApi.ts`, new
   `lib/messaging/outbox.ts` (+ test), `components/messages/MessageBubble.tsx` (status/retry block only),
   `components/messages/ConversationView.tsx` (retry wiring, remove dead offline text), `pages/messages/GroupChat.tsx`
   (send path only), inbox i18n. Depends on `api-send-reliability`.
6. `ui-scroll-anchoring` (P0, R8, R9) — one shared hook `hooks/useChatScrollAnchor.ts` used by both views: the list is
   laid out bottom-anchored before first paint (rendered with `visibility:hidden` until the layout effect positions it,
   or a `flex-col-reverse` container — the lane picks one and proves it), no timed retries; follow new messages only
   when at bottom (≤ 80 px); otherwise a floating `NewMessagesPill` ("↓ N new messages", count of arrivals since the
   user left the bottom) that jumps to the newest; an unread divider at the first message after `last_read_at` when the
   conversation opens with unread messages, opening at that divider (WhatsApp rule) — a deep link / jump target wins
   over both; paging back keeps the reading position (existing anchor at `ConversationView.tsx:422-429`). Removes
   GroupChat's forced follow. Files: new hook + `components/messages/NewMessagesPill.tsx`, `ConversationView.tsx`,
   `GroupChat.tsx`, inbox i18n. Depends on `ui-send-status`.
7. `ui-reply-jump` (P0, R3) — I8; reply in groups (swipe + context menu + `ReplyPreview` passed to the composer through
   its existing `replyingTo` props, no `MessageInput.tsx` edit), parent resolved from loaded rows or fetched once via
   I3, tapping the quote jumps (I8) incl. unloaded parents, a deleted parent shows "original message deleted". Files:
   new `hooks/useJumpToMessage.ts`, `ConversationView.tsx`, `GroupChat.tsx`, `MessageBubble.tsx` (quote block),
   `ReplyQuote.tsx`, `hooks/useChatApi.ts`, inbox i18n. Depends on `ui-scroll-anchoring`, `api-send-reliability`.
8. `ui-compact-grouping` (P1, R1, R2) — consecutive messages of one sender within 5 min form a group: one avatar/name
   (first), tail on the last, 2 px gap inside a group / 8 px between groups, time shown on the group's last bubble and
   on hover/long-press for the others; day dividers unchanged; RTL. Density values come from #1425 as merged (or as
   main has them if #1425 is closed). Files: new `lib/messaging/grouping.ts` (+ test), `MessageBubble.tsx`,
   `ConversationView.tsx`, `GroupChat.tsx`. Depends on `ui-reply-jump`; #1425 lands first (§8).
9. `ui-emoji-recents` (P1, R6) — key per user `vitana:emoji:recent:v1:<userId>` (one-time copy of the device key into
   the first user's key, then delete it), reactions from `ReactionPopover` recorded in the same list, update at select
   time, storage failures fall back to an in-memory list. Files: `components/ui/emoji-picker.tsx` (+ its test),
   `components/messages/ReactionPopover.tsx`. Depends on nothing.
10. `ui-media-album` (P1, R10) — 2-10 images/videos of one message render as a grid (2: 1×2, 3: 1+2, 4+: 2×2 with "+N"),
    video in `ChatImageViewer` with native controls, real upload progress (`XMLHttpRequest` to a signed upload URL
    from `createSignedUploadUrl`, same bucket/path rule), a failed upload stays in the preview with its caption and a
    Retry; preview of photos, videos and files before sending (already partly there). Files: `lib/fileUpload.ts`,
    `MessageInput.tsx` (attachment strip/upload only), `MessageBubble.tsx` (attachment block), new
    `components/messages/MediaAlbum.tsx`, `ChatImageViewer.tsx`, `components/ui/attachment-preview.tsx` if needed,
    inbox i18n. Depends on `ui-compact-grouping`.
11. `ui-viewing-presence` (P1, R13) — I4 client: new `hooks/useChatViewingPresence.ts` (stable per-tab `device_id` in
    `sessionStorage`, 20 s heartbeat, `active:false` on blur/hide/unmount/switch, on pagehide `fetch` with `keepalive` + auth header), mounted in
    `ConversationView.tsx` (DM: `dm:<peerId>`) and `GroupChat.tsx` (`group:<id>`). Depends on `ui-compact-grouping`
    (same files) and `api-viewing-presence`.
12. `ui-message-search` (P2, R12) — global search in the inbox (search field searches thread names as today plus
    messages via I5, filters person/conversation, date range, attachment type; results with snippet and time) and
    in-conversation search (header icon, same filters, ↑/↓ between hits); selecting a result opens the conversation
    and calls I8. Files: new `components/messages/MessageSearchPanel.tsx`, new `hooks/useMessageSearch.ts`,
    `pages/Messages.tsx`, `ConversationView.tsx` (header entry), `GroupChat.tsx` (header entry), inbox i18n. Depends on
    `ui-viewing-presence`, `ui-reply-jump`, `api-message-search`.
13. `ui-shared-cards` (P2, R11) — "Send in message" on community posts (`components/home/CommunityPostCard.tsx`),
    events (`components/events/EventKebabMenu.tsx`), marketplace products (`components/discover/ProductDetailsDrawer.tsx`,
    `pages/discover/ProductDetail.tsx`), member profiles (`components/profile/shared/ShareProfileSheet.tsx`); a target
    picker `components/messages/SendInMessageSheet.tsx` built on `ForwardMessageSheet.tsx`'s target list (extracted,
    not copied); `components/messages/SharedContentCard.tsx` rendered by `MessageBubble.tsx` for `shared_content`
    (I6 preview, skeleton, unavailable state, tap opens the item route). Files above + the i18n namespaces of those
    surfaces. Depends on `ui-media-album`, `ui-message-search` (MessageBubble, inbox i18n), `api-shared-content`.

## 6. Parallel / shared / hot files
- Chains (shared files): platform 1→2→3→4 (`chat.ts`, migrations in timestamp order, `DATABASE_SCHEMA.md`);
  v1 5→6→7→8→{10, 11}; 11→12; {10, 12}→13 (`ConversationView.tsx`, `GroupChat.tsx`, `MessageBubble.tsx`,
  `useChatApi.ts`, `inbox.json` shards). Lane 9 runs in parallel with everything. Lanes 0, 1 and 9 start at once; lane 5
  starts when lanes 0 and 1 are on `main`; #1425 (chat-ux) merges after lane 0.
- No lane touches `src/App.tsx`, `screens.json`/`exclusions.json`, the parity ledger or `CLAUDE.md`. No new screen or
  route (search and the share sheet are panels/sheets on existing screens).
- Merges one per repo at a time, each up to date with `main`.

## 7. Tests and commands
- Gateway (platform lanes): `cd services/gateway && npx jest <lane tests> test/vtid-05137-chat-push-coalescing.test.ts
  test/vtid-04926-chat-group-mentions.test.ts test/chat`, `npx tsc --noEmit`, `npm run test:roles` (atlas drift guard;
  new `routes/chat-*.ts` files are already claimed by the community domain's `/^chat/`, `orb/developer/domain-atlas.ts:124`). Key cases: duplicate `client_message_id` → one row, one push; foreign reply target → 400;
  `/delivered` cannot touch rows of another receiver; viewing row suppresses only its conversation and expires; cron
  path suppressed; search never returns another user's DM or a non-member's group (tenant too); shared preview
  `restricted` for a private item the sender could see but the recipient cannot.
- vitana-v1 lanes: `npx vitest run src/components/messages src/pages/messages src/hooks src/lib/messaging
  src/components/ui/emoji-picker.vtid-05202.test.tsx`, `npx tsc --noEmit -p tsconfig.app.json`, `npm run lint`. Key
  cases: failed send keeps text and shows Retry; retry reuses the id; reconnect flush; first paint at newest (layout
  effect asserted before paint, no `scrollTo` with `smooth` on open); pill counts and does not move the scroll; jump to
  an unloaded message loads `around`; grouping boundaries; per-user emoji keys; album layouts; heartbeat timing and
  blur; search result navigation; unavailable card.
- Regression: every existing Messenger suite listed in §3 stays green unchanged (no assertion loosened). The known
  pre-existing failure `ConversationView.deeplink-scroll.vtid-05201.test.tsx` is fixed by lane `test-fixture-05201`
  (fixture only).
- Staging (read-only, CLAUDE.md ALWAYS 46-48): each deploying lane ships `docs/validation/<VTID>/staging-tests.json`
  and a `tests/e2e/staging/vtid-xxxxx-*.staging.spec.ts` that reads/renders only: open an existing conversation of the
  test user and assert the newest message is in view on the first screenshot frame, pill/divider/grouping/album
  rendering, search returns JSON and opens a hit, shared-preview probe. Every write path (send, retry, delivered,
  viewing heartbeat, share) is proven by CI unit/integration tests only; staging specs abort any POST to message or
  presence endpoints with `route.abort()`. No test targets production. Never write as the test user.

## 8. Preconditions outside this plan
- #1445 (`messenger-paste-enter/composer`, R4/R5): merged (met).
- #1425 (`chat-ux/compact-density`) merged before lane 8 starts: the owner asked on 2026-10-21 for the leftover
  messenger work to be finished and checked on staging. The exceptions seat updates it against `main`, has it reviewed
  and merges it (chat-ux lane, VTID-05203, outside this plan's lanes).

## 9. Measurement
`docs/validation/<plan VTID>/timings.json` (collaboration.md §8b schema), quoted at Gate 2.

## 10. Risks
- Index builds on `chat_messages`: measured read-only 2026-10-21 at 53,272 rows / 62 MB with `pg_trgm` installed, so
  both the partial unique index (new all-NULL column) and the trigram GIN index build in seconds; lane 3 re-measures
  and states the lock time in its PR.
- Realtime UPDATE events add traffic per sent DM (two updates at most: delivered, read).
- Presence heartbeats: one small upsert per open conversation per 20 s per tab; expired rows are deleted on write.
  A dead tab stops suppressing after ≤ 45 s, so a missed push window is bounded.
- Shared cards hold only `{kind, id}`; a preview is resolved per viewer, so no private content is copied into messages.
- Legacy `global_messages` group threads (community threads) get statuses and scrolling (shared UI) but not search,
  delivered state or presence suppression; they stay as today.
- Desktop Enter behaviour and paste land through #1445, not here.

## 11. Unchanged
Message tables' existing columns and RLS, `chat_message_replies`, the push coalescer (`chat-push-coalescer.ts`, not edited) and its 5-minute rule, every push caller listed in I4, notification
preferences/DND, the sidebar, routes and screens, the Vitana bot reply path (`/vitana-reply`), forward, calendar
invites, voice messages.
<!-- plan:end -->

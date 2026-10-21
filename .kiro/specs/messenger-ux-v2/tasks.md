# Tasks — messenger-ux-v2
Authoritative plan: `plan.md` (between the plan markers; interfaces I1-I8 in §4). Lane files: `lanes/`. VTIDs: one per
lane, allocated by CI PLAN-SPAR after policy approval; never by hand. Every lane: branch `kiro/messenger-ux-v2/<lane-id>`
from `origin/main` of its repo, PR title `VTID-xxxxx (messenger-ux-v2/<lane-id>): …`, trailers `Collab-Session` +
`Collab-Lane` on every commit, identity `kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in
`docs/validation/<VTID>/` (`commands.log` with every command and pass/fail counts, red-on-base output for every new
test, `staging-tests.json` for a lane that deploys). UI lanes attach the 1400×900 and 390×844 screenshots of what
changed to the PR. Acceptance below is what the reviewer agent `vitana-lane-reviewer` (claude-sonnet-5.5) checks.
Common acceptance for every lane: nothing outside the lane's `paths`; no existing assertion loosened or test skipped;
no production test, no write as the test user, staging specs read-only; all new DB columns nullable; RLS on every new
table.

<!-- lane: test-fixture-05201 -->
## Lane `test-fixture-05201` — make main's Vitest green again (vitana-v1)
- [ ] `ConversationView.deeplink-scroll.vtid-05201.test.tsx`: fixture dates relative to now; `@/lib/i18n-toast` mock
      complete (incl. `getI18nLocale`). No assertion changed.
**Acceptance:**
- The test fails on `origin/main` (recorded) and passes on the head; its assertions are byte-identical; full
  `npx vitest run` green; only that file (plus the lane's `docs/validation/<VTID>/`) changes.

<!-- lane: api-send-reliability -->
## Lane `api-send-reliability` — idempotent send, persisted replies, delivered, context window (vitana-platform)
- [ ] Migration: `chat_messages.client_message_id uuid NULL`, unique partial index `(sender_id, client_message_id)
      WHERE client_message_id IS NOT NULL`; `chat_messages.delivered_at timestamptz NULL`. Idempotent (`IF NOT EXISTS`).
- [ ] `POST /chat/send`, `POST /chat/groups/:id/send`: accept `client_message_id`, `reply_to_message_id` (I1).
      Duplicate → `200 {duplicate:true}` with the stored row, no push, no Vitana-reply side effect.
- [ ] `POST /chat/delivered` (I2); `/chat/read` also fills a NULL `delivered_at`.
- [ ] `around` and `after` on both read endpoints (I3); rows include `client_message_id`, `delivered_at`.
- [ ] `DATABASE_SCHEMA.md` updated (columns, index, endpoints).
**Acceptance:**
- Jest: same `client_message_id` twice → one insert, second response 200 `duplicate:true`, `notifyUser` called once;
  a race (unique violation `23505` on insert) is mapped to the duplicate response, not a 500.
- Reply target in another DM pair / another group / unknown → 400 `invalid_reply_target`; valid → `metadata.reply_to`.
- `/delivered` with ids of messages received by someone else updates 0 rows; > 200 ids → 400; `/delivered` and the
  bubble never apply to group messages.
- `around` on a message of another conversation → 404; result ascending with `has_older`/`has_newer`.
- Read endpoints: a row whose `metadata.reply_to` points into another conversation is returned with
  `reply_to_message_id: null`; an in-conversation target is returned; one batched check per page.
- Requests without the new fields behave exactly as before (existing chat tests unchanged and green).

<!-- lane: api-viewing-presence -->
## Lane `api-viewing-presence` — push suppressed for the conversation being viewed (vitana-platform)
- [ ] Migration `chat_viewing_presence(user_id uuid, tenant_id uuid, device_id text, conversation_key text, expires_at timestamptz,
      PRIMARY KEY (user_id, device_id))`, RLS enabled with no client policies (gateway service role only).
- [ ] `routes/chat-viewing.ts` (I4) mounted from `chat.ts`; `device_id` ≤ 64 chars, key format validated; the
      caller's expired rows deleted on write.
- [ ] `services/chat-viewing-presence.ts`: `chatConversationKeyFromData`, batched `viewingRecipients`.
- [ ] `notifyUser`: chat types + viewing → row written with `push_sent_at` at INSERT, no push, outcome
      `suppressed_viewing`; dedup rule (b). `/push-dispatch`: viewing → `suppressed_viewing`; dedup rule (a).
- [ ] Same migration: drop and re-add `user_notifications_push_outcome_check` with `suppressed_viewing` and
      `suppressed_duplicate` (`NOT VALID` then `VALIDATE`, as `20261013180000_vtid_05137_chat_push_coalescing.sql`);
      `PushOutcome` type extended.
- [ ] Off switch `CHAT_PUSH_VIEWING_SUPPRESSION_ENABLED` (default on); fails open.
**Acceptance:**
- Jest key matrix: DM A→B with B viewing `dm:<A>` → suppressed; B viewing `dm:<C>` → pushed; A viewing `dm:<B>` does
  not affect B's push; a payload whose `conversation_key` disagrees with `sender_id` uses `sender_id` (logged).
- Jest caller matrix, one case per I4 caller (chat.ts DM, chat.ts invite, new-member greeting, chat-groups fanout
  message + mention + invite, welcome refanout, orb-tools-shared, messaging-depth-tools ×3, calendar-social-tools,
  welcome-team): viewing → suppressed, not viewing → pushed; `listing_interest` never suppressed.
- Jest: viewing `dm:<sender>` suppresses that DM's push only; another conversation still pushes; group member viewing
  `group:<id>` gets no push for a message or a mention while a non-viewing member does; expired row (> 45 s) does not
  suppress; two devices, one viewing → suppressed; `active:false` → pushed.
- A viewing-suppressed row has `push_sent_at` set; then presence expires and `/push-dispatch` runs → still no push.
- Every caller listed in plan I4 is covered without being edited: one test each for the new-member-greeting DM, a
  calendar invite (DM and group) and an ORB-tool DM payload (`sender_id` only) → suppressed when viewing (invites: the
  deliberate R13 scope of I4), pushed when not viewing; a `listing_interest` push is never suppressed.
- Cron batch: N rows needing the `message_id` fallback → exactly one `chat_messages` select and one presence read
  (asserted on the mock call counts).
- Cron: a trigger-style row (`url:'/inbox'`, no `conversation_key`) is keyed via `sender_id`/`message_id`,
  suppressed when viewing; both write orders (trigger row first / gateway row first) and both rows unpushed in the same batch → exactly one
  push, the other row `suppressed_duplicate` before any push is sent.
- The outcome value is asserted as written (the `setNotificationPushOutcome` update receives `suppressed_viewing` /
  `suppressed_duplicate`), not just the absence of an error; the migration's CHECK list is a superset of the previous
  one (a test parses both migrations and compares).
- In-app row always written; email fallback not triggered for `suppressed_viewing`;
  `vtid-05137-chat-push-coalescing.test.ts` and `vtid-04926-chat-group-mentions.test.ts` green unchanged.

<!-- lane: api-message-search -->
## Lane `api-message-search` — authorised message search (vitana-platform)
- [ ] Migration: `pg_trgm` extension (if not present), GIN trigram index on `chat_messages.content`; lane records the
      row count (read-only query) and the chosen build mode in the PR.
- [ ] `routes/chat-search.ts` (I5) mounted from `chat.ts`; filters `scope`, `from`, `to`, `type`, `sender`; cursor
      pagination by `(created_at, id)`; snippet ±60 chars around the first hit; per-user rate limit.
**Acceptance:**
- Jest authorization: user C never sees an A↔B DM; a non-member never sees a group's messages; another tenant never;
  `scope=group:<id>` for a non-member → 403.
- `q` < 3 chars → 400; LIKE wildcards in `q` are escaped (a `%` query matches a literal `%`).
- Type filter `image` returns only messages whose attachments include an image mime type.

<!-- lane: api-shared-content -->
## Lane `api-shared-content` — shared post/event/product/profile cards (vitana-platform)
- [ ] `shared_content` allowed on DM and group send (I6); the sender must be able to see the item (resolver with the
      caller-scoped client), else 403 `share_not_allowed`.
- [ ] `services/chat-shared-content.ts` resolvers for `post`, `event`, `product` (Discover product), `profile`, each
      with the user-scoped client (`lib/supabase-user.ts`); `GET /chat/shared-preview`.
- [ ] Push body from the catalog (`notif.chat_shared_content.body`, every locale), never the item content.
**Acceptance:**
- Jest: a deleted item → `{available:false, reason:'deleted'}`; an item the caller cannot read under RLS →
  `restricted` (even if the sender could); profiles of `service_bot_accounts` / `notification_test_actors` →
  `restricted`; the stored message metadata contains only `{kind, id}`.

<!-- lane: ui-send-status -->
## Lane `ui-send-status` — optimistic send, statuses, retry (vitana-v1)
- [ ] `lib/messaging/outbox.ts` (I7) with unit tests; `useGlobalMessages` DM/legacy path and `GroupChat` send use it.
- [ ] Realtime UPDATE subscription filter `sender_id=eq.<me>` on `chat_messages`; its handler patches only
      `delivered_at`/`read_at` of rows already in the cache.
- [ ] Bubble: Sending (clock), Sent (✓), Delivered (✓✓), Read (✓✓ primary), Failed (red ! + "Retry" button);
      `aria-label` per status; status never regresses.
- [ ] Realtime UPDATE on own sent DMs (`sender_id=eq.<me>`) patches `delivered_at`/`read_at`; recipient posts
      `/chat/delivered` (batched, debounced 500 ms) for received rows.
- [ ] Reply id and DM mentions sent; offline: items stay `sending` and flush on reconnect.
**Acceptance:**
- Vitest: network error → bubble Failed with the text kept, composer cleared; Retry posts the same
  `client_message_id`; a duplicate response reconciles to one row; two quick sends keep their order; realtime echo
  of the sender's own message does not create a second row; reconnect flushes once; after a simulated reload the
  persisted outbox re-posts a pending item with its original id and shows a failed one with Retry; user A's outbox is
  never loaded for user B; a group message never shows Delivered/Read.
- The outbox is cleared on sign-out; the gateway-failure fallback insert carries the `client_message_id` (a `23505`
  reconciles as sent); a legacy `global_messages` thread item is never auto-re-posted after reload.
- Existing `MessageInput.*` suites green with `MessageInput.tsx` unchanged; a real row whose server id differs from
  the optimistic id (fallback insert) replaces the optimistic bubble (no stale "sending"); no `/chat/delivered`
  call for a group message; the UPDATE handler (filter asserted) moves a sent DM to Delivered then Read and never
  regresses; a missed event is corrected by the focus refetch.

<!-- lane: ui-scroll-anchoring -->
## Lane `ui-scroll-anchoring` — open at newest, pill, unread divider (vitana-v1)
- [ ] `hooks/useChatScrollAnchor.ts` shared by `ConversationView` and `GroupChat`; timed retries removed.
- [ ] `NewMessagesPill` with count; follow only at bottom; GroupChat's forced follow removed.
- [ ] Unread divider + open at it when unread; deep link / jump target wins; paging keeps position.
**Acceptance:**
- Vitest: on first commit the container's `scrollTop` is at the bottom before any paint (asserted in a layout
  effect / via hidden-until-positioned), no `scrollTo({behavior:'smooth'})` on open; incoming while scrolled up →
  scroll position unchanged, pill shows `N`; tap → bottom, pill gone; at bottom → follows.
- Staging spec (read-only): open an existing conversation; first screenshot already shows the newest message.
- Screenshots of pill and divider, desktop + mobile, RTL once.

<!-- lane: ui-reply-jump -->
## Lane `ui-reply-jump` — replies in DMs and groups, jump to any message (vitana-v1)
- [ ] `hooks/useJumpToMessage.ts` (I8) + `useChatApi` `around`.
- [ ] Group reply (swipe, context menu, preview in composer through existing props).
- [ ] Quote resolves unloaded parents (one fetch), deleted parent state, keyboard-activatable quote.
**Acceptance:**
- Vitest: a `reply_to_message_id` pointing outside the conversation renders "original message not available";
  quote tap on a loaded parent scrolls + highlights; on an unloaded parent loads `around` then jumps; 404 →
  toast, no scroll; reply sends `reply_to_message_id` in DM and group.

<!-- lane: ui-compact-grouping -->
## Lane `ui-compact-grouping` — message grouping (vitana-v1)
- [ ] `lib/messaging/grouping.ts` (pure; same sender, ≤ 5 min, same day, not system/divider) + tests.
- [ ] Bubble/list apply first/middle/last; avatar and name once per group; time on last + hover/long-press.
**Acceptance:**
- Vitest for boundaries (sender change, 5-min gap, day change, system message, reply still grouped).
- Screenshots desktop + mobile + RTL of a group conversation and a DM; density values identical to `main`.

<!-- lane: ui-emoji-recents -->
## Lane `ui-emoji-recents` — per-user recent emojis incl. reactions (vitana-v1)
- [ ] Per-user key, one-time migration of the device key, in-memory fallback; reactions recorded.
**Acceptance:**
- Vitest: user A's recents never show for user B; selecting/reacting moves the emoji to the front at once;
  `localStorage` throwing → picker still works; existing `emoji-picker.vtid-05202.test.tsx` green.

<!-- lane: ui-media-album -->
## Lane `ui-media-album` — albums, video viewer, real progress, upload retry (vitana-v1)
- [ ] `MediaAlbum` grid; `ChatImageViewer` video; real progress via signed upload URL + XHR.
- [ ] Failed upload retained with caption and Retry; remove cleans up the uploaded object.
**Acceptance:**
- Vitest: 2/3/4/7 media layouts; progress events update the strip; failure keeps the item and Retry re-uploads;
  send disabled while an upload runs; existing `MessageInput.*`, `ChatImageViewer.vtid-05138`,
  `MessageBubble.image-attachment.vtid-05138` suites green.
- Staging spec (read-only) renders an existing multi-image message if the test user has one, else the lane says so
  and relies on Vitest.

<!-- lane: ui-viewing-presence -->
## Lane `ui-viewing-presence` — viewing heartbeat (vitana-v1)
- [ ] `useChatViewingPresence(conversationKey)` in `ConversationView` and `GroupChat`.
**Acceptance:**
- Vitest with fake timers: heartbeat every 20 s only while visible + focused; `active:false` on blur, hidden, unmount,
  key change; `fetch` with `keepalive` + `Authorization` on pagehide; one `device_id` per tab; no call when the gateway is unconfigured.

<!-- lane: ui-message-search -->
## Lane `ui-message-search` — global and in-conversation search (vitana-v1)
- [ ] `MessageSearchPanel` + `useMessageSearch` (debounce 300 ms, cancel stale requests); inbox and header entries.
- [ ] Result → open conversation → `useJumpToMessage`; ↑/↓ between hits in a conversation.
**Acceptance:**
- Vitest: filters map to the I5 query; selecting a result in another conversation navigates and jumps; empty and
  error states; keyboard navigation of results.
- Staging spec (read-only): search a word from an existing message of the test user, open the hit, the message is
  highlighted in view.

<!-- lane: ui-shared-cards -->
## Lane `ui-shared-cards` — "Send in message" + shared cards (vitana-v1)
- [ ] Entry points on post, event, product, profile; `SendInMessageSheet` from the extracted forward target list.
- [ ] `SharedContentCard` (skeleton, available, unavailable) in `MessageBubble`.
**Acceptance:**
- Vitest: each entry sends `shared_content {kind,id}`; unavailable preview renders the explanation, not an empty
  card; card tap navigates to the item route; `ForwardMessageSheet.vtid-05138` green.
- Screenshots of the sheet and each card state, desktop + mobile.

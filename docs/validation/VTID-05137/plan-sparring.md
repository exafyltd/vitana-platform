# VTID-05137 / VTID-05138 — Plan sparring record

Plan hash (sha256 of the text between the plan markers): `e028246dbf7401267488c43f7dee78756a0a8d342203aa12bcddc61654aed6d4` (ledger metadata carries the 16-char prefix `e028246dbf740126`). Partner: plan-sparring-partner (read-only, independent). Class: standard. Rounds 1–2 CONVERGED before Gate 1.

**Owner approval:** "yes" in the Claude Code session, 2026-10-13 (Gate 1). VTID-05137 = push grouping (this repo + the web service-worker side in vitana-v1); VTID-05138 = chat images, viewer and forward (vitana-v1). Recorded in both ledger rows' metadata (sparring_record, plan_hash).

# Plan — WhatsApp-style chat pushes + chat images as pictures (viewer, copy, forward, download)

Change class: **standard** (gateway routes + notification service + frontend chat + service worker; possible CHECK-constraint migration).

<!-- plan:begin -->
## Problem (owner report 2026-10-12, with screenshots)
1. Android tray shows one card per chat message from the same sender ("Dragan Alexander" ×3 within 1 min). Data: of 4,334 chat pushes in the last 14 days, 3,412 (79%) were sent < 5 min after a previous push to the same recipient for the same conversation.
2. A screenshot sent in a DM renders as a generic file chip ("Screenshot_20261012_… 307.28 KB", FileText icon) instead of a picture. Owner wants: picture inline, tap → enlarge, plus copy / forward / download.

## Verified facts (premises)
- Phone pushes go through **Appilix** (`notification-service.ts:847-881`): chat always has `data.url`, so Appilix is sent first; raw FCM to Appilix-labelled native tokens is deliberately avoided because it crashes the WebView on tap. Appilix's push API has **no tag/collapse/group parameter** (`notification-service.ts:44-53`). ⇒ OS-level replace/stack is impossible on the native apps from our side; the only lever there is **sending fewer pushes**.
- DM push: `routes/chat.ts:241-251` (`notifyUser(..., 'new_chat_message', {data:{thread_id:sender_id, url:/inbox/u/<sender>}})`). Group fan-out: `routes/chat-groups.ts:561-657` (`new_chat_message` / `chat_mention`, `data.group_id`). No tag anywhere on these paths.
- Web SW `public/firebase-messaging-sw.js:66-70` picks tag `message_id` first ⇒ every web push is unique.
- FE marks chat notifications read on opening a conversation (`useGlobalMessages.ts:1395-1416`) by `data->>sender_id` (DM) / `data->>thread_id` (group) — gateway group rows carry `group_id`, not `thread_id`, so group rows are never marked read.
- Image bug root cause (`MessageBubble.tsx:702-718`): first render uses the stored upload-time signed URL (1 h TTL, `fileUpload.ts:91-104`); it 400s, `onError` adds the index to `failedImages` (line 569) which is never cleared, so when the fresh signed URL arrives (eager effect 235-246) the bubble is already stuck as a file chip forever.
- Viewer today: `ImageZoomModal.tsx` — small dialog, no zoom/swipe, Download only. Forward: `handleForward` is a TODO `console.log` (`MessageBubble.tsx:402-405`). A chat/group picker exists in `calendar/vcal/InviteToChatSheet.tsx` (VTID-04917).
- Chat attachments bucket is private; read RLS via `can_access_chat_attachment(name)` keyed on path segment 2 ⇒ forwarding an attachment needs a copy into the forwarder's own path for the target thread.

## Part A — Push grouping (vitana-platform, VTID A)
A1. New `services/gateway/src/services/chat-push-coalescer.ts`:
   - `chatConversationKey(data)` → `dm:<sender_id>` | `group:<group_id>`; every chat row written from now on carries it as `data.conversation_key` (older rows simply never coalesce).
   - `decideChatPushes(supabase, recipientIds[], key)` — **one batched query per message** (not per member): `user_id = any($ids) and type in ('new_chat_message','chat_mention') and data->>'conversation_key' = $key and created_at > now()-24h and read_at is null`, served by a new partial expression index (A2). Returns a map recipient → decision. On any query error it fails **open** (push as today) and logs. If a row exists whose push actually went out (`push_sent_at` not null and `push_outcome` not `coalesced`) **and** is still unread (`read_at is null`) → `{ push: false }` (coalesced). Else `{ push: true, unreadCount }` where `unreadCount` = unread rows for that key since the recipient last read the conversation (capped, e.g. 99).
   - Rule in words: at most **one push per conversation per 5 minutes while unread**; reading the chat resets it immediately. Mentions (`chat_mention`) are never coalesced (WhatsApp also always alerts on a mention).
A2. `notifyUser` gains an optional 6th arg `opts?: { suppressPush?: 'coalesced' }`, forwarded unchanged by `notifyUserAsync` and `notifyUsersAsync`. `notifyUser` never calls the coalescer itself — the decision is the caller's (sequence: caller → `decideChatPushes` → `notifyUser(..., {suppressPush})`). With `suppressPush` it writes the in-app row exactly as today (bell/unread counts stay complete), sets `push_sent_at` so the `/push-dispatch` cron never re-sends it, records `push_outcome='coalesced'`, sends nothing. **Required migration** (platform `supabase/migrations/`): re-create `user_notifications_push_outcome_check` with `'coalesced'` added (NOT VALID + VALIDATE), and add `idx_user_notifications_chat_conv` on `(user_id, (data->>'conversation_key'), created_at desc) where type in ('new_chat_message','chat_mention')`; `PushOutcome` union updated; `DATABASE_SCHEMA.md` updated. Migration lands and is applied before the gateway code that writes `'coalesced'`; until then the code path is behind `CHAT_PUSH_COALESCING_ENABLED` (default on once migrated; off = today's behaviour).
A3. When a push does go out and `unreadCount > 1`, the body becomes a localized summary via `tt()` — new key `notif.chat_burst.body` = "{count} new messages · {preview}" in `services/gateway/src/i18n/catalog.ts` (key union) and all 11 `services/gateway/src/i18n/locales/*.json` (DE du-form source). The title stays what the call site already sets (sender for DMs, group name for groups) — the summary never reads `data.sender_name` (not set on every path). Single-message pushes unchanged.
A4. Every chat push carries `tag = chat:<key>` (FCM `android.notification.tag`, `apns-collapse-id`, webpush tag) and `data.tag` the same, so FCM/web paths **replace** the previous card for the conversation. This helps web push / direct-FCM only; native-app users (Appilix, the majority on phones) benefit only from coalescing A1–A3.
A5. Apply A1–A4 at the DM route (`chat.ts`) and group fan-out (`chat-groups.ts`); the orb voice send paths (`orb-tools-shared.ts:2740-2760`, `messaging-depth-tools.ts:376-388`) call the same helper. Admin `refanout-welcome` untouched.
A6. Gateway Jest test `test/vtid-XXXXX-chat-push-coalescing.test.ts`: first message pushes; 2nd/3rd within 5 min while unread → coalesced (row written, no Appilix/FCM call, `push_sent_at` set); after read → pushes again; after 5 min → pushes with "3 new messages" summary; mention always pushes; tag present. Keep `test/vtid-04456-*` and existing notification tests green.

## Part B — Web/FE side of grouping (vitana-v1, VTID A)
B1. `public/firebase-messaging-sw.js` + foreground path in `src/lib/pushNotifications.ts`: tag order becomes `data.tag` → `thread-<thread_id>` → `message_id` → hash; `renotify: true` when the tag starts with `chat:` so a replaced card still alerts. 5-second dedupe kept.
B2. `useGlobalMessages.ts:1395-1416`: opening a group also marks rows whose `data->>group_id` matches (so group coalescing resets on read, and the bell clears).

## Part C — Images as pictures + viewer + actions (vitana-v1, VTID B)
C1. `MessageBubble.tsx`: an attachment with a `path` renders a fixed-size skeleton until its fresh signed URL resolves (never the stale stored URL first). Failures are keyed by URL, not index; on an image error with a `path`, re-sign once (bypassing cache) before falling back to the chip. Legacy `content_data.files` image entries also render inline.
C2. New `src/components/messages/ChatImageViewer.tsx` replacing `ImageZoomModal` for chat: full-screen black overlay, pinch-zoom + double-tap zoom + pan (pointer events, no new dependency), swipe/arrow keys between the images of that message, Esc/back closes, RTL-safe logical positioning. Toolbar: **Download** (existing `handleDownload` blob path), **Copy** (Clipboard API `ClipboardItem` as PNG; if unsupported — e.g. some WebViews — copies nothing and shows a translated "copying images isn't supported here" toast, never a silent no-op), **Share** (Web Share with file where `navigator.canShare({files})`; hidden otherwise), **Forward**. Composed with design tokens per SPOTLIGHT rules (overlay is chrome-free; no sidebar/ORB changes).
C3. Forward (bubble long-press drawer, desktop context menu, and the viewer): new `ForwardMessageSheet.tsx` reusing the target list logic from `InviteToChatSheet` (`dmTargets`, `fetchGroups`). Multi-select up to 5 targets. Sends a new message per target via the existing `sendChatMessage` / `sendGroupMessage`, carrying the body and attachments with `content_data.forwarded = true`; each attachment is first copied with `supabase.storage.from('chat-attachments').copy(src, <me>/<targetThread>/<ts>_<rand>.<ext>)` so the recipient's RLS grants read. Bubble shows a small translated "Forwarded" label when `content_data.forwarded`. Forward is hidden for voice messages, detected by `message_type === 'voice'` or attachment `type === 'voice'|'audio'` / `audio/*` mime. Copies run sequentially per target with a per-target result; a failed copy skips that target with a translated error toast (no partial message sent). N×M copies are bounded by the 5-target cap and the existing per-message attachment limit; a gateway-side copy endpoint is not needed for this volume.
C4. Copy (text) unchanged; for an image-only message the drawer "Copy" copies the image (same helper as C2).
C5. i18n: new keys in `src/i18n/de/screens.json` first (du-form), mirrored to en and the other 9 locales; `npm run i18n:inventory`.
C6. Vitest: `MessageBubble.image-attachment.vtid-B.test.tsx` (skeleton until signed; stale URL error then fresh URL → renders `<img>` not chip; re-sign-once path; legacy files inline), `ChatImageViewer.test.tsx` (open, swipe, download/copy/share/forward handlers, unsupported clipboard toast), `ForwardMessageSheet.test.tsx` (copies attachment then sends to each target with `forwarded:true`; supabase + chat API mocked — no network).
C7. Staging (read-only): `tests/e2e/staging/vtid-B-chat-image-viewer.staging.spec.ts` — sign in, open `/inbox`, intercept `**/storage/v1/object/sign/chat-attachments/**` with a locally fulfilled fixture response (no write leaves the browser), open a conversation, assert no file-chip fallback for image attachments where any exist and that the viewer chunk loads; plus `staging-tests.json` listing the Vitest suites as `existing`. No message is ever sent from staging; forward/copy are proven only in Vitest.

## Out of scope / known limits (stated to the owner)
- True WhatsApp **stacking** of several message lines inside one native card (Android MessagingStyle / iOS thread-id) needs control of the native app's notification rendering, which Appilix does not expose. With this plan the phone shows one card per conversation per burst with a "N new messages" summary; full stacking would require an Appilix feature or a native wrapper change (separate decision).
- Legacy `global_messages` / `messages` triggers keep their existing 30-second anti-spam.
- Muted-thread preference not read by the gateway (pre-existing; separate VTID if wanted).
- No What's New entry (improvement of an existing feature).

## Files in scope
vitana-platform: `services/gateway/src/services/chat-push-coalescer.ts` (new), `services/gateway/src/services/notification-service.ts`, `services/gateway/src/routes/chat.ts`, `services/gateway/src/routes/chat-groups.ts`, `services/gateway/src/services/orb-tools-shared.ts`, `services/gateway/src/services/orb-tools/messaging-depth-tools.ts`, `services/gateway/src/i18n/catalog.ts` + `services/gateway/src/i18n/locales/*.json` (11), `services/gateway/test/vtid-A-chat-push-coalescing.test.ts`, `supabase/migrations/<ts>_vtid_A_chat_push_coalescing.sql` (required) + `DATABASE_SCHEMA.md`, `docs/validation/<VTID-A>/`.
vitana-v1: `public/firebase-messaging-sw.js`, `src/lib/pushNotifications.ts`, `src/hooks/useGlobalMessages.ts`, `src/components/messages/MessageBubble.tsx`, `src/components/messages/ChatImageViewer.tsx` (new), `src/components/messages/ForwardMessageSheet.tsx` (new), `src/lib/chatImageActions.ts` (new), `src/lib/fileUpload.ts` (copy helper), `src/i18n/*/screens.json`, `docs/SCREEN_INVENTORY.md`, tests above, `docs/validation/<VTID-B>/`.

## Test plan
Local: gateway `npm run typecheck`, `npx jest` for the new suite + notification + `test:support`; frontend `npm run lint`, `npx tsc --noEmit`, `npx vitest run src/components/messages`, `npm test`, `npm run build`. CI on both PRs. Post-merge: STAGING-VERIFY (gateway smoke + frontend smoke + the new spec). No test writes anything to production; coalescing is proven with in-memory Supabase/Appilix/FCM mocks.
<!-- plan:end -->


## Planner responses — round 1
- F1 blocker — ACCEPTED. Migration is now required (CHECK re-created with 'coalesced', NOT VALID + VALIDATE), PushOutcome union + DATABASE_SCHEMA.md listed; code gated by CHAT_PUSH_COALESCING_ENABLED until migration applied.
- F2 major — ACCEPTED. notifyUserAsync / notifyUsersAsync forward the 6th arg; decision is taken before the async wrapper is called.
- F3 major — ACCEPTED. Sequence spelled out in A2: caller → decideChatPushes → notifyUser(opts). notifyUser never calls the coalescer.
- F4 (downgraded to note) — ACCEPTED as note. Copy-failure handling and N×M bound added to C3; gateway copy endpoint rejected as unnecessary at ≤5 targets.
- F5 major — ACCEPTED. A4 now states tag replacement is web/FCM-only; coalescing is the mechanism for Appilix.
- F6 minor — ACCEPTED. Summary body never reads data.sender_name; title kept from call site.
- F7 minor — ACCEPTED (verify at implementation that the id passed is the group id).
- F8 minor — ACCEPTED. Voice detection by message_type / attachment type / audio mime.
- F9 minor — ACKNOWLEDGED, no action.
- F10 minor — REJECTED in part: the gateway catalog has 11 locales (`services/gateway/src/i18n/locales/{ar,de,en,es,fr,pl,pt,ru,sr,tr,zh}.json`), not 4; files now enumerated.
- Q1: caller (see F3). Q2: batched — one query per message for all recipients (`user_id = any($ids)`). Q3: yes — new partial expression index on (user_id, data->>'conversation_key', created_at desc) for chat types; live indexes checked (only user_time/type/unread exist).

## Round 2 — partner disposition
F1–F10 all closed (F10 rejection upheld: gateway has 11 locale files). No new blockers or majors. Observation: conversation_key is forward-only — first post-deploy message in each conversation always pushes (intended).

## Verdict: CONVERGED (2 rounds, standard class)

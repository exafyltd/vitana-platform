# Sparring round 3 — escalated

Session: `c352d03f-acd9-4fb7-b8e6-d32b76eab0ce` · plan hash `3ccb9593b4eee77d9a202d8fe5ddcfe7db735736f222c7bb15a505706f6efcd5`

## Summary

The revision meaningfully closes R1-F1/R2-F2 (dedup rule owner + both write orders specified) and R2-F1 (group pushes confirmed to route through the coalescer; calendar-invite branches now handled). I verified the planner's two premise corrections against the code: fanoutGroupNotifications indeed calls coalesceChatPushes for every recipient except calendar invites (chat-groups.ts:657-659), and the coalescer stamps conversation_key into each payload (coalescer:168-172). Two genuine gaps remain in I4's push-suppression design: (1) the new `suppressPush:'viewing'` outcome's interaction with `push_sent_at` is unspecified, and the existing code only sets `push_sent_at` for `send` and `coalesced`, so a viewing-suppressed DM row could be re-pushed by `/push-dispatch` once the 45s presence expires; (2) the new-member-greeting DM branch (VTID-05208) produces a `new_chat_message` push but bypasses the coalescer (and thus applyViewingSuppression), so a greeting DM pushes to a recipient viewing `dm:<greeter>`. Both are missing call sites / unspecified semantics in a core P1 deliverable.

## Findings

### R3-F1 [major]

The plan adds `suppressPush: 'coalesced' | 'viewing'` and outcome `suppressed_viewing`, but does not specify that a 'viewing'-suppressed row gets `push_sent_at` set at insert. Today `notifyUser` sets `push_sent_at` only when `shouldSendPush || pushCoalesced` where `pushCoalesced = pushAllowed && opts?.suppressPush === 'coalesced'` (notification-service.ts:872,898-899). If 'viewing' is handled without setting `push_sent_at`, the gateway's own viewing-suppressed DM row remains `push_sent_at IS NULL`, and `fetchPendingPushNotifications` (scheduled-notifications-repository.ts:221-229, `.is('push_sent_at', null)`) will select it on the next cron tick; once the recipient's 45s presence expires (e.g. they closed the chat), the cron's viewing check no longer suppresses and it pushes a message the recipient already saw and read in-app — defeating I4's core guarantee.

- `exafyltd/vitana-platform:services/gateway/src/services/notification-service.ts:870` — const pushCoalesced = pushAllowed && opts?.suppressPush === 'coalesced'; const shouldSendPush = pushAllowed && !pushCoalesced; ... if (shouldSendPush || pushCoalesced) { insertData.push_sent_at = new Date().toISOString(); }
- `exafyltd/vitana-platform:services/gateway/src/routes/scheduled-notifications-repository.ts:221` — .select('id, user_id, tenant_id, type, title, body, data, channel, priority, created_at').is('push_sent_at', null).in('channel', ['push', 'push_and_inapp'])
- `exafyltd/vitana-platform:services/gateway/src/services/notification-service.ts:285` — export interface NotifyUserOptions { suppressPush?: 'coalesced'; }

Suggestion: Specify explicitly that `suppressPush:'viewing'` also sets `push_sent_at` at insert (with `push_outcome 'suppressed_viewing'`), exactly mirroring the `coalesced` branch at notification-service.ts:898-899, so the cron's `fetchPendingPushNotifications` never re-selects a row the gateway already decided to suppress. Add a test: DM suppressed for viewing, then presence expires, then `/push-dispatch` runs → no push.

### R3-F2 [major]

I4 places `applyViewingSuppression` inside `coalesceChatPushes` and enumerates the DM coalescer, group fanout, and the two calendar-invite branches as the check sites — but the new-member-greeting DM branch (VTID-05208) also emits a `new_chat_message` push yet bypasses the coalescer. In chat.ts:252-264 the greeting path calls `prepareNewMemberGreetingPush` and, when grouping is ON (its normal state) and succeeds, that function builds its own payload and returns it (new-member-greeting-push.ts:142-161) without ever invoking `coalesceChatPushes` (it only calls it as a fail-open fallback at :131-132,135,139). The greeting push is stamped `conversation_key = dm:<sender>` (:130,147), so a recipient viewing `dm:<greeter>` would still receive the greeting push, contradicting I4's 'viewed conversation gets no push' guarantee.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:252` — if (notifType === 'new_chat_message' && msgType === 'text' && isNewMemberGreeting(metadata)) { const prepared = await prepareNewMemberGreetingPush(supabase, { senderId: identity.user_id, receiverId: receiver_id, payload }); ...
- `exafyltd/vitana-platform:services/gateway/src/services/new-member-greeting-push.ts:130` — const conversationKey = chatConversationKey({ senderId }); const fallback = async () => (await coalesceChatPushes(...))[0]; ... const payload: NotificationPayload = { ...input.payload, tag: GREETING_PUSH_TAG, data: { ...(input.payload.data || {}), conversation_key: conversationKey, ... } }; ... return { userId: receiverId, payload };

Suggestion: Add the new-member-greeting DM branch to I4's file list and route its non-held-back result through `applyViewingSuppression` (or run the viewing check inside `prepareNewMemberGreetingPush` before returning). Add a test asserting a recipient viewing `dm:<greeter>` receives no greeting push while a non-viewing recipient does.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Verified: fanoutGroupNotifications routes every non-invite recipient through coalesceChatPushes (chat-groups.ts:657-659), and the coalescer stamps conversation_key on each item. The revision correctly names the real gaps (calendar-invite branches, mentions-always-push rule) and specifies applyViewingSuppression inside the coalescer plus direct calls on the invite branches. Addressed.
- R2-F2: acknowledged — The revision now specifies the dedup rule's owner and both write orders, and I verified the trigger's guard runs at INSERT time before the gateway's notifyUser (migration :20-27 vs chat.ts:127 then :280), so a separate dedup mechanism is genuinely required. Addressed in I4.

# Sparring round 1 — in_progress

Session: `c352d03f-acd9-4fb7-b8e6-d32b76eab0ce` · plan hash `6c715f2a92d24fde06aac19ed1722faeb0dacf32bcd1109cac87f9651a934c91`

## Summary

The plan is unusually thorough and its data-model premises largely check out (no client_message_id/delivered_at; plain insert ⇒ duplicate rows; status icons lack a failed state; suppressPush only 'coalesced'). The main gaps are: (1) the second, trigger-created notification path (vitana-v1 notify_on_chat_message) writes rows with no conversation_key and no push_sent_at, so I4's cron-side "viewing" suppression and dedup depend on a message_id→conversation join the plan never specifies, and the gateway+trigger both emit new_chat_message rows for the same DM; (2) group messages have no delivered_at/read_at, yet I7 promises the full Sending→Delivered→Read ladder for group sends, so group senders will never advance past "sent"; (3) the outbox is in-memory so a reload silently drops failed sends, contradicting the "reliable message state" P0 foundation. Several minor issues (unique-index race, 2-char trigram seq-scan) also noted.

## Findings

### R1-F1 [major]

The second push path (vitana-v1 trigger notify_on_chat_message) inserts a `new_chat_message` row with no `conversation_key` and no `push_sent_at`, so I4's cron-side 'viewing' suppression cannot map the row to a conversation without an unspecified join, and can double-push.

- `exafyltd/vitana-v1:supabase/migrations/20260317103720_86cda538-269f-4f2e-ba75-033842e6564e.sql:41` — INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority) VALUES (... jsonb_build_object('entity_id', NEW.id::text, 'message_id', NEW.id::text, 'sender_id', NEW.sender_id::text, 'url', '/inbox') ... 'push_and_inapp', 'p1');
- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:268` — coalesceChatPushes(... chatConversationKey(...), ...) ... await notifyUser(receiver_id, ...)
- `exafyltd/vitana-platform:services/gateway/src/routes/scheduled-notifications.ts:1256` — push_sent_at IS NULL → not yet pushed

Suggestion: Specify how the cron derives conversation_key for trigger rows (join chat_messages ON data->>'message_id' to get sender_id → dm:<sender_id>), and confirm the trigger's own dedup guard actually prevents a second row for gateway writes (it fires at INSERT time, before the gateway's notifyUser writes its row, so it likely does not). Add an integration test asserting exactly one push per DM when viewing suppression applies to the cron path.

### R1-F2 [major]

Group messages have no delivered_at and no per-message read_at (group read state is chat_group_members.last_read_at), yet I7 promises group sends flow through the same outbox with the full Sending→Sent→Delivered→Read ladder, so group senders never advance past 'sent'.

- `exafyltd/vitana-platform:supabase/migrations/20260525000000_VTID_03089_chat_groups.sql:26` — CREATE TABLE ... chat_group_members (... last_read_at TIMESTAMPTZ, PRIMARY KEY (group_id, user_id));
- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:453` — router.post('/read', ... const { peer_id } = req.body; ... repo.markPeerMessagesRead(...) ... return res.json({ ok: true });
- `exafyltd/vitana-v1:src/components/messages/MessageBubble.tsx:363` — const getMessageStatus = () => { if (isOptimistic) return 'sending'; if (message.read_at) return 'read'; if (message.delivered_at) return 'delivered'; ... return 'sending'; }

Suggestion: Define group delivery/read semantics explicitly. Either add per-group-message delivered/read observability, or constrain the status ladder to 'sent' for group sends and state that in I2/I7 so the shared MessageBubble status block does not render an impossible 'delivered/read' state for groups.

### R1-F3 [major]

The outbox is in-memory (no persistence), so a full page reload or app restart discards pending/failed sends, contradicting the 'reliable message state' P0 foundation and making 'Retry' on the bubble the only recovery — which itself is lost on reload.

- `exafyltd/vitana-v1:src/hooks/useGlobalMessages.ts:1144` — id: `temp-${Date.now()}`
- `exafyltd/vitana-v1:src/hooks/useGlobalMessages.ts:1300` — } catch (error) { console.error("Error sending chat message:", error); throw error; } finally { setIsSending(false); }

Suggestion: Persist the outbox (e.g. localStorage keyed by user, or IndexedDB) so failed/pending items survive reload and are re-attempted on next session mount, keyed by client_message_id. Otherwise scope I7's claim to 'non-reload recovery'.

### R1-F4 [minor]

I1's duplicate path depends on catching the unique-index violation race (two concurrent POSTs with the same client_message_id), but the plan only states the happy 'repeat returns duplicate:true' path without specifying the 23505 handling.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat-repository.ts:20` — export async function insertChatMessage(sb, row) { return sb.from('chat_messages').insert(row).select().single(); }

Suggestion: Specify that the insert catches SQLSTATE 23505 (unique_violation) on the (sender_id, client_message_id) index, then re-fetches the existing row and returns duplicate:true — and add a test simulating this race.

### R1-F5 [minor]

I5 allows `q` ≥ 2 characters but a pg_trgm GIN index does not accelerate a 2-character ILIKE '%q%' (trigram extraction requires ≥3 chars), so short queries fall back to a sequential scan on chat_messages unless a minimum-length guard is set server-side.

- `exafyltd/vitana-platform:supabase/migrations/20260225200000_chat_messages.sql:8` — CREATE TABLE IF NOT EXISTS chat_messages ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ... content TEXT NOT NULL, ...)

Suggestion: Either raise the minimum q to 3 for index use (still vends 2-char via seq scan knowingly), or note the 2-char path bypasses the index and add a simple `LENGTH(q) >= 2` validation plus a documented perf expectation.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

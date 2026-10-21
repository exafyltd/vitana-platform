# Sparring round 2 — in_progress

Session: `c352d03f-acd9-4fb7-b8e6-d32b76eab0ce` · plan hash `9f2f0b91d9b82a26161e580540113612fc7d94e9dd4deb50622d095f53ceea0e`

## Summary

The revision addresses all five round-1 findings on paper (I4 key derivation, I2 group ladder scoping, I7 localStorage outbox, I1 23505 handling, I5 q≥3). Two concerns remain substantive. First, R1-F1's double-push problem is now covered by an integration test but no actual dedup mechanism is specified for the two write paths (trigger at INSERT vs gateway after-insert), so the test would fail without a real mechanism. Second, and new: I4 applies viewing suppression through the chat-push-coalescer/notification-service, but group message pushes route through fanoutGroupNotifications (chat-groups.ts:361), which is absent from I4's file list — so a member viewing group:<id> may still get a push. The chain and file lists are otherwise coherent.

## Findings

### R2-F1 [major]

I4 wires viewing suppression into chat-push-coalescer.ts and notification-service.ts, but group message pushes do not go through coalesceChatPushes — the group send route calls fanoutGroupNotifications (chat-groups.ts:361). I4's file list (coalescer, notification-service, scheduled-notifications, chat-viewing) does not include the group fanout path, so a group member viewing group:<id> would still receive a push for that conversation, contradicting I4's promise that mentions/messages are suppressed for the viewed group conversation.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat-groups.ts:360` — try { await fanoutGroupNotifications(supabase, groupId, identity.user_id, ... fanoutBody, data.id, new Set(mentions.map(...)), msgType === CALENDAR_INVITE_TYPE, ); } catch (err: any) { console.warn('[ChatGroups] Fanout failed:' ...); }
- `exafyltd/vitana-platform:services/gateway/src/routes/chat-groups.ts:42` — import { notifyUser } from '../services/notification-service'; import { coalesceChatPushes, chatConversationKey, ... } from '../services/chat-push-coalescer';

Suggestion: Confirm fanoutGroupNotifications routes each recipient through the (now viewing-aware) coalescer/notifyUser with suppressPush:'viewing', or add the viewing check inside fanoutGroupNotifications. Add fanoutGroupNotifications to I4's file list and a test asserting a group member viewing group:<id> receives no push while a non-viewing member does.

### R2-F2 [major]

R1-F1 is marked accepted, but the revision supplies only an integration test ('exactly one push per DM across both paths') and no mechanism that actually prevents the double write. The trigger's dedup guard runs at INSERT time and checks data->>'message_id' = NEW.id::text (20260317103720:20-27), before the gateway later calls notifyUser to write its own row (chat.ts insert at :127, notifyUser at :280-282), so the guard cannot suppress the gateway's row; a test asserting exactly-one-push will fail unless a real dedup rule (e.g. the cron skipping one of two rows sharing message_id) is specified.

- `exafyltd/vitana-v1:supabase/migrations/20260317103720_86cda538-269f-4f2e-ba75-033842e6564e.sql:20` — IF EXISTS ( SELECT 1 FROM user_notifications WHERE user_id = NEW.receiver_id AND type = 'new_chat_message' AND data->>'message_id' = NEW.id::text ) THEN RETURN NEW; END IF;
- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:127` — const { data, error } = await repo.insertChatMessage(supabase, { tenant_id: ..., sender_id: identity.user_id, receiver_id, content: trimmedContent, message_type: msgType, metadata, ... });
- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:279` — } else if (notifyOpts) { await notifyUser(receiver_id, identity.tenant_id!, notifType, payload, supabase, notifyOpts); } else { await notifyUser(receiver_id, identity.tenant_id!, notifType, payload, supabase); }

Suggestion: Specify the dedup rule concretely: e.g. the cron's fetchPendingPushNotifications already selecting push_sent_at IS NULL rows, add a rule that for DMs the cron skips (marks push_outcome 'suppressed_duplicate') a trigger row whose message_id already has another notification row that was pushed by the gateway, or have the gateway, before notifyUser, not write when a trigger row for the same message_id already exists. State which component owns dedup and write the test against that behavior.

## Acknowledgements of earlier responses

- R1-F1: disputed — The key-derivation side is addressed (I4 cron derives dm:/group: via message_id), but the dedup mechanism is not — see R2-F2. Only an assertion was added, not the rule that stops the trigger+gateway double write.
- R1-F2: acknowledged — I2/I7 now scope the group ladder to Sending->Sent|Failed and forbid Delivered/Read rendering for groups; sound.
- R1-F3: acknowledged — localStorage outbox with client_message_id-keyed reconciliation is a sound persistence fix.
- R1-F4: acknowledged — 23505 catch + re-fetch + duplicate:true is specified; race test preserved.
- R1-F5: acknowledged — q>=3 with 400 for shorter removes the sequential-scan path; reasonable.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

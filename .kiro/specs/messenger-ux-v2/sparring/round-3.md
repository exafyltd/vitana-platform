# Sparring round 3 — escalated

Session: `9237de82-2618-4566-8bc7-1eefa33ac326` · plan hash `176f9ab9d1c467866740ff5601f19ae0c14fa2eb818abcc2f2644dc82931981b`

## Summary

Round 3 review. Accepted finding R2-F1 (push_outcome CHECK constraint) is properly addressed: I verified the CHECK constraint at 20261013180000_vtid_05137_chat_push_coalescing.sql:24-41 hard-codes exactly the 9 VTID-04962 values plus 'coalesced', and recordPushOutcome (notification-service.ts:303-314) swallows violations — so the plan's lane 2 migration to add 'suppressed_viewing'/'suppressed_duplicate' is required and correctly specified. Prior round-1 findings F2 (id-based optimistic swap), F3 (DM-only /delivered), F4 (tenant_id on presence) are all addressed in the revised I7/I4 sections. I raise one new major finding: the I4 viewing-suppression check in notifyUser applies to type 'new_chat_message', which includes calendar invites and listing_interest, but the plan's interplay/coalescer language treats calendar invites as always-pushing events — this is an internal inconsistency that could cause a calendar-invite push to be silently suppressed (with the in-app row written but no push) while the recipient is viewing the DM, contradicting the "events of their own, always go out unchanged" rule. I also raise a minor gap: the '/push-dispatch' cron path derives the conversation key via a fallback to data.message_id → single chat_messages lookup, which the plan does not specify as batched (unlike the notifyUser path), creating an N+1 per cron row for trigger-written chat notifications.

## Findings

### R3-F1 [major]

I4's viewing suppression in notifyUser keys on `type ∈ {new_chat_message, chat_mention}`. Calendar-invite DMs go through POST /chat/send with notifType='new_chat_message' (chat.ts:201 default, and the invite branch at :252 only changes the payload, not the type), so a calendar invite sent while the recipient is viewing the DM would match the type filter and be written as 'suppressed_viewing' — no push, push_sent_at set. This directly contradicts the coalescer's established rule (chat.ts:268 `msgType !== CALENDAR_INVITE_TYPE`) and the plan's own 'Interplay'/caller-list language that treats calendar invites as events that 'always go out unchanged'. A recipient viewing the DM would never receive the lock-screen invite push, and since push_sent_at is set, the /push-dispatch cron would never re-send it — a silently dropped invitation.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:201` — let notifType = 'new_chat_message'; ... if (notifType === 'new_chat_message' && msgType === 'text' && isNewMemberGreeting(metadata)) { ... } else if (notifType === 'new_chat_message' && msgType !== CALENDAR_INVITE_TYPE) { const [prepared] = await coalesceChatPushes(...) ... } ... await notifyUser(receiver_id, identity.tenant_id!, notifType, payload, supabase, ...)
- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:218` — if (msgType === CALENDAR_INVITE_TYPE) { const receiverLocale = await getUserLocale(supabase, receiver_id); notifBodyFinal = tt('notif.calendar_invite.body', receiverLocale, { name: senderName }); }

Suggestion: Explicitly scope the I4 viewing-suppression check to exclude calendar invites (and listing_interest, whose type is 'listing_interest') so the viewing rule matches the coalescer's 'always push calendar invites' rule. Either (a) skip suppression when msgType === CALENDAR_INVITE_TYPE / notifType === 'listing_interest', or (b) document an explicit, deliberate decision that viewing suppression does apply to invites and update the 'Interplay'/§3 language that currently says invites 'always go out unchanged' to reflect the new suppression. Add a test asserting a calendar invite push is NOT suppressed by viewing presence.

### R3-F2 [minor]

The /push-dispatch cron path's conversation-key derivation falls back to `data.message_id → one lookup in chat_messages(sender_id, group_id)`. The plan specifies 'one batched presence read per notifyUser call / per cron batch' for the presence read, but does not say the chat_messages lookups for trigger-written rows are batched. Trigger-written new_chat_message rows (which the plan itself says the cron picks up, and which may lack group_id/sender_id in their data payload) would each perform a separate chat_messages SELECT for the sender_id/group_id fallback, then an additional presence read — an N+1 per drained batch row.

- `exafyltd/vitana-platform:services/gateway/src/routes/scheduled-notifications.ts:1252` — router.post('/push-dispatch', async (req, res) => { ... const { data: pending, error } = await repo.fetchPendingPushNotifications(supa, lookbackCutoff); ... for (const notif of pending) { ... } }
- `exafyltd/vitana-platform:services/gateway/src/routes/chat-groups.ts:641` — data: { type: 'new_group_message', group_id: groupId, sender_id: senderId, ... message_id: messageId, ... }

Suggestion: Specify that the cron path batches the chat_messages lookups needed for the data.message_id fallback (e.g., one SELECT ... WHERE id = ANY($ids) for the batch), rather than a scan-per-row, and state this in I4's /push-dispatch bullet alongside the 'one batched presence read per cron batch' claim.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Planner accepted and correctly specified the fix. I verified the CHECK is indeed hard-coded without the two new values and that recordPushOutcome swallows the error, so extending the CHECK (NOT VALID then VALIDATE) and adding the PushOutcome values is required and now present in lane 2 / I4.
- R1-F2: acknowledged — Addressed: I7 now specifies reconcileByClientId for both the DM swap (useGlobalMessages.ts:1284-1286) and the GroupChat handleSend swap, and confirms the fallback insert carries the same client_message_id. Verified the optimistic id is still temp-${Date.now()}, so the migration is needed.
- R1-F3: acknowledged — Addressed: I7 now states /chat/delivered is posted only for DM rows and group threads never call it. (Prior note: not a data bug, just wasted posts.)
- R1-F4: acknowledged — Addressed: I4 now gives chat_viewing_presence a tenant_id column (identity.tenant_id) for tenant-scoped cleanup.

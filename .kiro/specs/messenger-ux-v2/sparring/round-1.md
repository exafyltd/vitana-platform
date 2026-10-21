# Sparring round 1 — in_progress

Session: `9237de82-2618-4566-8bc7-1eefa33ac326` · plan hash `a758790001d9aef888973a58a5586516d697dd3475c7e821c993032c9e9ee90e`

## Summary

This is a large, well-structured plan with mostly accurate premise citations. I verified 13 premises against code (allowed types, coalesced branch, PushOutcome type, wasPushed, optimistic temp id + rethrow-only catch, DM fallback insert, emoji device key, MessageBubble status ladder, 50ms follow threshold, timed-retry scroll, markHandled pattern, vitana-v1 trigger insert). All held. Findings below cover: the id-based optimistic→real swap in useGlobalMessages that I7's client_message_id reconciliation must migrate; group-message delivered semantics producing wasted /chat/delivered calls; and a presence-model note (no tenant column) that I concluded is actually tenant-safe but worth recording for cleanup.

## Findings

### R1-F2 [major]

I7 outbox resolves onSendMessage at queue time and reconciles rows 'by client_message_id, never by position', but the existing DM send path swaps the optimistic row by id at useGlobalMessages.ts:1284-1286 (`prev.map(m => m.id === optimistic.id ? realMsg : m)`), and the DM fallback insert (same file, 1226-1247) produces a realMsg whose id differs from the optimistic `temp-<...>` id. If the optimistic id changes to `temp-<client_message_id>` under I7 while the reconciled realMsg id is the fallback-inserted row id, the id-based swap will not match and the temp row will remain as a stale 'sending' bubble forever. The plan must explicitly migrate this swap site to key on client_message_id (or on the optimistic id that is now derived from client_message_id), and must cover the fallback-insert path carrying the same client_message_id.

- `exafyltd/vitana-v1:src/hooks/useGlobalMessages.ts:1226`

Suggestion: In lane 5, replace the id-based optimistic swap at useGlobalMessages.ts:1284-1286 with reconciliation keyed on client_message_id (store the temp id as `temp-<client_message_id>` and map by stripping the temp prefix, or track optimistic→real by client_message_id). Also ensure the fallback direct insert (line 1230-1244) includes client_message_id so I1's unique index dedups it and the reconcile finds it.

### R1-F3 [minor]

I2 `/chat/delivered` is DM-only (`receiver_id = caller`), and group messages carry `group_id` not `receiver_id`, so the recipient of a group message posting /chat/delivered (as I7 says 'the recipient posts I2 /chat/delivered for rows received by realtime or fetch') will get a non-matching/no-op result for every group message. Group viewing presence is mounted in GroupChat (lane 11) and group send uses the same outbox (lane 5), so this path will fire for groups. Not a data bug (the update just matches zero rows), but it generates a wasted authenticated POST per group message on every open and should be routed away for group threads.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat-groups.ts:233`
- `exafyltd/vitana-v1:src/components/messages/MessageBubble.tsx:363`

Suggestion: Specify that I2 /chat/delivered posting is DM-only client-side: the recipient heartbeat/delivery wiring in lane 5 must skip group threads (no receiver_id), so group messages never issue a doomed /chat/delivered call. Add a test asserting no /chat/delivered call is made for a group message.

### R1-F4 [minor]

The presence table `chat_viewing_presence` has PK `(user_id, device_id)` and no tenant_id column. Conversation keys are `dm:<peerId>` and `group:<groupId>` where peerId/groupId are globally-unique UUIDs, so cross-tenant suppression is not a leak. But absence of tenant_id means orphaned presence rows for a member removed from a tenant (or a deleted group) are only cleaned by the 45s expiry, and cross-tenant audit/cleanup of presence rows on tenant teardown is impossible. Low risk given expiry, but a tenant_id column (or at minimum documenting expiry-only cleanup) would be safer and align with the platform's tenant-isolation convention.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:248`
- `exafyltd/vitana-platform:services/gateway/src/services/notification-service.ts:265`

Suggestion: Add a nullable tenant_id to chat_viewing_presence (populated from the viewer's tenant) so presence rows can be scoped and cleaned on tenant removal, or explicitly document that cleanup is expiry-only and why that is acceptable.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

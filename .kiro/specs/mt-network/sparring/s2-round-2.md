# Sparring round 2 — in_progress

Session: `0f65161a-d135-4939-9671-e3ef24e1d96f` · plan hash `be9ffb9a204ec551bf775ef9bcbf8fff6c66e600de850da06e4c02b5f30bb791`

## Summary

Round 2 review. All five R1 findings were accepted. I verified key premises against the pinned platform code and checked whether accepted findings were actually addressed in the revision. The v1 repo remains unreadable in this session (no pinned ref), which the planner acknowledged as a harness limitation. Two issues remain: R1-F4 was accepted but the planner's response addressed a different topic (legacy-messages reassignment) rather than the chat_groups catch-all policies, and the revised plan's M3 section doesn't explicitly call out dropping those catch-alls; separately, the writer inventory for chat_messages needs to account for a direct inline insert in orb-tools-shared.ts that bypasses the repository seam pattern.

## Findings

### R2-F1 [major]

R1-F4 was accepted but not actually addressed. R1-F4 flagged that chat_groups_service_role and chat_group_members_service_role are USING(true) catch-all policies identical to the chat_messages catch-all that messaging-send-db explicitly DROPs. The planner's R1-F4 response discussed reassigning legacy-messages-migration-db to v1, not the group catch-all policies. The revised plan's M3 network-groups-db lane says 'participant-only RLS' but does NOT explicitly state dropping these two catch-all policies. The current migration (20260525000000) already has both participant-read policies AND catch-all service-role policies coexisting — so 'participant-only RLS' could be read as adding more participant policies without removing the catch-all, leaving the D27 invite-only guarantee bypassable via service-role.

- `exafyltd/vitana-platform:supabase/migrations/20260525000000_VTID_03089_chat_groups.sql:66` — DROP POLICY IF EXISTS chat_groups_member_read ON public.chat_groups;
CREATE POLICY chat_groups_member_read ON public.chat_groups FOR SELECT USING (EXISTS (SELECT 1 FROM public.chat_group_members m WHERE m.group_id = chat_groups.id AND m.user_id = auth.uid()));
...
CREATE POLICY chat_groups_service_role ON public.chat_groups FOR ALL USING (true) WITH CHECK (true);
...
CREATE POLICY chat_group_members_service_role ON public.chat_group_members FOR ALL USING (true) WITH CHECK (true);

Suggestion: Mirror the messaging-send-db approach: the M3 network-groups-db lane must explicitly state 'DROP chat_groups_service_role and chat_group_members_service_role' and replace them with narrow policies (e.g. service-role SELECT + membership-check INSERT/UPDATE via add_group_member() DEFINER). Add a pgTAP asserting a service-role client cannot insert a chat_group_members row into an arbitrary group after the drop.

### R2-F2 [minor]

tool_send_chat_message at orb-tools-shared.ts:2676-2693 performs a direct sb.from('chat_messages').insert() that bypasses the chat-repository.ts data-access seam. This is one of at least three distinct chat_messages INSERT code paths: (1) chat-repository.ts:20-21 (used by /send route), (2) upstream-message-handler-repository.ts:20-33 (used by bridgeVoiceTranscript), and (3) this inline insert in orb-tools-shared.ts. A grep/lint for 'insertChatMessage' function calls would miss path (3). When service_role_manage_chat is dropped, this path will fail unless rerouted. The plan's messaging-send-gateway lane names 'ORB voice send' conceptually but doesn't cite this specific inline insert.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools-shared.ts:2676` — const { data: inserted, error: insErr } = await sb
  .from('chat_messages')
  .insert({
    tenant_id: tenantId,
    sender_id: id.user_id,
    receiver_id: recipientUserId,
    content: body,
    ...(senderVitanaId && { sender_vitana_id: senderVitanaId }),
    ...(recipientVitanaId && { receiver_vitana_id: recipientVitanaId }),
    metadata: { source: 'voice', ... },
  })
  .select('id')
  .single();
- `exafyltd/vitana-platform:services/gateway/src/routes/chat-repository.ts:20` — export async function insertChatMessage(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('chat_messages').insert(row).select().single();
}
- `exafyltd/vitana-platform:services/gateway/src/orb/live/session/upstream-message-handler-repository.ts:20` — export async function insertChatMessage(
  sb: SupabaseClient,
  row: { tenant_id: string; sender_id: string; receiver_id: string; content: string; message_type: string; metadata: Record<string, unknown>; created_at: string; read_at?: string; },
) {
  return sb.from('chat_messages').insert(row);
}

Suggestion: The writer-inventory lint promised in messaging-send-gateway should grep for .from('chat_messages') (not just insertChatMessage function names) to catch inline inserts like orb-tools-shared.ts:2676. Explicitly list all three known insert paths in the lane tasks so none is missed during rerouting to send_message_as().

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

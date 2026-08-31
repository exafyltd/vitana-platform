// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references orb-tools/messaging-depth-tools.ts — zero
// coverage today.
/**
 * orb-tools/messaging-depth-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in orb-tools/
 * messaging-depth-tools.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same columns,
 * same conditional-filter logic, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param) — tools receive
 * their client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAppUserTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('tenant_id').eq('user_id', userId).maybeSingle();
}

export async function fetchAppUserByIdForResolve(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('user_id, display_name, vitana_id').eq('user_id', userId).maybeSingle();
}

export async function resolveRecipientCandidatesForMessaging(sb: SupabaseClient, actorUserId: string, token: string) {
  return sb.rpc('resolve_recipient_candidates', { p_actor: actorUserId, p_token: token, p_limit: 5, p_global: true });
}

export async function fetchProfileDisplayNames(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('display_name, full_name').eq('user_id', userId).maybeSingle();
}

export async function fetchAppUserDisplayEmail(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('display_name, email').eq('user_id', userId).maybeSingle();
}

export async function fetchMyChatGroupMemberships(sb: SupabaseClient, userId: string) {
  return sb.from('chat_group_members').select('group_id').eq('user_id', userId);
}

export async function fetchChatGroupsByIds(sb: SupabaseClient, groupIds: string[]) {
  return sb.from('chat_groups').select('id, name, description, is_system, tenant_id').in('id', groupIds);
}

export async function insertGroupChatMessage(
  sb: SupabaseClient,
  payload: { tenant_id: string; sender_id: string; receiver_id: null; group_id: string; content: string; message_type: string; metadata: Record<string, unknown> },
) {
  return sb.from('chat_messages').insert(payload).select('id').single();
}

export async function fetchChatGroupMemberIds(sb: SupabaseClient, groupId: string) {
  return sb.from('chat_group_members').select('user_id').eq('group_id', groupId);
}

export async function fetchChatMessageForReaction(sb: SupabaseClient, messageId: string) {
  return sb.from('chat_messages').select('id, sender_id, receiver_id, group_id').eq('id', messageId).maybeSingle();
}

export async function fetchChatGroupMembership(sb: SupabaseClient, groupId: string, userId: string) {
  return sb.from('chat_group_members').select('user_id').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
}

export function deleteMessageReaction(
  sb: SupabaseClient,
  messageId: string,
  userId: string,
  emoji: string,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', userId).eq('emoji', emoji);
}

export function insertMessageReaction(
  sb: SupabaseClient,
  messageId: string,
  userId: string,
  emoji: string,
): PromiseLike<{ error: { message: string; code?: string } | null }> {
  return sb.from('message_reactions').insert({ message_id: messageId, user_id: userId, emoji });
}

export async function insertChatGroup(
  sb: SupabaseClient,
  payload: { tenant_id: string; name: string; description: string | null; created_by: string; is_system: boolean; metadata: Record<string, unknown> },
) {
  return sb.from('chat_groups').insert(payload).select('id, name').single();
}

/** Shared insert shape for creator (role:'admin'), create_group_chat's own
 * member fanout, and add_group_chat_member (role:'member'). */
export function insertChatGroupMember(
  sb: SupabaseClient,
  groupId: string,
  userId: string,
  tenantId: string,
  role: string,
): PromiseLike<{ error: { message: string; code?: string } | null }> {
  return sb.from('chat_group_members').insert({ group_id: groupId, user_id: userId, tenant_id: tenantId, role });
}

export function deleteChatGroupMembership(sb: SupabaseClient, groupId: string, userId: string): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('chat_group_members').delete().eq('group_id', groupId).eq('user_id', userId);
}

const CALENDAR_EVENT_COLS = 'id, title, start_time, end_time, location';

export async function fetchMyCalendarEventById(sb: SupabaseClient, eventId: string, userId: string) {
  return sb.from('calendar_events').select(CALENDAR_EVENT_COLS).eq('id', eventId).eq('user_id', userId).neq('status', 'cancelled').maybeSingle();
}

export async function searchMyCalendarEventsByTitle(sb: SupabaseClient, userId: string, query: string) {
  return sb
    .from('calendar_events')
    .select(CALENDAR_EVENT_COLS)
    .eq('user_id', userId)
    .neq('status', 'cancelled')
    .gte('start_time', new Date().toISOString())
    .ilike('title', `%${query}%`)
    .order('start_time', { ascending: true })
    .limit(5);
}

export function insertCalendarInviteChatMessage(
  sb: SupabaseClient,
  payload: {
    tenant_id: string;
    sender_id: string;
    receiver_id: string;
    content: string;
    message_type: string;
    metadata: Record<string, unknown>;
  },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('chat_messages').insert(payload);
}

export function insertCallInviteChatMessage(
  sb: SupabaseClient,
  payload: { tenant_id: string; sender_id: string; receiver_id: string; content: string; message_type: string; metadata: Record<string, unknown> },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('chat_messages').insert(payload);
}

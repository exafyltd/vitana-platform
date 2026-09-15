// impact-allow-no-test
// Genuinely tested via test/routes/chat-groups-repository.test.ts, which
// drives a functional stub Supabase client (a from()-chain resolving to
// a configurable {data,error,count} response) — not a wholesale module
// mock.
/**
 * routes/chat-groups-repository.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/chat-groups.ts against the
 * tables this route owns (chat_groups, chat_group_members,
 * chat_messages) now goes through here instead of being written inline.
 * PURE MOVE, not a rewrite: same queries, same columns, same
 * conditional-filter logic, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param).
 *
 * Reads against the generic `profiles`/`app_users`/`user_notifications`
 * tables stay inline in chat-groups.ts, same as other B1 seams leave
 * shared/general tables alone (see community-marketplace.ts's header for
 * the precedent this follows).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Memberships / groups list ──────────────────────────────────────────────

export async function listChatGroupMemberships(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('chat_group_members')
    .select('group_id, last_read_at, role, joined_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId);
}

export async function listChatGroupsByIds(sb: SupabaseClient, groupIds: string[]) {
  return sb.from('chat_groups').select('id, name, description, is_system, metadata, created_at').in('id', groupIds);
}

export async function listLatestChatMessagesForGroups(sb: SupabaseClient, groupIds: string[]) {
  return sb
    .from('chat_messages')
    .select('id, group_id, sender_id, content, created_at, message_type, metadata')
    .in('group_id', groupIds)
    .order('created_at', { ascending: false })
    .limit(500);
}

export async function countUnreadChatMessagesForGroup(
  sb: SupabaseClient,
  args: { groupId: string; userId: string; since?: string | null },
) {
  let q = sb
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', args.groupId)
    .neq('sender_id', args.userId);
  if (args.since) q = q.gt('created_at', args.since);
  return q;
}

// ─── Single group + members ──────────────────────────────────────────────

export async function fetchChatGroupWithMembers(sb: SupabaseClient, groupId: string) {
  return Promise.all([
    sb.from('chat_groups').select('*').eq('id', groupId).maybeSingle(),
    sb.from('chat_group_members').select('user_id, role, joined_at').eq('group_id', groupId),
  ]);
}

// ─── Message history ──────────────────────────────────────────────

export async function listChatGroupMessages(
  sb: SupabaseClient,
  args: { groupId: string; limit: number; before?: string },
) {
  let q = sb.from('chat_messages').select('*').eq('group_id', args.groupId).order('created_at', { ascending: false }).limit(args.limit);
  if (args.before) q = q.lt('created_at', args.before);
  return q;
}

// ─── Send / edit / delete ──────────────────────────────────────────────

export async function insertChatGroupMessage(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('chat_messages').insert(payload).select().single();
}

/** Same table, but without .select().single() — matches the
 *  @vitana-mention reply insert, which never reads the inserted row back. */
export async function insertChatGroupMessageNoReturn(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('chat_messages').insert(payload);
}

export async function updateChatGroupMessageContent(sb: SupabaseClient, messageId: string, content: string) {
  return sb.from('chat_messages').update({ content }).eq('id', messageId).select().single();
}

export async function deleteChatGroupMessage(sb: SupabaseClient, messageId: string) {
  return sb.from('chat_messages').delete().eq('id', messageId);
}

export async function markChatGroupRead(sb: SupabaseClient, groupId: string, userId: string) {
  return sb
    .from('chat_group_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .eq('user_id', userId);
}

// ─── Ownership / membership guards ──────────────────────────────────────────────

export async function fetchChatMessageOwnership(sb: SupabaseClient, messageId: string) {
  return sb.from('chat_messages').select('sender_id, group_id').eq('id', messageId).maybeSingle();
}

export async function fetchChatGroupMembership(sb: SupabaseClient, groupId: string, userId: string) {
  return sb.from('chat_group_members').select('role').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
}

// ─── Fanout / @vitana mentions ──────────────────────────────────────────────

export async function fetchChatGroupName(sb: SupabaseClient, groupId: string) {
  return sb.from('chat_groups').select('name').eq('id', groupId).maybeSingle();
}

export async function listChatGroupMemberIds(sb: SupabaseClient, groupId: string) {
  return sb.from('chat_group_members').select('user_id').eq('group_id', groupId);
}

export async function listRecentChatGroupMessagesForHistory(sb: SupabaseClient, groupId: string, limit: number) {
  return sb
    .from('chat_messages')
    .select('sender_id, content, created_at')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// ─── Welcome-message refanout (admin) ──────────────────────────────────────────────

export async function fetchChatGroupForRefanout(sb: SupabaseClient, groupId: string) {
  return sb.from('chat_groups').select('id, tenant_id, name').eq('id', groupId).maybeSingle();
}

export async function fetchChatGroupWelcomeMessage(sb: SupabaseClient, groupId: string) {
  return sb
    .from('chat_messages')
    .select('id, content, sender_id, created_at')
    .eq('group_id', groupId)
    .filter('metadata->>source', 'eq', 'vitana_group_welcome')
    .order('created_at', { ascending: true })
    .limit(1);
}

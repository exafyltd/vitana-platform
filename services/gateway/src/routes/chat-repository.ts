// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior); exercised
// indirectly by routes/chat.ts's existing test suite
// (test/chat-vitana-reply.test.ts), which mocks @supabase/supabase-js's
// createClient with a stateful chainable fake, not this module.
/**
 * routes/chat.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in this file now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries/RPC names, same columns, same conditional-
 * filter logic, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertChatMessage(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('chat_messages').insert(row).select().single();
}

export async function fetchSenderProfile(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('display_name, email').eq('user_id', userId).maybeSingle();
}

export async function fetchConversationMessages(
  sb: SupabaseClient,
  tenantId: string | null,
  userId: string,
  peerId: string,
  limit: number,
  before: string | undefined,
) {
  let query = sb
    .from('chat_messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(`and(sender_id.eq.${userId},receiver_id.eq.${peerId}),and(sender_id.eq.${peerId},receiver_id.eq.${userId})`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt('created_at', before);
  }

  return query;
}

export async function getRecentConversationsRpc(sb: SupabaseClient, params: { p_user_id: string; p_tenant_id: string | null; p_limit: number }) {
  return sb.rpc('get_recent_conversations', params);
}

export async function fetchConversationsFallback(sb: SupabaseClient, tenantId: string | null, userId: string, limit: number) {
  return sb
    .from('chat_messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    // DM rows only — mirrors the RPC. Group messages share this table with
    // receiver_id NULL + group_id set, and would dedup to a peer_id of
    // `undefined`, producing an inbox entry with no peer.
    .not('receiver_id', 'is', null)
    .is('group_id', null)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function markPeerMessagesRead(sb: SupabaseClient, tenantId: string | null, peerId: string, userId: string) {
  return sb.from('chat_messages').update({ read_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('sender_id', peerId).eq('receiver_id', userId).is('read_at', null);
}

export async function markAllMessagesRead(sb: SupabaseClient, tenantId: string | null, userId: string) {
  return sb.from('chat_messages').update({ read_at: new Date().toISOString() }, { count: 'exact' }).eq('tenant_id', tenantId).eq('receiver_id', userId).is('read_at', null);
}

export async function countUnreadMessages(sb: SupabaseClient, tenantId: string | null, userId: string) {
  return sb.from('chat_messages').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('receiver_id', userId).is('read_at', null);
}

export async function fetchVitanaDmHistoryRows(sb: SupabaseClient, tenantId: string, userId: string, botUserId: string, limit: number) {
  return sb
    .from('chat_messages')
    .select('sender_id, content, created_at')
    .eq('tenant_id', tenantId)
    .or(`and(sender_id.eq.${userId},receiver_id.eq.${botUserId}),and(sender_id.eq.${botUserId},receiver_id.eq.${userId})`)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export function insertVitanaReplyMessage(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: { message?: string } | null }> {
  return sb.from('chat_messages').insert(row);
}

/**
 * orb-tools/chat-privacy-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in orb-tools/chat-privacy-
 * tools.ts now goes through here instead of being written inline. PURE
 * MOVE, not a rewrite: same queries, same columns, same conditional-filter
 * logic, same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param) — tools receive their client per-call, not a
 * module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== app_users ====================

export async function fetchTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('tenant_id').eq('user_id', userId).maybeSingle();
}

export async function fetchAppUserById(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('user_id, display_name, vitana_id').eq('user_id', userId).maybeSingle();
}

export async function fetchAppUsersByIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, display_name, vitana_id').in('user_id', userIds);
}

// ==================== RPC: resolve_recipient_candidates ====================

export async function rpcResolveRecipientCandidates(sb: SupabaseClient, actor: string, token: string, limit: number) {
  return sb.rpc('resolve_recipient_candidates', { p_actor: actor, p_token: token, p_limit: limit, p_global: true });
}

// ==================== chat_messages ====================

export async function fetchLastMessageBetween(sb: SupabaseClient, tenantId: string, userIdA: string, userIdB: string) {
  return sb
    .from('chat_messages')
    .select('id, content, created_at')
    .eq('tenant_id', tenantId)
    .or(`and(sender_id.eq.${userIdA},receiver_id.eq.${userIdB}),and(sender_id.eq.${userIdB},receiver_id.eq.${userIdA})`)
    .order('created_at', { ascending: false })
    .limit(1);
}

export async function markAllReceivedMessagesRead(sb: SupabaseClient, tenantId: string, receiverId: string, nowIso: string) {
  return sb
    .from('chat_messages')
    .update({ read_at: nowIso }, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('receiver_id', receiverId)
    .is('read_at', null);
}

export async function markPeerMessagesRead(sb: SupabaseClient, tenantId: string, senderId: string, receiverId: string, nowIso: string) {
  return sb
    .from('chat_messages')
    .update({ read_at: nowIso }, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('sender_id', senderId)
    .eq('receiver_id', receiverId)
    .is('read_at', null);
}

// ==================== profiles (account_visibility) ====================

export async function fetchAccountVisibility(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('account_visibility').eq('user_id', userId).maybeSingle();
}

export async function updateAccountVisibility(sb: SupabaseClient, userId: string, accountVisibility: Record<string, unknown>) {
  return sb.from('profiles').update({ account_visibility: accountVisibility }).eq('user_id', userId);
}

// ==================== user_blocked_authors ====================

export async function upsertBlockedAuthor(sb: SupabaseClient, userId: string, authorId: string) {
  return sb
    .from('user_blocked_authors')
    .upsert({ user_id: userId, author_id: authorId }, { onConflict: 'user_id,author_id' });
}

export async function fetchBlockedAuthorIds(sb: SupabaseClient, userId: string) {
  return sb.from('user_blocked_authors').select('author_id').eq('user_id', userId).limit(500);
}

export async function deleteBlockedAuthor(sb: SupabaseClient, userId: string, authorId: string) {
  return sb.from('user_blocked_authors').delete().eq('user_id', userId).eq('author_id', authorId);
}

// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references welcome-chat-service.ts — zero coverage today.
/**
 * services/welcome-chat-service.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in welcome-chat-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAppUserWelcomeChatSent(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('welcome_chat_sent').eq('user_id', userId).single();
}

export async function countTenantMembersExcluding(sb: SupabaseClient, tenantId: string, excludeUserId: string, botUserId: string) {
  return sb
    .from('user_tenants')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .neq('user_id', excludeUserId)
    .neq('user_id', botUserId);
}

export async function fetchTenantMemberIdsExcluding(
  sb: SupabaseClient,
  tenantId: string,
  excludeUserId: string,
  botUserId: string,
  limit: number,
) {
  return sb
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .neq('user_id', excludeUserId)
    .neq('user_id', botUserId)
    .limit(limit);
}

export async function insertWelcomeChatMessagesBatch(sb: SupabaseClient, batch: unknown[]) {
  return sb.from('chat_messages').insert(batch as any);
}

export async function markAppUserWelcomeChatSent(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').update({ welcome_chat_sent: true } as any).eq('user_id', userId);
}

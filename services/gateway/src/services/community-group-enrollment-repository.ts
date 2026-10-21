// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references community-group-enrollment.ts — zero coverage
// today.
/**
 * services/community-group-enrollment.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in community-group-enrollment.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchSystemChatGroups(sb: SupabaseClient, tenantId: string) {
  return sb.from('chat_groups').select('id, name, metadata').eq('tenant_id', tenantId).eq('is_system', true);
}

export async function fetchExistingGroupMembership(sb: SupabaseClient, groupId: string, userId: string) {
  return sb.from('chat_group_members').select('user_id').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
}

export async function countGroupMembers(sb: SupabaseClient, groupId: string) {
  return sb.from('chat_group_members').select('user_id', { count: 'exact', head: true }).eq('group_id', groupId);
}

export async function insertGroupMembership(
  sb: SupabaseClient,
  row: { group_id: string; user_id: string; tenant_id: string; role: string },
) {
  return sb.from('chat_group_members').insert(row);
}

// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note:
// no test file references routes/topics.ts — zero coverage today.
/**
 * routes/topics.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in routes/topics.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * RPCs, same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function validateTopicKeysRpc(sb: SupabaseClient, topicKeys: string[]) {
  return sb.rpc('topics_validate_keys', { p_topic_keys: topicKeys });
}

export async function recomputeUserTopicProfileRpc(sb: SupabaseClient, userId: string | null, date: string | null) {
  return sb.rpc('topics_recompute_user_profile', { p_user_id: userId, p_date: date });
}

export async function fetchUserTopicProfileRpc(sb: SupabaseClient, userId: string | null) {
  return sb.rpc('topics_get_user_profile', { p_user_id: userId });
}

export async function createTopicsRegistryEntryRpc(sb: SupabaseClient, entry: unknown) {
  return sb.rpc('topics_create_registry_entry', { p_payload: entry });
}

export async function fetchTopicsRegistryRpc(sb: SupabaseClient, category: string | null) {
  return sb.rpc('topics_get_registry', { p_category: category });
}

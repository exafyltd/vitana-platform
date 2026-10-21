// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// no test file references capabilities/index.ts — zero coverage today.
/**
 * capabilities/index.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in capabilities/index.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveSocialConnectionProviders(sb: SupabaseClient, userId: string) {
  return sb.from('social_connections').select('provider').eq('user_id', userId).eq('is_active', true);
}

export async function fetchUserCapabilityPreference(sb: SupabaseClient, userId: string, capabilityId: string) {
  return sb
    .from('user_capability_preferences')
    .select('preferred_connector_id, set_method')
    .eq('user_id', userId)
    .eq('capability_id', capabilityId)
    .maybeSingle();
}

export async function insertCapabilityPlayLog(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('capability_play_log').insert(row);
}

export async function countUserCapabilityPreferences(sb: SupabaseClient, userId: string, capabilityId: string) {
  return sb
    .from('user_capability_preferences')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('capability_id', capabilityId);
}

export async function fetchRecentSuccessfulCapabilityPlays(sb: SupabaseClient, userId: string, capabilityId: string, limit: number) {
  return sb
    .from('capability_play_log')
    .select('connector_id')
    .eq('user_id', userId)
    .eq('capability_id', capabilityId)
    .eq('ok', true)
    .order('created_at', { ascending: false })
    .limit(limit);
}

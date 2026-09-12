// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/capabilities.ts — zero coverage today.
/**
 * routes/capabilities.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in capabilities.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveSocialConnectionsForUser(sb: SupabaseClient, userId: string) {
  return sb
    .from('social_connections')
    .select('provider, provider_username, connected_at')
    .eq('user_id', userId)
    .eq('is_active', true);
}

export async function fetchUserCapabilityPreferences(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_capability_preferences')
    .select('capability_id, preferred_connector_id, set_method, updated_at')
    .eq('user_id', userId);
}

export async function upsertUserCapabilityPreference(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb
    .from('user_capability_preferences')
    .upsert(row, { onConflict: 'tenant_id,user_id,capability_id' })
    .select('capability_id, preferred_connector_id, set_method, updated_at')
    .single();
}

export async function deleteUserCapabilityPreference(sb: SupabaseClient, userId: string, capabilityId: string) {
  return sb.from('user_capability_preferences').delete().eq('user_id', userId).eq('capability_id', capabilityId);
}

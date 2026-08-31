// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/profile-prefs.ts — zero coverage today.
/**
 * routes/profile-prefs.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in profile-prefs.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * `updateProfileColumn` selects a dynamic column name — typed loosely
 * (`Promise<{ data: any; error: any }>`) to preserve that, matching
 * the established pattern for dynamic-select-string call sites
 * elsewhere in this sweep (e.g. automation-executor-repository.ts's
 * fetchUsersByRole).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function updateProfileColumn(
  sb: SupabaseClient,
  column: string,
  payload: unknown,
  userId: string,
): Promise<{ data: any; error: any }> {
  return sb.from('profiles').update({ [column]: payload }).eq('user_id', userId).select(column).single();
}

export async function fetchOwnProfilePrefs(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('partner_preferences, service_offerings, account_visibility').eq('user_id', userId).single();
}

export async function fetchProfilePrefsByVitanaId(sb: SupabaseClient, vitanaId: string) {
  return sb
    .from('profiles')
    .select('user_id, partner_preferences, service_offerings, account_visibility')
    .eq('vitana_id', vitanaId)
    .maybeSingle();
}

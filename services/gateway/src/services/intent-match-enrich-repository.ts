// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: NO
// test file in this repo references this module.
/**
 * services/intent-match-enrich.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-match-enrich.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — the source file still owns creating the client via its own
 * getSupabase() and passes it in, exactly as before.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchIntentOwners(sb: SupabaseClient, intentIds: string[]) {
  return sb.from('user_intents').select('intent_id, requester_user_id').in('intent_id', intentIds);
}

export async function fetchCounterpartyIntentFields(sb: SupabaseClient, intentIds: string[]) {
  return sb.from('user_intents').select('intent_id, title, scope, intent_kind, status, cover_url').in('intent_id', intentIds);
}

export async function fetchCounterpartyProfiles(sb: SupabaseClient, vitanaIds: string[]) {
  return sb
    .from('profiles')
    .select('user_id, vitana_id, display_name, full_name, avatar_url, gender, date_of_birth')
    .in('vitana_id', vitanaIds);
}

export async function fetchCommunityProfileVisibility(sb: SupabaseClient, userIds: string[]) {
  return sb.from('global_community_profiles').select('user_id, is_visible').in('user_id', userIds);
}

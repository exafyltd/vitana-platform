// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior); exercised
// indirectly by community-regeneration.ts's existing test suite
// (test/services/recommendation-engine/community-regeneration.test.ts),
// which mocks @supabase/supabase-js's createClient (not this module).
/**
 * services/recommendation-engine/community-regeneration.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in community-regeneration.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAutopilotOptOutFact(sb: SupabaseClient, userId: string) {
  return sb
    .from('memory_facts')
    .select('fact_value')
    .eq('user_id', userId)
    .eq('fact_key', 'autopilot_opt_out')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchPrimaryTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).maybeSingle();
}

export async function fetchTenantAutopilotSettings(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_autopilot_settings').select('enabled, max_recommendations_per_day').eq('tenant_id', tenantId).maybeSingle();
}

export async function countActiveAutopilotRecommendations(sb: SupabaseClient, userId: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['new', 'activated']);
}

export async function countRecentAutopilotRecommendations(sb: SupabaseClient, userId: string, since: string) {
  return sb.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since);
}

export async function countTodayAutopilotRecommendations(sb: SupabaseClient, userId: string, startOfDayIso: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', startOfDayIso);
}

// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior); exercised
// indirectly by routes/autopilot-recommendations.ts's existing test
// suites (test/routes/autopilot-recommendations*.test.ts), which mock
// @supabase/supabase-js's createClient, not this module.
/**
 * routes/autopilot-recommendations.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Reused across the auto-replenish, manual-generate, activate-notify, and
 * complete-milestone call sites — null-tolerant (maybeSingle). */
export async function fetchPrimaryTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).maybeSingle();
}

/** Same query as fetchPrimaryTenantId but strict (single) — used only by
 * the post-generate notification path, which throws rather than
 * null-tolerating a missing tenant row. */
export async function fetchPrimaryTenantIdStrict(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).single();
}

export async function fetchHighImpactRecentRecommendation(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id, title, summary, impact_score')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .gte('impact_score', 8)
    .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .order('impact_score', { ascending: false })
    .limit(1);
}

export async function fetchRemainingOnboardingRecommendations(sb: SupabaseClient, userId: string) {
  return sb.from('autopilot_recommendations').select('id').eq('user_id', userId).eq('status', 'activated').like('source_ref', 'onboarding_%');
}

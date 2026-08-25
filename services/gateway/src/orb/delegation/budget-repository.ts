// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references orb/delegation/budget.ts — zero coverage today.
/**
 * orb/delegation/budget.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in budget.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAiProviderPolicyCap(sb: SupabaseClient, tenantId: string, providerId: string) {
  return sb.from('ai_provider_policies').select('cost_cap_usd_month').eq('tenant_id', tenantId).eq('provider', providerId).maybeSingle();
}

export async function fetchMonthlySpendByUserProvider(sb: SupabaseClient, userId: string, providerId: string) {
  return sb
    .from('ai_usage_month_by_user_provider')
    .select('total_cost_usd')
    .eq('user_id', userId)
    .eq('provider', providerId)
    .maybeSingle();
}

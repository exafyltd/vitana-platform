// Genuinely tested via test/services/admin-scanners/autopilot-health.test.ts,
// which drives a real functional fake SupabaseClient (order-based
// query-chain builder), not a wholesale module mock.
/**
 * services/admin-scanners/autopilot-health.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/autopilot-health.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes, same call
 * order — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countCompletedAutopilotRuns(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb.from('tenant_autopilot_runs').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'completed').gte('started_at', sinceIso);
}

export async function countFailedAutopilotRuns(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb.from('tenant_autopilot_runs').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'failed').gte('started_at', sinceIso);
}

export async function countSelfHealingPendingBacklog(sb: SupabaseClient) {
  return sb.from('self_healing_log').select('id', { count: 'exact', head: true }).eq('outcome', 'pending').lt('confidence', 0.8);
}

export async function countNewAutopilotRecommendations(sb: SupabaseClient) {
  return sb.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('status', 'new');
}

export async function countActivatedRecommendationsSince(sb: SupabaseClient, sinceIso: string) {
  return sb.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('status', 'activated').gte('updated_at', sinceIso);
}

export async function countActivatedRecommendationsBetween(sb: SupabaseClient, sinceIso: string, untilIso: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'activated')
    .gte('updated_at', sinceIso)
    .lt('updated_at', untilIso);
}

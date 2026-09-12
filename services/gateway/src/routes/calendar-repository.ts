// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/calendar.ts — zero coverage today.
/**
 * routes/calendar.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in calendar.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same calls, same params, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchVitanaIndexScoresForUserDate(sb: SupabaseClient, userId: string, date: string) {
  return sb
    .from('vitana_index_scores')
    .select('score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle();
}

export async function healthComputeVitanaIndexForUserRpc(
  sb: SupabaseClient,
  args: { p_user_id: string; p_date: string; p_model_version: string },
) {
  return sb.rpc('health_compute_vitana_index_for_user', args);
}

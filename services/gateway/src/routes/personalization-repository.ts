// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/personalization.ts — zero coverage
// today.
/**
 * routes/personalization.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in personalization.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same calls, same params, same columns, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchMeContext(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

export async function fetchVitanaIndexScoresForDate(sb: SupabaseClient, date: string) {
  return sb
    .from('vitana_index_scores')
    .select('score_total, score_physical, score_mental, score_nutritional, score_social, score_environmental')
    .eq('date', date)
    .single();
}

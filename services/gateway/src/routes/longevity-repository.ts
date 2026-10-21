// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/longevity.ts — zero coverage today.
/**
 * routes/longevity.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in longevity.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * calls, same params, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchMeContext(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

export async function computeLongevityDaily(sb: SupabaseClient, date: string) {
  return sb.rpc('longevity_compute_daily', {
    p_user_id: null, // Use current user from auth context
    p_date: date,
  });
}

export async function fetchLongevityDaily(sb: SupabaseClient, fromDate: string, toDate: string | null) {
  return sb.rpc('longevity_get_daily', {
    p_from: fromDate,
    p_to: toDate,
  });
}

export async function explainLongevityDaily(sb: SupabaseClient, date: string) {
  return sb.rpc('longevity_explain_daily', { p_date: date });
}

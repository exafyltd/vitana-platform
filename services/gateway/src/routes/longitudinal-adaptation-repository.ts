// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/longitudinal-adaptation.ts — zero
// coverage today.
/**
 * routes/longitudinal-adaptation.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.rpc(...)` call in longitudinal-adaptation.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchMeContext(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

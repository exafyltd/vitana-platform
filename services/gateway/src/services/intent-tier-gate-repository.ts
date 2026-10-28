// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references intent-tier-gate.ts — zero coverage today.
/**
 * services/intent-tier-gate.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in intent-tier-gate.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchProfileVitanaIdLocked(sb: SupabaseClient, userId: string) {
  return sb
    .from('profiles')
    .select('vitana_id_locked')
    .eq('user_id', userId)
    .maybeSingle();
}

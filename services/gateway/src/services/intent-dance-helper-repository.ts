// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references intent-dance-helper.ts — zero coverage today.
/**
 * services/intent-dance-helper.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in intent-dance-helper.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchProfileDancePreferences(sb: SupabaseClient, userId: string) {
  return sb
    .from('profiles')
    .select('dance_preferences')
    .eq('user_id', userId)
    .maybeSingle();
}

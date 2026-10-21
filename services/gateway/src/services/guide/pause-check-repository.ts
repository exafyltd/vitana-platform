/**
 * guide/pause-check.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The Supabase `.from(...)` call in pause-check.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same query,
 * same columns, same filters/ordering, same return shape — no behavior
 * change today. Client-agnostic (takes `supabase` as a param), same
 * convention as every other *-repository.ts in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_proactive_pause ====================

export async function fetchActivePauses(supabase: SupabaseClient, userId: string, nowIso: string) {
  return supabase
    .from('user_proactive_pause')
    .select('*')
    .eq('user_id', userId)
    .gt('paused_until', nowIso)
    .order('created_at', { ascending: false });
}

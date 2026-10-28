// Genuinely tested via test/orb-tools/memory-diary-social-tools.test.ts,
// which drives a real functional fake SupabaseClient (query-chain
// builder), not a wholesale module mock.
/**
 * orb-tools/memory-diary-social-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/memory-diary-social-tools.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchCompletedMilestones(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('autopilot_recommendations')
    .select('source_ref, title, summary, impact_score, created_at')
    .eq('user_id', userId)
    .eq('source_type', 'milestone')
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit);
}

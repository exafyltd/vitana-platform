// Genuine coverage: test/services/assistant-continuation/providers/next-action/autopilot-recommendation.test.ts
// passes a hand-built functional fake client directly (no jest.mock())
// — real coverage, not a mock.
/**
 * services/assistant-continuation/providers/next-action/sources/autopilot-recommendation.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md
 * Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in autopilot-recommendation.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same query, same columns, same filter/order logic,
 * same return shape — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTopAutopilotRecommendation(sb: SupabaseClient, userId: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id, title, summary, confidence, last_seen_at, created_at, domain')
    .eq('user_id', userId)
    .eq('status', 'new')
    // Drop milestone celebrations — those have their own surface.
    .neq('source_type', 'milestone')
    .order('confidence', { ascending: false, nullsFirst: false })
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1);
}

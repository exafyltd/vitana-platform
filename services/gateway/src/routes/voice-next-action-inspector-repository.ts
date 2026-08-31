// Genuine coverage: test/routes/voice-next-action-inspector.test.ts mocks
// only getSupabase() (via jest.mock('../../src/lib/supabase', ...)), not
// this module — a real functional fake client, not a wholesale mock.
/**
 * routes/voice-next-action-inspector.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in voice-next-action-inspector.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same query, same columns, same filter logic, same
 * return shape — no behavior change today. Client-agnostic (takes `sb`
 * as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchNextActionOasisEvents(
  sb: SupabaseClient,
  topics: string[],
  userId: string,
  sinceIso: string,
  limit: number,
) {
  return sb
    .from('oasis_events')
    .select('id, topic, created_at, payload, actor_id')
    .in('topic', topics)
    .eq('actor_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}

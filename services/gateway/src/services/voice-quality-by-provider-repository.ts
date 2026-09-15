// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note:
// test/routes/voice-improve.test.ts wholesale jest.mock()s this module
// — zero genuine coverage today.
/**
 * services/voice-quality-by-provider.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in voice-quality-by-provider.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same query, same columns, same filter logic, same
 * return shape — no behavior change today. Client-agnostic (takes `sb`
 * as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLiveSessionEndOasisEvents(sb: SupabaseClient, sinceIso: string, limit: number) {
  return sb
    .from('oasis_events')
    .select('topic, metadata, occurred_at')
    .in('topic', ['vtid.live.session.stop', 'voice.live.session.ended'])
    .gte('occurred_at', sinceIso)
    .order('occurred_at', { ascending: false })
    .limit(limit);
}

// Genuine coverage: test/routes/screen-load-health.test.ts mocks only
// getSupabase() (via jest.mock('../../src/lib/supabase', ...)), not
// this module — a real functional fake client, not a wholesale mock.
/**
 * routes/screen-load-health.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in screen-load-health.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchRecentScreenLoadHealthEvents(sb: SupabaseClient, topic: string, sinceIso: string) {
  return sb
    .from('oasis_events')
    .select('created_at, metadata')
    .eq('topic', topic)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(200);
}

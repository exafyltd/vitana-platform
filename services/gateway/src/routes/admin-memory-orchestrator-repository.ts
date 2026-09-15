// Genuine coverage: test/admin-memory-orchestrator.test.ts mocks only
// getSupabase() (via jest.mock('../src/lib/supabase', ...)), not this
// module — a real functional fake client, not a wholesale mock.
/**
 * routes/admin-memory-orchestrator.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in admin-memory-orchestrator.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same query, same columns, same filter logic, same
 * return shape — no behavior change today. Client-agnostic (takes `sb`
 * as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchMemoryOrchestratorEvents(sb: SupabaseClient, topics: string[], sinceIso: string) {
  return sb
    .from('oasis_events')
    .select('topic, status, metadata, created_at')
    .in('topic', topics)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1000);
}

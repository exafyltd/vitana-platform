// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/routes/conversation-hub.test.ts deliberately forces
// getSupabase() => null so all DB-backed endpoints take their 503
// branch — the actual .from() calls this file owns are never exercised
// — zero genuine coverage today.
/**
 * routes/conversation-hub.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in conversation-hub.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchOasisEventsByStage(sb: SupabaseClient, stage: string, sinceIso: string, limit: number) {
  return sb
    .from('oasis_events')
    .select('created_at, metadata')
    .eq('topic', 'orb.live.diag')
    .eq('metadata->>stage', stage)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}

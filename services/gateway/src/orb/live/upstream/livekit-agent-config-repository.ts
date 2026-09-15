// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note:
// test/orb/live/upstream/livekit-agent-config.test.ts sets
// SUPABASE_URL=http://localhost:54321 (test/__mocks__/setup-tests.ts),
// so getSupabase() returns a real (non-null) client whose query always
// fails against that unreachable host — every test only exercises the
// catch-and-degrade-to-defaults path, never the query shape itself.
// Zero genuine coverage of this specific call today (same shape as the
// sibling livekit-canary-config-repository.ts).
/**
 * orb/live/upstream/livekit-agent-config.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in livekit-agent-config.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLiveKitAgentSystemConfig(sb: SupabaseClient, agentEnabledKey: string) {
  return sb
    .from('system_config')
    .select('key, value')
    .eq('key', agentEnabledKey)
    .maybeSingle();
}

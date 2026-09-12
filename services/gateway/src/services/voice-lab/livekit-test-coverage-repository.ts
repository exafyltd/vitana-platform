// Genuinely tested via test/services/voice-lab/livekit-test-coverage.test.ts
// (only getSupabase is mocked, not this module) — not a wholesale
// module mock.
/**
 * services/voice-lab/livekit-test-coverage.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in livekit-test-coverage.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filters, same return shape —
 * no behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchEnabledLivekitTestCaseExpectations(sb: SupabaseClient) {
  return sb.from('livekit_test_cases').select('expected, enabled').eq('enabled', true);
}

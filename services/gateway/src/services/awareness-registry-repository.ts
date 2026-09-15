// Genuine coverage: test/services/awareness-registry.test.ts mocks
// createClient() from @supabase/supabase-js at the module boundary (not
// this module or awareness-registry.ts) and asserts on select()
// call/resolve behavior — a real functional fake client, not a
// wholesale mock of the code under test.
/**
 * services/awareness-registry.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in awareness-registry.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAwarenessConfigOverrides(sb: SupabaseClient) {
  return sb.from('awareness_config').select('key, enabled, params');
}

// Genuine coverage: test/routes/autopilot-prompts.test.ts mocks
// createUserSupabaseClient() at the module boundary (via
// jest.mock('../../src/lib/supabase-user', ...)), not this module, and
// has dedicated tests for the me_context RPC (success, error fallback,
// missing user_id) — a real functional fake client, not a wholesale
// mock of the code under test.
/**
 * routes/autopilot-prompts.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.rpc(...)` call in autopilot-prompts.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchMeContext(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

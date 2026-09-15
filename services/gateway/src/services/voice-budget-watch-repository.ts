// Coverage note: test/services/voice-budget-watch.test.ts asserts this
// exact RPC call directly against an injected mock client (not a
// wholesale mock of this repository module), so this wrapper gets
// genuine coverage, not a documented zero.
/**
 * services/voice-budget-watch.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.rpc(...)` call in voice-budget-watch.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC name, same params, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function execSqlRpc(sb: SupabaseClient, query: string, params: unknown[]) {
  return sb.rpc('exec_sql', { query, params });
}

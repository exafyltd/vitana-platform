// Coverage note: test/system-controls.test.ts exercises this module by
// passing a hand-built functional fake Supabase client directly to
// getSystemControl (no jest.mock of this repository module), so this
// wrapper gets genuine coverage, not a documented zero.
/**
 * services/system-controls.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in system-controls.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchSystemControlByKey(sb: SupabaseClient, key: string) {
  return sb.from('system_controls').select('*').eq('key', key).single();
}

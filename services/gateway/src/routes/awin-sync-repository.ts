// impact-allow-no-test: pure data-access seam (thin Supabase insert
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/awin-sync.ts — zero coverage today.
/**
 * routes/awin-sync.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/awin-sync.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same inserts, same columns, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertAwinSyncOasisEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('oasis_events').insert(row);
}

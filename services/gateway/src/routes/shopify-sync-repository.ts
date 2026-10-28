// impact-allow-no-test: pure data-access seam (thin Supabase insert
// wrapper, no independent request-handling behavior). Coverage note:
// test/routes/shopify-sync.test.ts only exercises pure helper functions
// from services/shopify-sync.ts, not this route handler — zero coverage
// today.
/**
 * routes/shopify-sync.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in routes/shopify-sync.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same insert, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertShopifySyncOasisEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('oasis_events').insert(row);
}

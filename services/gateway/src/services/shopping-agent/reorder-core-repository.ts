// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references shopping-agent/reorder-core.ts — zero coverage
// today.
/**
 * services/shopping-agent/reorder-core.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in reorder-core.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchProductsByIds(
  sb: SupabaseClient,
  columns: string,
  ids: string[],
): Promise<{ data: any; error: any }> {
  return sb.from('products').select(columns).in('id', ids);
}

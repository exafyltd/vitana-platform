// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/recommendation-inbox.ts — zero coverage
// today.
/**
 * routes/recommendation-inbox.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in recommendation-inbox.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserPrimaryTenantId(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', userId)
    .limit(1)
    .single();
}

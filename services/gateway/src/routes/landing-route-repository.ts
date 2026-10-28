// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/landing-route.ts — zero coverage today.
/**
 * routes/landing-route.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in landing-route.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPrimaryUserTenantRole(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_tenants')
    .select('active_role, is_primary')
    .eq('user_id', userId)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
}

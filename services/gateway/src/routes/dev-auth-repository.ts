// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/dev-auth.ts — zero coverage today.
/**
 * routes/dev-auth.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.rpc(...)` call in dev-auth.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * RPC, same args, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function bootstrapDevRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', {
    p_tenant_id: tenantId,
    p_active_role: activeRole,
  });
}

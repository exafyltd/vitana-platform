// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/admin-users-lookup.ts — zero coverage
// today.
/**
 * routes/admin-users-lookup.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.rpc(...)` call in admin-users-lookup.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC, same args (`p_global: true`, admin cross-tenant
 * search), same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function resolveRecipientCandidatesGlobal(
  sb: SupabaseClient,
  actorUserId: string,
  token: string,
  limit: number,
) {
  return sb.rpc('resolve_recipient_candidates', {
    p_actor: actorUserId,
    p_token: token,
    p_limit: limit,
    p_global: true, // admin-only: cross-tenant search
  });
}

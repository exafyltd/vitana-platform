// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/role-admin.ts — zero coverage today.
/**
 * routes/role-admin.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in role-admin.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * RPC names, same params, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function meContextRpc(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

export async function getMyPermittedRolesRpc(sb: SupabaseClient) {
  return sb.rpc('get_my_permitted_roles');
}

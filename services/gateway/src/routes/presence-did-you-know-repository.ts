// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/presence-did-you-know.ts — zero coverage
// today.
/**
 * routes/presence-did-you-know.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * presence-did-you-know.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same calls, same params,
 * same filter logic, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function meContextRpc(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

export async function fetchPrimaryTenantForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).limit(1).maybeSingle();
}

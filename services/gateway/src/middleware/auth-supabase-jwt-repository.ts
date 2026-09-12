// Coverage note: test/middleware/auth-supabase-jwt.test.ts exercises this
// middleware against a real per-table thenable query-chain fake client
// (mocks '../../src/lib/supabase' to return it — not a wholesale mock of
// this repository module), so these wrappers get genuine coverage, not a
// documented zero.
/**
 * middleware/auth-supabase-jwt.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in auth-supabase-jwt.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * `fetchPrimaryTenantForUser` is the identical query shape used at both
 * of auth-supabase-jwt.ts's two call sites (requireTenant and
 * requireAuthWithTenant) — deduplicated into one function, same as those
 * two sites already shared the same inline query before this move.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchVitanaIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('vitana_id').eq('user_id', userId).maybeSingle();
}

export async function fetchPrimaryTenantForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).single();
}

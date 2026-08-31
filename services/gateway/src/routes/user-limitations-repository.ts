// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/user-limitations.ts — zero coverage
// today.
/**
 * routes/user-limitations.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * routes/user-limitations.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserLimitations(sb: SupabaseClient, userId: string) {
  return sb.from('user_limitations').select('*').eq('user_id', userId).maybeSingle();
}

export async function fetchUserLimitationsVerificationFields(sb: SupabaseClient, userId: string) {
  return sb.from('user_limitations').select('user_set_fields, field_last_verified').eq('user_id', userId).maybeSingle();
}

export async function upsertUserLimitations(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('user_limitations').upsert(payload, { onConflict: 'user_id' }).select('*').single();
}

export async function fetchUserLimitationsImpact(sb: SupabaseClient, userId: string) {
  return sb.rpc('get_user_limitations_impact', { p_user_id: userId });
}

export async function fetchActiveTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();
}

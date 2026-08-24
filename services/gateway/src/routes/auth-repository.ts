// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/auth.ts — zero coverage today.
// AUTH-CRITICAL: this file backs login, /me identity resolution, and the
// auto-provision safety net — every select/upsert shape below is
// preserved byte-for-byte from the original inline calls, verified via
// full diff review before commit.
/**
 * routes/auth.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** POST /login — profile lookup (no vitana_id, unlike the /me variant). */
export async function fetchLoginProfile(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('display_name, bio, avatar_url:profile->>avatar_url').eq('user_id', userId).single();
}

/** Reused by both POST /login and GET /me for the users-table avatar fallback. */
export async function fetchUsersTableProfile(sb: SupabaseClient, userId: string) {
  return sb.from('users').select('display_name, avatar_url').eq('id', userId).single();
}

export async function fetchPrimaryTenantMembership(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).single();
}

export async function countWelcomeNotifications(sb: SupabaseClient, userId: string) {
  return sb.from('user_notifications').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('type', 'welcome_to_vitana');
}

/** GET /me — profile lookup (includes vitana_id, unlike the /login variant). */
export async function fetchMeProfile(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('display_name, bio, vitana_id, avatar_url:profile->>avatar_url').eq('user_id', userId).single();
}

export async function fetchProfilesVitanaIdLock(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('vitana_id_locked, vitana_id, registration_seq').eq('user_id', userId).maybeSingle();
}

export async function fetchUserMemberships(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id, active_role, is_primary').eq('user_id', userId);
}

export async function fetchOldestTenant(sb: SupabaseClient) {
  return sb.from('tenants').select('tenant_id').order('created_at', { ascending: true }).limit(1).single();
}

export async function upsertAppUserProvision(
  sb: SupabaseClient,
  row: { user_id: string; email: string | null | undefined; display_name: string; tenant_id: string | null },
) {
  return sb.from('app_users').upsert(row, { onConflict: 'user_id' }).select('display_name, avatar_url, bio').single();
}

export async function upsertUserTenantProvision(
  sb: SupabaseClient,
  row: { tenant_id: string; user_id: string; active_role: string; is_primary: boolean },
) {
  return sb.from('user_tenants').upsert(row, { onConflict: 'tenant_id,user_id' }).select('tenant_id, active_role, is_primary').single();
}

export async function updateAppUserProfile(sb: SupabaseClient, userId: string, updates: Record<string, unknown>) {
  return sb.from('app_users').update(updates).eq('user_id', userId).select('display_name, bio, avatar_url:profile->>avatar_url');
}

export async function insertAppUserProfile(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('app_users').insert(row).select('display_name, bio, avatar_url:profile->>avatar_url').single();
}

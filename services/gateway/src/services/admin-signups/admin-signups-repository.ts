/**
 * routes/admin-signups.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-signups.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same filter-application order, same
 * `{ data, error }`/`{ data, error, count }` shapes — no behavior change
 * today. Mirrors the community-marketplace/universal-cart/vcaop-portal/
 * testing/ai-assistants repository precedents from the same workstream.
 *
 * app_users/user_tenants are included here (unlike the "leave shared
 * tables inline" precedent elsewhere) because this route's own repair
 * logic WRITES to them directly — they are not incidental cross-cutting
 * reads here, they are this route's own provisioning-repair behavior.
 *
 * `supabase.auth.admin.getUserById(...)` in POST /:id/repair is the
 * Supabase Auth Admin API, not a `.from()` table call — left inline,
 * out of scope for a Postgres data-access seam (Aurora does not run
 * GoTrue; see CLAUDE.md §3/AURORA-EXCEPT-AUTH-ASSESSMENT.md).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== signup_funnel ====================

export interface FunnelFilters {
  stage?: string;
  tenantId?: string;
  search?: string;
  offset: number;
  limit: number;
}

export async function fetchSignupFunnel(supabase: SupabaseClient, f: FunnelFilters) {
  let query = supabase
    .from('signup_funnel')
    .select('*')
    .order('started_at', { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  if (f.stage) query = query.eq('funnel_stage', f.stage);
  if (f.tenantId) query = query.eq('tenant_id', f.tenantId);
  if (f.search) query = query.or(`email.ilike.%${f.search}%,display_name.ilike.%${f.search}%`);

  return query;
}

// ==================== signup_attempts ====================

export async function fetchAttemptsStatsWindow(supabase: SupabaseClient, since: string, tenantId?: string) {
  let query = supabase.from('signup_attempts').select('status, tenant_id').gte('started_at', since);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  return query;
}

export interface AttemptsFilters {
  status?: string;
  search?: string;
  offset: number;
  limit: number;
}

export async function fetchAttempts(supabase: SupabaseClient, f: AttemptsFilters) {
  let query = supabase
    .from('signup_attempts')
    .select('*', { count: 'exact' })
    .order('started_at', { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  if (f.status) query = query.eq('status', f.status);
  if (f.search) query = query.ilike('email', `%${f.search}%`);

  return query;
}

export async function insertSignupAttempt(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('signup_attempts').insert(row).select('id').single();
}

export async function updateSignupAttempt(supabase: SupabaseClient, attemptId: string, fields: Record<string, unknown>) {
  return supabase.from('signup_attempts').update(fields).eq('id', attemptId);
}

export async function fetchAttemptReferralInfo(supabase: SupabaseClient, attemptId: string) {
  return supabase.from('signup_attempts').select('referral_code, utm_source, utm_campaign').eq('id', attemptId).maybeSingle();
}

export async function fetchAttemptById(supabase: SupabaseClient, attemptId: string) {
  return supabase.from('signup_attempts').select('*').eq('id', attemptId).single();
}

// ==================== app_users ====================

export async function countRegisteredUsers(supabase: SupabaseClient, tenantId?: string) {
  let query = supabase.from('app_users').select('user_id', { count: 'exact', head: true });
  if (tenantId) query = query.eq('tenant_id', tenantId);
  return query;
}

export async function fetchAppUserByUserId(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('user_id').eq('user_id', userId).single();
}

export async function insertAppUser(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('app_users').insert(row);
}

// ==================== user_tenants ====================

export async function fetchUserTenantMembership(supabase: SupabaseClient, userId: string, tenantId: string) {
  return supabase.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('tenant_id', tenantId).single();
}

export async function insertUserTenant(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_tenants').insert(row);
}

// ==================== onboarding_invitations ====================

export async function insertOnboardingInvitation(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('onboarding_invitations').insert(row).select('id').single();
}

export interface InvitationsFilters {
  status?: string;
  offset: number;
  limit: number;
}

export async function fetchInvitations(supabase: SupabaseClient, f: InvitationsFilters) {
  let query = supabase
    .from('onboarding_invitations')
    .select('*', { count: 'exact' })
    .order('sent_at', { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  if (f.status) query = query.eq('status', f.status);

  return query;
}

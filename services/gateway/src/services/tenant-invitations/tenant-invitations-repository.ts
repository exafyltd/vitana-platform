/**
 * routes/tenant-admin/invitations.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/tenant-admin/invitations.ts
 * (both the admin router and the public acceptRouter it exports) now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same `{ data, error }` shapes — no behavior change today.
 *
 * user_tenants/user_permitted_roles are included here (unlike the "leave
 * shared tables inline" precedent elsewhere) because POST /accept/:token
 * writes to them directly as its own core provisioning behavior, not as
 * an incidental cross-cutting lookup — same reasoning as
 * admin-signups-repository.ts's /repair handling.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== tenant_invitations ====================

export async function fetchExistingPendingInvitation(supabase: SupabaseClient, tenantId: string, email: string) {
  return supabase
    .from('tenant_invitations')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('email', email)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .single();
}

export async function insertInvitation(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('tenant_invitations').insert(row).select('*').single();
}

/** GET / — same branch structure as the original inline query builder. */
export async function fetchInvitations(supabase: SupabaseClient, tenantId: string, status: string) {
  let query = supabase.from('tenant_invitations').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });

  if (status === 'pending') {
    query = query.is('accepted_at', null).is('revoked_at', null);
  } else if (status === 'accepted') {
    query = query.not('accepted_at', 'is', null);
  } else if (status === 'revoked') {
    query = query.not('revoked_at', 'is', null);
  }

  return query;
}

export async function revokeInvitation(supabase: SupabaseClient, id: string, tenantId: string, fields: Record<string, unknown>) {
  return supabase
    .from('tenant_invitations')
    .update(fields)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .select('*')
    .single();
}

export async function fetchInvitationByToken(supabase: SupabaseClient, token: string) {
  return supabase.from('tenant_invitations').select('*').eq('token', token).is('accepted_at', null).is('revoked_at', null).single();
}

export async function markInvitationAccepted(supabase: SupabaseClient, id: string, fields: Record<string, unknown>) {
  return supabase.from('tenant_invitations').update(fields).eq('id', id);
}

// ==================== user_tenants / user_permitted_roles ====================

export async function fetchUserTenantMembership(supabase: SupabaseClient, userId: string, tenantId: string) {
  return supabase.from('user_tenants').select('id').eq('user_id', userId).eq('tenant_id', tenantId).single();
}

export async function insertUserTenantMembership(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_tenants').insert(row);
}

export async function upsertUserPermittedRole(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_permitted_roles').upsert(row, { onConflict: 'user_id,tenant_id,role' });
}

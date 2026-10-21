/**
 * VTID-05147 (Track S / S-M): the roles a user is actually permitted in a
 * tenant — the set every role that decides authorization must be inside.
 *
 * Mirrors public.get_my_permitted_roles() (VTID-03995 body):
 * user_permitted_roles ∪ active memberships ∪ 'community', limited to the
 * eight switcher roles. Read with the service client for the tenant the
 * request resolved (the RPC reads auth.uid()/current_tenant_id() from the
 * caller's JWT, so it cannot be used server side). Moved here from
 * services/jev/jev-caller.ts (VTID-04754), which re-exports it.
 *
 * Why: `role_preferences`, `user_active_roles` and `user_tenants.active_role`
 * were writable by the member themself until VTID-05147's migration, so a
 * role read from them is a claim, not a grant. Callers intersect with this
 * set and fail closed when it cannot be read (`roles: null`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The switcher roles get_my_permitted_roles() returns (v_all_roles). */
export const SWITCHER_ROLES = ['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'] as const;

/** Union of grants, active memberships and community, in switcher order. */
export function computePermittedRoles(grants: Array<{ role: unknown }>, memberships: Array<{ role: unknown }>): string[] {
  const set = new Set<string>(['community']);
  for (const r of [...grants, ...memberships]) if (typeof r?.role === 'string') set.add(r.role.trim().toLowerCase());
  return SWITCHER_ROLES.filter((r) => set.has(r));
}

export interface PermittedRolesResult {
  /** null when the permitted set could not be read — callers fail closed. */
  roles: string[] | null;
  error?: string;
}

export async function fetchPermittedRoles(
  sb: SupabaseClient | null | undefined,
  userId: string,
  tenantId: string,
): Promise<PermittedRolesResult> {
  if (!sb) return { roles: null, error: 'service_client_unavailable' };
  if (!userId || !tenantId) return { roles: null, error: 'user_or_tenant_missing' };
  try {
    const [grants, memberships] = await Promise.all([
      sb.from('user_permitted_roles').select('role').eq('user_id', userId).eq('tenant_id', tenantId),
      sb.from('memberships').select('role').eq('user_id', userId).eq('tenant_id', tenantId).eq('status', 'active'),
    ]);
    const err = grants?.error || memberships?.error;
    if (err) return { roles: null, error: err.message || 'permitted_roles_read_failed' };
    return {
      roles: computePermittedRoles((grants?.data as any[]) || [], (memberships?.data as any[]) || []),
    };
  } catch (e: any) {
    return { roles: null, error: e?.message || 'permitted_roles_read_failed' };
  }
}

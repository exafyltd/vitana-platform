/**
 * VTID-04754: who is calling Jev, for which tenant, acting as which role
 * (docs/JEV-INTEGRATION-PLAN.md §10.3, items 1–2).
 *
 * Role: the canonical rule, pickEffectiveRole (services/orchestrator/
 * active-role.ts) — role_preferences first, then user_tenants.active_role —
 * so Jev addresses a user as the same role as the ORB and the automations.
 * The result must be one of the roles the user is permitted in that tenant.
 *
 * Permitted roles mirror public.get_my_permitted_roles() (VTID-03995 body):
 * user_permitted_roles ∪ active memberships ∪ 'community', limited to the
 * eight switcher roles. The RPC itself cannot be called here: it reads
 * auth.uid() and current_tenant_id() from the caller's Supabase JWT, so it
 * answers ['community'] for a tenant resolved through the user_tenants
 * fallback and cannot run at all for a Cognito token. Same sets, read with
 * the service role for the tenant this request actually resolved.
 *
 * Tenant: the JWT's active_tenant_id, else requireTenant's fallback (the
 * user's primary user_tenants row).
 *
 * Acting role: optional (header x-jev-acting-role or body.acting_role);
 * accepted only when permitted.
 *
 * exafy_admin: no tenant of their own here. A tenant-scoped decision needs a
 * named target tenant (header x-jev-tenant, query or body tenant_id; uuid or
 * slug); the call is recorded with cross_tenant: true.
 *
 * Known gap, reported not papered over: a Cognito token carries no
 * exafy_admin claim (auth-supabase-jwt.ts KNOWN GAP), so a Cognito super
 * admin resolves as a normal tenant user. Reported as identity_gaps.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { pickEffectiveRole } from '../orchestrator/active-role';
import type { JevCaller } from './jev-access';
import * as repo from './jev-repository';

/** The switcher roles get_my_permitted_roles() returns (v_all_roles). */
export const JEV_SWITCHER_ROLES = ['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'] as const;

export class JevCallerError extends Error {
  constructor(public status: number, public reason: string) {
    super(reason);
  }
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/** Union of grants, active memberships and community, in switcher order. */
export function computePermittedRoles(grants: Array<{ role: unknown }>, memberships: Array<{ role: unknown }>): string[] {
  const set = new Set<string>(['community']);
  for (const r of [...grants, ...memberships]) if (typeof r?.role === 'string') set.add(r.role.trim().toLowerCase());
  return JEV_SWITCHER_ROLES.filter((r) => set.has(r));
}

export async function resolveJevCaller(req: AuthenticatedRequest, sbOverride?: SupabaseClient | null): Promise<JevCaller> {
  const id = req.identity!;
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const query = (req.query || {}) as Record<string, unknown>;
  const targetTenant = firstString(req.headers?.['x-jev-tenant'], query.tenant_id, body.tenant_id);
  const actingRole = firstString(req.headers?.['x-jev-acting-role'], body.acting_role)?.toLowerCase() ?? null;

  const gaps: string[] = [];
  if (req.auth_source === 'cognito') gaps.push('cognito_exafy_admin_unresolved');
  const caller: JevCaller = { actor_id: id.user_id, exafy_admin: id.exafy_admin, tenant_id: null };
  const done = () => {
    if (gaps.length) caller.identity_gaps = gaps;
    return caller;
  };

  const sb = sbOverride === undefined ? getSupabase() : sbOverride;

  if (id.exafy_admin) {
    if (!targetTenant) return done();
    if (!sb) throw new JevCallerError(503, 'tenant_lookup_unavailable');
    const { data, error } = await repo.fetchTenantByIdOrSlug(sb, targetTenant);
    if (error) throw new JevCallerError(503, 'tenant_lookup_unavailable');
    if (!data) throw new JevCallerError(404, 'unknown_tenant');
    caller.tenant_id = (data as { tenant_id: string }).tenant_id;
    caller.cross_tenant = true;
    return done();
  }

  if (!sb) {
    gaps.push('role_lookup_unavailable');
    return done();
  }

  let tenantId = id.tenant_id;
  if (!tenantId) {
    const { data } = await repo.fetchPrimaryTenant(sb, id.user_id);
    tenantId = (data as { tenant_id?: string } | null)?.tenant_id ?? null;
  }
  if (!tenantId) {
    gaps.push('no_tenant');
    return done();
  }
  if (targetTenant && targetTenant !== tenantId) throw new JevCallerError(403, 'cross_tenant_not_permitted');
  caller.tenant_id = tenantId;

  const [pref, active, grants, memberships] = await Promise.all([
    repo.fetchLatestRolePreference(sb, id.user_id, tenantId),
    repo.fetchTenantActiveRole(sb, id.user_id, tenantId),
    repo.fetchExplicitRoleGrants(sb, id.user_id, tenantId),
    repo.fetchActiveMembershipRoles(sb, id.user_id, tenantId),
  ]);
  if (grants.error || memberships.error) {
    // Without the permitted set no role can be validated: fail closed.
    console.warn(`[jev] permitted-role read failed user=${id.user_id} tenant=${tenantId}: ${(grants.error || memberships.error)!.message}`);
    gaps.push('permitted_roles_unavailable');
    return done();
  }
  if (pref.error) console.warn(`[jev] role_preferences read failed user=${id.user_id}: ${pref.error.message} — using user_tenants.active_role`);

  const permitted = computePermittedRoles((grants.data as any[]) || [], (memberships.data as any[]) || []);
  if (actingRole) {
    if (!permitted.includes(actingRole)) throw new JevCallerError(403, 'acting_role_not_permitted');
    caller.active_role = actingRole;
    return done();
  }

  const effective = pickEffectiveRole(
    pref.error ? null : (pref.data as { role?: string } | null)?.role,
    (active.data as { active_role?: string } | null)?.active_role,
  )?.toLowerCase() ?? null;
  if (effective && !permitted.includes(effective)) throw new JevCallerError(403, 'effective_role_not_permitted');
  caller.active_role = effective;
  return done();
}

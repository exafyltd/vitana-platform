/**
 * VTID-04473 / VTID-04754: who may spend a Jev call, and on which plane.
 *
 * Owner decision (2026-09-25): Jev is active for the internal roles —
 * professional, staff, backoffice, admin, developer, infra (and exafy_admin
 * and system callers) — and OFF for members until cost control exists
 * (docs/JEV-INTEGRATION-PLAN.md §8, §10).
 *
 * Every call runs on exactly one plane (VTID-04754, plan §10.3):
 *   internal         — the team running the business (internal roles,
 *                      exafy_admin, platform system callers)
 *   partner_org      — a partner organisation's own users (reseller role);
 *                      only when the tenant's jev flag lists the plane
 *   member           — community members; JEV_COMMUNITY_ENABLED (exact
 *                      'true', never pinned) + per-tenant flag + budget
 *   patient          — the patient mode; OFF until a DPA and a PHI gate exist
 *   system_autopilot — Community Autopilot acting on behalf of members
 *
 * Which data a plane may send is decided by jev-policy.ts, not here.
 */

export const JEV_PLANES = ['internal', 'partner_org', 'member', 'patient', 'system_autopilot'] as const;
export type JevPlane = (typeof JEV_PLANES)[number];

export const JEV_INTERNAL_ROLES = [
  'professional',
  'staff',
  'backoffice',
  'admin',
  'developer',
  'infra',
] as const;

export const JEV_COMMUNITY_ROLES = ['community', 'patient'] as const;
export const JEV_PARTNER_ROLES = ['reseller'] as const;

export type JevRole =
  | (typeof JEV_INTERNAL_ROLES)[number]
  | (typeof JEV_COMMUNITY_ROLES)[number]
  | (typeof JEV_PARTNER_ROLES)[number]
  | 'exafy_admin'
  | 'system';

export interface JevCaller {
  /** Verified user id, or a service name for system callers. */
  actor_id: string;
  exafy_admin?: boolean;
  /** Effective role for the tenant (role_preferences → user_tenants.active_role). */
  active_role?: string | null;
  tenant_id?: string | null;
  /** In-process callers (pipelines, cron) — never a browser request. */
  system?: boolean;
  /** System callers acting for members (Community Autopilot) say so here. */
  system_plane?: 'internal' | 'system_autopilot';
  /** exafy_admin acting on a tenant they named explicitly. */
  cross_tenant?: boolean;
  /** Identity limits the gateway could not resolve (reported, not papered over). */
  identity_gaps?: string[];
}

export type JevAccessDenyReason = 'community_not_enabled' | 'patient_plane_off' | 'no_role' | 'role_not_permitted';

export type JevAccessResult =
  | { allowed: true; plane: JevPlane; role: JevRole }
  | { allowed: false; plane: JevPlane | null; role: string | null; reason: JevAccessDenyReason };

export function isJevCommunityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JEV_COMMUNITY_ENABLED === 'true';
}

export function resolveJevAccess(caller: JevCaller, env: NodeJS.ProcessEnv = process.env): JevAccessResult {
  if (caller.system) return { allowed: true, plane: caller.system_plane ?? 'internal', role: 'system' };
  if (caller.exafy_admin) return { allowed: true, plane: 'internal', role: 'exafy_admin' };

  const role = (caller.active_role || '').trim().toLowerCase();
  if (!role) return { allowed: false, plane: null, role: null, reason: 'no_role' };

  if ((JEV_INTERNAL_ROLES as readonly string[]).includes(role)) {
    return { allowed: true, plane: 'internal', role: role as JevRole };
  }
  if ((JEV_PARTNER_ROLES as readonly string[]).includes(role)) {
    return { allowed: true, plane: 'partner_org', role: role as JevRole };
  }
  if (role === 'patient') {
    return { allowed: false, plane: 'patient', role, reason: 'patient_plane_off' };
  }
  if (role === 'community') {
    return isJevCommunityEnabled(env)
      ? { allowed: true, plane: 'member', role: 'community' }
      : { allowed: false, plane: 'member', role, reason: 'community_not_enabled' };
  }
  return { allowed: false, plane: null, role, reason: 'role_not_permitted' };
}

/**
 * Whether a resolved role may use one specific decision. exafy_admin and
 * system callers may use every decision; everyone else needs the role listed.
 */
export function roleMayUseDecision(role: JevRole, decisionRoles: readonly string[]): boolean {
  if (role === 'exafy_admin' || role === 'system') return true;
  return decisionRoles.includes(role);
}

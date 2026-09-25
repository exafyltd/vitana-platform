/**
 * VTID-04473: who may spend a Jev call.
 *
 * Owner decision (2026-09-25): Jev is active for the internal roles —
 * professional, staff, backoffice, admin, developer, infra (and exafy_admin
 * and system callers) — and OFF for community members until cost control
 * exists (docs/JEV-INTEGRATION-PLAN.md §8). `patient` is a member-facing mode
 * and is treated like community.
 *
 * Every call is tagged with a plane so the spend can be split later:
 *   internal  — the team running the business, unlimited by design
 *   community — members; gated by JEV_COMMUNITY_ENABLED (exact 'true'),
 *               which is deliberately never pinned on any deploy workflow.
 */

export type JevPlane = 'internal' | 'community';

export const JEV_INTERNAL_ROLES = [
  'professional',
  'staff',
  'backoffice',
  'admin',
  'developer',
  'infra',
] as const;

export const JEV_COMMUNITY_ROLES = ['community', 'patient'] as const;

export type JevRole = (typeof JEV_INTERNAL_ROLES)[number] | (typeof JEV_COMMUNITY_ROLES)[number] | 'exafy_admin' | 'system';

export interface JevCaller {
  /** Verified user id, or a service name for system callers. */
  actor_id: string;
  exafy_admin?: boolean;
  /** user_tenants.active_role for the caller's active tenant. */
  active_role?: string | null;
  tenant_id?: string | null;
  /** In-process callers (pipelines, cron) — never a browser request. */
  system?: boolean;
}

export type JevAccessResult =
  | { allowed: true; plane: JevPlane; role: JevRole }
  | { allowed: false; plane: JevPlane | null; role: string | null; reason: 'community_not_enabled' | 'no_role' | 'role_not_permitted' };

export function isJevCommunityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JEV_COMMUNITY_ENABLED === 'true';
}

export function resolveJevAccess(caller: JevCaller, env: NodeJS.ProcessEnv = process.env): JevAccessResult {
  if (caller.system) return { allowed: true, plane: 'internal', role: 'system' };
  if (caller.exafy_admin) return { allowed: true, plane: 'internal', role: 'exafy_admin' };

  const role = (caller.active_role || '').trim().toLowerCase();
  if (!role) return { allowed: false, plane: null, role: null, reason: 'no_role' };

  if ((JEV_INTERNAL_ROLES as readonly string[]).includes(role)) {
    return { allowed: true, plane: 'internal', role: role as JevRole };
  }
  if ((JEV_COMMUNITY_ROLES as readonly string[]).includes(role)) {
    return isJevCommunityEnabled(env)
      ? { allowed: true, plane: 'community', role: role as JevRole }
      : { allowed: false, plane: 'community', role, reason: 'community_not_enabled' };
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

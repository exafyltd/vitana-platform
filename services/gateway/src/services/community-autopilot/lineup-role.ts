/**
 * VTID-04500 (Community Autopilot CA-2): which Autopilot lineup a caller sees.
 *
 * Before this, the recommendation routes trusted `?role=` / `X-Vitana-Active-Role`
 * as sent, and `queryRecommendationsByRole` treated `admin` or any unknown role
 * as "no filter" — so a member who sent `?role=admin` received every user's
 * personal suggestions. The frontend also hard-coded `community`, so switching
 * role never switched the lineup.
 *
 * Now the server decides:
 *   - The requested role is a hint. `community`/`patient` are always allowed
 *     (every member has their own community lineup).
 *   - A system role (`developer`, `admin`, `infra`) is honoured only for an
 *     exafy admin or when `check_role_permitted(user, tenant, role)` is true.
 *     Otherwise it narrows to the member's own community lineup.
 *   - Roles without a lineup yet (`professional`, `staff`, `backoffice`) get
 *     an empty lineup instead of someone else's items.
 *   - With no hint, the member's effective role (role_preferences, then
 *     user_tenants.active_role) is used.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** The lineups `queryRecommendationsByRole` knows how to filter for. */
export type LineupRole = 'community' | 'developer' | 'none';

export const COMMUNITY_LINEUP_ROLES = new Set(['community', 'patient']);
export const SYSTEM_LINEUP_ROLES = new Set(['developer', 'admin', 'infra']);
export const EMPTY_LINEUP_ROLES = new Set(['professional', 'staff', 'backoffice']);

/** role_scope values a platform role may read (used by the ORB opener). */
export function roleScopesVisibleFrom(platformRole: string | null | undefined): string[] {
  const r = (platformRole ?? '').trim().toLowerCase();
  if (!r || COMMUNITY_LINEUP_ROLES.has(r)) return ['any', 'community'];
  if (SYSTEM_LINEUP_ROLES.has(r)) return ['any', 'developer'];
  return ['any', r];
}

export interface LineupInputs {
  requested: string | null;
  effectiveRole: string | null;
  exafyAdmin: boolean;
  /** Result of check_role_permitted for the candidate system role; null = not checked. */
  systemRolePermitted: boolean | null;
}

export interface LineupDecision {
  lineup: LineupRole;
  /** The role the decision was made for (after defaulting). */
  candidate: string;
  /** True when a requested system role was refused and narrowed to community. */
  narrowed: boolean;
}

/** Pure decision: which lineup the candidate role maps to. */
export function decideLineup(i: LineupInputs): LineupDecision {
  const candidate = (i.requested ?? i.effectiveRole ?? 'community').trim().toLowerCase() || 'community';
  if (COMMUNITY_LINEUP_ROLES.has(candidate)) return { lineup: 'community', candidate, narrowed: false };
  if (SYSTEM_LINEUP_ROLES.has(candidate)) {
    if (i.exafyAdmin || i.systemRolePermitted === true) return { lineup: 'developer', candidate, narrowed: false };
    return { lineup: 'community', candidate, narrowed: true };
  }
  if (EMPTY_LINEUP_ROLES.has(candidate)) return { lineup: 'none', candidate, narrowed: false };
  // Unknown value: never widen — fall back to the member's own lineup.
  return { lineup: 'community', candidate, narrowed: true };
}

export interface ResolveLineupArgs {
  userId: string;
  tenantId: string | null;
  exafyAdmin: boolean;
  requested: string | null;
}

/**
 * Fetch the facts (effective role, permission for a system role) and decide.
 * Fails closed: any read error leaves the member on their own community lineup.
 */
export async function resolveLineupRole(sb: SupabaseClient, a: ResolveLineupArgs): Promise<LineupDecision> {
  let effectiveRole: string | null = null;
  if (!a.requested && a.tenantId) {
    try {
      const { resolveAgentContext } = await import('../orchestrator/context');
      const ctx = await resolveAgentContext(sb, {
        user_id: a.userId,
        tenant_id: a.tenantId,
        exafy_admin: a.exafyAdmin,
        channel: 'web',
      });
      effectiveRole = ctx.platform_role;
    } catch {
      effectiveRole = null;
    }
  }

  const candidate = (a.requested ?? effectiveRole ?? 'community').trim().toLowerCase();
  let systemRolePermitted: boolean | null = null;
  if (SYSTEM_LINEUP_ROLES.has(candidate) && !a.exafyAdmin) {
    systemRolePermitted = false;
    if (a.tenantId) {
      try {
        const { data, error } = await sb.rpc('check_role_permitted', {
          p_user_id: a.userId,
          p_tenant_id: a.tenantId,
          p_role: candidate,
        });
        systemRolePermitted = !error && data === true;
      } catch {
        systemRolePermitted = false;
      }
    }
  }

  return decideLineup({
    requested: a.requested,
    effectiveRole,
    exafyAdmin: a.exafyAdmin,
    systemRolePermitted,
  });
}

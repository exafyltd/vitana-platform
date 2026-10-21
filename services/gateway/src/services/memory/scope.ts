/**
 * VTID-04367: role scope for memory rows (defect D9).
 *
 * Rule, one line: a user's personal memory is visible in every role they
 * hold, and memory written while working in a non-personal role
 * (developer, staff, backoffice, admin, …) is visible only in that role.
 *
 * Stored as `memory_items.active_role`:
 *   - NULL        personal memory; written in community/patient/member mode
 *   - '<role>'    written while the user was acting in that role
 *
 * `memory_semantic_search` already matches
 * `active_role IS NULL OR active_role = p_active_role`, so reading with the
 * session's role returns personal memory plus that role's memory, and
 * nothing written in any other role.
 */

/** Roles whose memory is the user's own personal memory. */
const PERSONAL_ROLES = new Set(['', 'community', 'user', 'member', 'patient']);

/**
 * VTID-04495: database roles, not Vitana roles. `identity.role` is the
 * Supabase JWT `role` claim, which is 'authenticated' for every signed-in
 * user; storing it scoped the row away from the user's personal memory.
 */
const DATABASE_ROLES = new Set(['authenticated', 'anon', 'service_role', 'supabase_admin']);

/**
 * Lower-cased role, or '' for anything that is not a plain role name. The
 * value is interpolated into a PostgREST filter, so only [a-z_] is allowed.
 */
function normalize(role: string | null | undefined): string {
  const r = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (DATABASE_ROLES.has(r)) return '';
  return /^[a-z_]{1,32}$/.test(r) ? r : '';
}

/** The `active_role` to store on a new memory row. */
export function memoryRoleForWrite(role: string | null | undefined): string | null {
  const r = normalize(role);
  return PERSONAL_ROLES.has(r) ? null : r;
}

/** The role to filter by when reading. Personal roles read as 'community'. */
export function memoryRoleForRead(role: string | null | undefined): string {
  const r = normalize(role);
  return PERSONAL_ROLES.has(r) ? 'community' : r;
}

/**
 * VTID-04798: the roles a work surface serves (orb/profile/assistant-profile.ts
 * WORK_SURFACE_ROLE; a test keeps the two lists equal). Kept here so the
 * memory layer does not import the ORB profile.
 */
export const WORK_ROLES: readonly string[] = ['developer', 'admin', 'backoffice', 'commerce'];

export function isWorkRole(role: string | null | undefined): boolean {
  return WORK_ROLES.includes(normalize(role));
}

/**
 * VTID-04798: may this conversation write the member's personal facts?
 * `memory_facts` holds personal memory only (no role column yet, plan §8.4
 * phase 3b), so a conversation on a work surface — Command Hub, admin,
 * BackOffice, commerce — never writes there: a developer's "my project is
 * due Friday" must not become something the community Vitana knows.
 */
export function mayWritePersonalFacts(ctx: { workSurface?: boolean | null; role?: string | null }): boolean {
  return ctx.workSurface !== true && !isWorkRole(ctx.role);
}

/** PostgREST `or=` filter matching {@link memoryRoleForRead}. */
export function memoryRoleOrFilter(role: string | null | undefined): string {
  const r = memoryRoleForRead(role);
  return `active_role.is.null,active_role.eq.${r}`;
}

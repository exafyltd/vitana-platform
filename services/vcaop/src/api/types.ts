/**
 * VCAOP API shared types (CTRL-API-0004, runbook Sec. 5).
 *
 * Roles mirror the Vitanaland IAM model (Sec. 5). Authz is enforced at the
 * Gateway middleware layer (here) AND Supabase RLS (IAM-ROLES-0001). This module
 * defines the application-level role matrix used by the router.
 */

export type Role = 'community' | 'staff' | 'admin' | 'developer';

export const ROLES: readonly Role[] = ['community', 'staff', 'admin', 'developer'];

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

/** Resolved caller identity. In the real Gateway this is built from the auth/JWT
 * middleware; here it is injected (and in tests supplied via headers). */
export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
}

/** Standard API envelope (CLAUDE.md API conventions: { ok, error?, data? }). */
export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiErr {
  ok: false;
  error: string;
  code?: string;
}
export type ApiResponse<T> = ApiOk<T> | ApiErr;

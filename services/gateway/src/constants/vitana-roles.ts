/**
 * VTID-03832 — the single source of truth for Vitana role names in the gateway.
 *
 * Before this file the 7-role list was hand-copied into me.ts, role-admin.ts,
 * admin-users.ts, dev-auth.ts and admin-navigator.ts. Adding `backoffice`
 * (decision 4/4b of the BackOffice plan, docs/backoffice/GOLDEN-WORKFLOWS.md)
 * would have meant five more copies to keep in sync; every consumer now imports
 * from here.
 *
 * Order == the linear ladder the frontend's ROLE_HIERARCHY and the DB's
 * validate_role_assignment() ladder use (rank = index + 1):
 *   community 1 < patient 2 < professional 3 < staff 4 < backoffice 5
 *   < admin 6 < developer 7 < infra 8
 *
 * The DB enums are aligned by supabase/migrations/20260913000000_* and
 * 20260913000001_* (vitana_role gains infra + backoffice; tenant_role gains
 * backoffice + developer + infra).
 */
export const VITANA_ROLES = [
  'community',
  'patient',
  'professional',
  'staff',
  'backoffice',
  'admin',
  'developer',
  'infra',
] as const;

export type VitanaRole = (typeof VITANA_ROLES)[number];

/** Mutable copy for call sites that echo the list in JSON responses. */
export const VALID_ROLES: string[] = [...VITANA_ROLES];

/** Roles only an Exafy super-admin may grant (VTID-01230). `backoffice` is
 *  deliberately NOT here — it is tenant-admin-grantable (decision 4b). */
export const SUPER_ADMIN_ONLY_ROLES: readonly VitanaRole[] = ['developer', 'infra'];

export const ROLE_RANK: Record<VitanaRole, number> = Object.fromEntries(
  VITANA_ROLES.map((r, i) => [r, i + 1]),
) as Record<VitanaRole, number>;

export function isVitanaRole(value: unknown): value is VitanaRole {
  return typeof value === 'string' && (VITANA_ROLES as readonly string[]).includes(value);
}

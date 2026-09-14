/**
 * VTID-03834 — pure policy helpers for ERP capability access. No I/O here so
 * the rules can be unit-tested exhaustively; the route layer fetches the rows.
 */
import { ERP_CAPABILITIES, ROLE_DEFAULT_CAPABILITIES, isErpCapability, isExplicitOnly, type ErpCapability } from '../../constants/erp-capabilities';
import { isVitanaRole } from '../../constants/vitana-roles';

export interface EffectiveAccess {
  role: string | null;
  is_exafy_admin: boolean;
  defaults: ErpCapability[];
  explicit: ErpCapability[];
  capabilities: ErpCapability[];
}

/** Defaults a role brings with it; Exafy super-admins get the whole catalog. */
export function defaultCapabilitiesFor(role: string | null, isExafyAdmin: boolean): ErpCapability[] {
  if (isExafyAdmin) return [...ERP_CAPABILITIES];
  if (!isVitanaRole(role)) return [];
  return [...(ROLE_DEFAULT_CAPABILITIES[role] ?? [])];
}

/** Effective = defaults(role) ∪ explicit grants, deduplicated, catalog-validated. */
export function effectiveCapabilities(
  role: string | null,
  isExafyAdmin: boolean,
  explicitGrants: readonly string[],
): EffectiveAccess {
  const defaults = defaultCapabilitiesFor(role, isExafyAdmin);
  const explicit = [...new Set(explicitGrants.filter(isErpCapability))];
  const capabilities = ERP_CAPABILITIES.filter((c) => defaults.includes(c) || explicit.includes(c));
  return { role, is_exafy_admin: isExafyAdmin, defaults, explicit, capabilities };
}

export function hasCapability(access: EffectiveAccess, capability: ErpCapability): boolean {
  return access.capabilities.includes(capability);
}

/**
 * Who may grant/revoke capabilities in a tenant: an Exafy super-admin, or a
 * caller whose EFFECTIVE access holds `erp.admin` (tenant admins hold it by
 * default; a `backoffice` user only if explicitly granted). Mirrors the
 * "through the gateway, never a direct client write" rule of role-admin.
 */
export function canManageErpAccess(access: EffectiveAccess): boolean {
  return access.is_exafy_admin || hasCapability(access, 'erp.admin');
}

export interface GrantValidation {
  ok: boolean;
  error?: 'INVALID_CAPABILITY' | 'EXPLICIT_ONLY_NEEDS_ADMIN';
  explicit_only?: boolean;
}

/**
 * Personal-data capabilities (hr.*, payroll.*) are explicit-only: they can be
 * granted, but only by a caller who is an Exafy admin or a tenant `admin`
 * (not merely an `erp.admin` capability holder), so a delegated ERP admin
 * cannot widen access to employee data on their own.
 */
export function validateGrant(capability: unknown, caller: { is_exafy_admin: boolean; active_role: string | null }): GrantValidation {
  if (!isErpCapability(capability)) return { ok: false, error: 'INVALID_CAPABILITY' };
  const explicitOnly = isExplicitOnly(capability);
  if (explicitOnly && !(caller.is_exafy_admin || caller.active_role === 'admin')) {
    return { ok: false, error: 'EXPLICIT_ONLY_NEEDS_ADMIN', explicit_only: true };
  }
  return { ok: true, explicit_only: explicitOnly };
}

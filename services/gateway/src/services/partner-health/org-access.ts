/**
 * VTID-03932 — Commerce Partner Onboarding (Phase 1): org-scoped access
 * resolution for the admin-partner-health routes.
 *
 * Lets a partner org's own staff/professional members use the SAME
 * orders/inbox/upload-result/confirm-match handlers a Vitana admin already
 * uses (admin-partner-health.ts), without duplicating the
 * services/partner-health/ingestion.ts write path. Re-keyed from
 * tenant_id to partner_organization_id, same shape as
 * services/backoffice/erp-access.ts's effectiveCapabilities().
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type PartnerHealthAccess =
  | { scope: 'admin' }
  | {
      scope: 'org';
      callerId: string;
      /** partner_registry ids this caller can act on for ANY order (org_admin/staff). */
      fullAccessPartnerIds: string[];
      /** partner_registry ids this caller can act on ONLY for orders assigned to them (professional). */
      assignedOnlyPartnerIds: string[];
    };

/**
 * Resolves org-scoped access for a caller who is NOT a Vitana tenant admin
 * (callers that already pass requireTenantAdmin get { scope: 'admin' }
 * without needing this lookup at all).
 *
 * A caller may hold membership in several partner orgs; org_admin/staff
 * membership grants full access to every partner_registry row linked to
 * that org, professional membership grants assigned-order-only access.
 * Returns null if the caller has no partner org membership at all.
 */
export async function resolveOrgHealthAccess(
  supabase: SupabaseClient,
  callerId: string
): Promise<PartnerHealthAccess | null> {
  const { data: memberships, error: memberErr } = await supabase
    .from('partner_organization_members')
    .select('partner_organization_id, role')
    .eq('user_id', callerId);
  if (memberErr || !memberships || memberships.length === 0) return null;

  const fullAccessOrgIds = (memberships as Array<{ partner_organization_id: string; role: string }>)
    .filter((m) => m.role === 'org_admin' || m.role === 'staff')
    .map((m) => m.partner_organization_id);
  const professionalOrgIds = (memberships as Array<{ partner_organization_id: string; role: string }>)
    .filter((m) => m.role === 'professional')
    .map((m) => m.partner_organization_id);

  if (fullAccessOrgIds.length === 0 && professionalOrgIds.length === 0) return null;

  const allOrgIds = [...new Set([...fullAccessOrgIds, ...professionalOrgIds])];
  const { data: registryRows, error: registryErr } = await supabase
    .from('partner_registry')
    .select('id, partner_organization_id')
    .in('partner_organization_id', allOrgIds);
  if (registryErr || !registryRows) return null;

  const rows = registryRows as Array<{ id: string; partner_organization_id: string }>;
  const fullAccessPartnerIds = rows.filter((r) => fullAccessOrgIds.includes(r.partner_organization_id)).map((r) => r.id);
  const assignedOnlyPartnerIds = rows
    .filter((r) => professionalOrgIds.includes(r.partner_organization_id) && !fullAccessPartnerIds.includes(r.id))
    .map((r) => r.id);

  if (fullAccessPartnerIds.length === 0 && assignedOnlyPartnerIds.length === 0) return null;
  return { scope: 'org', callerId, fullAccessPartnerIds, assignedOnlyPartnerIds };
}

/** True if `access` permits acting on ANY order for this partner, regardless of assignment. */
export function hasFullPartnerAccess(access: PartnerHealthAccess, partnerId: string): boolean {
  if (access.scope === 'admin') return true;
  return access.fullAccessPartnerIds.includes(partnerId);
}

/** True if `access` permits acting on this specific order (full access, or assigned professional). */
export function canActOnOrder(
  access: PartnerHealthAccess,
  order: { partner_id: string; assigned_professional_user_id?: string | null }
): boolean {
  if (access.scope === 'admin') return true;
  if (access.fullAccessPartnerIds.includes(order.partner_id)) return true;
  return (
    access.assignedOnlyPartnerIds.includes(order.partner_id) &&
    order.assigned_professional_user_id === access.callerId
  );
}

/** All partner_registry ids `access` may see rows for at all (used to scope list queries). */
export function allVisiblePartnerIds(access: PartnerHealthAccess): string[] | null {
  if (access.scope === 'admin') return null; // null = no partner_id filter needed
  return [...access.fullAccessPartnerIds, ...access.assignedOnlyPartnerIds];
}

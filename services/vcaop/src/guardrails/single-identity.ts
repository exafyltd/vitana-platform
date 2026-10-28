/**
 * Single-identity guard (runbook Sec. 0.3 items 5/6, Sec. 3).
 *
 * At most one active `provider_account` per (tenant, provider), unless the
 * provider policy explicitly sets `multi_account_allowed=true` (default false).
 * One canonical Exafy identity per provider — never mass-register.
 */
import { SingleIdentityViolation } from './errors';

/** Account statuses considered "active" for the single-identity count (Sec. 4.2). */
const ACTIVE_STATUSES = new Set([
  'discovered',
  'policy_approved',
  'data_prepared',
  'registration_submitted',
  'kyb_pending',
  'verification_pending',
  'active',
  'degraded',
]);

/** Statuses that free the (tenant, provider) slot. */
const INACTIVE_STATUSES = new Set(['suspended', 'retired', 'failed']);

export function isActiveStatus(status: string): boolean {
  if (ACTIVE_STATUSES.has(status)) return true;
  if (INACTIVE_STATUSES.has(status)) return false;
  // Unknown status: treat as active (fail-closed — counts against the cap).
  return true;
}

export interface ExistingAccount {
  tenant_id: string;
  provider_id: string;
  status: string;
}

/**
 * Assert that creating a new active account for (tenantId, providerId) does not
 * exceed one active account, unless policy allows multi-account.
 *
 * @param existing all known accounts for this (tenant, provider)
 */
export function assertSingleActiveAccount(
  tenantId: string,
  providerId: string,
  existing: ExistingAccount[],
  multiAccountAllowed: boolean,
): void {
  if (multiAccountAllowed) return;

  const activeCount = existing.filter(
    (a) => a.tenant_id === tenantId && a.provider_id === providerId && isActiveStatus(a.status),
  ).length;

  if (activeCount >= 1) {
    throw new SingleIdentityViolation(
      `Tenant "${tenantId}" already has ${activeCount} active account(s) for provider "${providerId}" ` +
        `and policy.multi_account_allowed=false — one canonical identity only (Sec. 0.3 item 5/6)`,
    );
  }
}

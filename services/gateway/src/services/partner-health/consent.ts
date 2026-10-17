/**
 * VTID-03885 — Partner Health Test Integration: consent enforcement.
 *
 * Since VTID-05092 this is a thin layer over
 * `services/consent/health-consent.ts`, the one health-consent service.
 * `checkDataSharingConsent` keeps its VTID-03885 signature for
 * `ingestion.ts` (the choke point every ingestion path calls before writing
 * any partner_health_results/biomarker_results row) and stays fail-closed.
 *
 * The old read-then-write `grantDataSharingConsent` / `revokeDataSharingConsent`
 * are gone: they wrote the consent and its audit row as two statements and
 * ignored the audit insert's error. Every write now goes through
 * `setHealthConsent()` → `fn_set_health_consent()` (one transaction).
 *
 * Revocation is future-ingestion-only by design — it never retroactively
 * touches already-ingested data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkActiveConsentRow, type ConsentIdentity } from '../consent/health-consent';

export type { ConsentIdentity } from '../consent/health-consent';
export {
  hasHealthConsent,
  setHealthConsent,
  LEGACY_TEXT_VERSION,
} from '../consent/health-consent';

export type DataSharingResourceType = 'partner_integration';
export type DataSharingScope = 'order_tracking' | 'result_ingestion';

/** True only if an active (non-revoked) consent row exists for this exact resource+scope. Fail closed. */
export async function checkDataSharingConsent(
  sb: SupabaseClient,
  identity: ConsentIdentity,
  resourceType: DataSharingResourceType,
  resourceId: string,
  scope: DataSharingScope,
): Promise<boolean> {
  return checkActiveConsentRow(sb, identity, resourceType, resourceId, scope);
}

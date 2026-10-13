/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S7: the store's consent gate.
 *
 * Before anything is stored (S3 or database), each data category present in a
 * writeHealthSamples call is checked ONCE against the member's D10 consents
 * through findActiveHealthConsentId (fail closed: an error is "no consent").
 * The consent key comes from the map below, keyed by (source kind, data
 * category):
 *   - phone_store / aggregator -> sync_<category> for activity|sleep|heart|body
 *     (resource = connector_id); any other category -> no key;
 *   - device_cloud             -> wearables (resource = connector_id, D10 today);
 *   - partner                  -> partner_results (resource = partner id);
 *   - diary / voice / manual   -> self_logged_health.
 *
 * A2 shipped the keys not yet in D10's union (sync_*, self_logged_health) as
 * `null`; C1 (VTID-05164) added them to D10 and filled these entries in the
 * same PR — that one-map edit is C1's only edit in this module. No key, no
 * write: a null entry (phone_store/aggregator labs|habits) refuses the sample
 * (skipped_no_consent, CONSENT_CATEGORY_MISSING).
 *
 * Deletions never pass through the gate (S9: a consent check never blocks a
 * deletion). The gate is an interface: the Phase 1 consent package replaces
 * the implementation with per-data-category consent without touching ingest.
 */

import {
  HEALTH_CONSENT_CATEGORY_MAP,
  type HealthConsentCategoryKey,
} from '../consent/health-consent';
import type { HealthDataCategory } from './catalogue';
import type { HealthStoreIdentity } from './change-hook';

export type HealthStoreSourceKind = 'device_cloud' | 'aggregator' | 'phone_store' | 'partner' | 'manual' | 'voice' | 'diary';

type KeyByCategory = Readonly<Record<HealthDataCategory, HealthConsentCategoryKey | null>>;

const ALL = (key: HealthConsentCategoryKey | null): KeyByCategory =>
  Object.freeze({ activity: key, sleep: key, heart: key, body: key, labs: key, habits: key });

/** phone_store / aggregator: sync_<category> for the four Health Sync categories, nothing else (VTID-05164). */
const SYNC: KeyByCategory = Object.freeze({
  activity: 'sync_activity',
  sleep: 'sync_sleep',
  heart: 'sync_heart',
  body: 'sync_body',
  labs: null,
  habits: null,
});

/**
 * S7 consent-key map. `null` = no D10 key exists for this (kind, category):
 * the sample is refused. Entries C1 (VTID-05164) filled: phone_store/aggregator
 * activity|sleep|heart|body -> sync_<category>; diary/voice/manual (every
 * category) -> self_logged_health.
 */
export const HEALTH_STORE_CONSENT_KEY_MAP: Readonly<Record<HealthStoreSourceKind, KeyByCategory>> = Object.freeze({
  phone_store: SYNC,
  aggregator: SYNC,
  device_cloud: ALL('wearables'),
  partner: ALL('partner_results'),
  diary: ALL('self_logged_health'),
  voice: ALL('self_logged_health'),
  manual: ALL('self_logged_health'),
});

export function consentKeyFor(kind: string, category: HealthDataCategory): HealthConsentCategoryKey | null {
  const byCategory = (HEALTH_STORE_CONSENT_KEY_MAP as Record<string, KeyByCategory | undefined>)[kind];
  return byCategory?.[category] ?? null;
}

export type ConsentGateOutcome =
  | { ok: true; consent_id: string }
  | { ok: false; code: 'CONSENT_REQUIRED' | 'CONSENT_CATEGORY_MISSING' };

export type FindConsentId = (
  identity: HealthStoreIdentity,
  key: HealthConsentCategoryKey,
  resourceId?: string | null,
) => Promise<string | null>;

/**
 * One outcome per category. One consent read per distinct (key, resource);
 * a read that throws is "no consent".
 */
export async function gateCategories(
  identity: HealthStoreIdentity,
  source: { kind: string; connector_id: string | null },
  categories: Iterable<HealthDataCategory>,
  findConsentId: FindConsentId,
): Promise<Map<HealthDataCategory, ConsentGateOutcome>> {
  const out = new Map<HealthDataCategory, ConsentGateOutcome>();
  const reads = new Map<string, Promise<string | null>>();
  for (const category of new Set(categories)) {
    const key = consentKeyFor(source.kind, category);
    if (!key) {
      out.set(category, { ok: false, code: 'CONSENT_CATEGORY_MISSING' });
      continue;
    }
    const perResource = HEALTH_CONSENT_CATEGORY_MAP[key]?.per_resource === true;
    const resource = perResource ? source.connector_id ?? null : null;
    if (perResource && !resource) {
      out.set(category, { ok: false, code: 'CONSENT_REQUIRED' });
      continue;
    }
    const readKey = `${key}|${resource ?? ''}`;
    let read = reads.get(readKey);
    if (!read) {
      read = Promise.resolve()
        .then(() => findConsentId(identity, key, resource))
        .catch(() => null);
      reads.set(readKey, read);
    }
    const id = await read;
    out.set(category, typeof id === 'string' && id.length > 0 ? { ok: true, consent_id: id } : { ok: false, code: 'CONSENT_REQUIRED' });
  }
  return out;
}

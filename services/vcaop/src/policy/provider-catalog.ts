/**
 * VCAOP provider catalog — the broad "prepared list" for batch onboarding
 * (CTRL-POLICY extension). Each entry derives a conservative default policy so a
 * whole wave of providers can be registered in one go once credentials arrive.
 *
 * Conservative invariants for EVERY provider (overridable later by an admin):
 *  - registration_method: human_required   (majors are human-gated; Sec. 10)
 *  - captcha_policy: human_only             (never solve CAPTCHAs; Sec. 0.3 #3)
 *  - multi_account_allowed: false           (single canonical identity; Sec. 0.3 #5/6)
 *  - affiliate_cashback_allowed: true only for affiliate networks; false for loyalty;
 *    null (gated off) for marketplaces/travel/delivery until reviewed.
 */
import rawCatalog from './provider-catalog.json';
import { ProviderPolicy, AutomationAllowed } from '../guardrails/policy-engine';
import { ConnectorMode } from '../connectors/connector';

export type ProviderCategory = 'marketplace' | 'affiliate' | 'travel' | 'delivery' | 'loyalty';

export interface CatalogEntry {
  id: string;
  name: string;
  category: ProviderCategory;
  connectorMode: ConnectorMode;
  /** Optional explicit cashback override (else derived from category). */
  cashback?: boolean;
}

export const PROVIDER_CATALOG: readonly CatalogEntry[] = rawCatalog as CatalogEntry[];

const AUTOMATION_BY_MODE: Record<ConnectorMode, AutomationAllowed> = {
  api: 'api_only',
  oauth: 'oauth_only',
  scim: 'manual_only',
  browser: 'browser_with_human_submit',
  manual: 'manual_only',
};

function cashbackFor(e: CatalogEntry): boolean | null {
  if (typeof e.cashback === 'boolean') return e.cashback;
  if (e.category === 'affiliate') return true;
  if (e.category === 'loyalty') return false;
  return null; // marketplace/travel/delivery: gated off until reviewed
}

/** Conservative default policy for a catalog entry. */
export function policyFor(e: CatalogEntry): ProviderPolicy {
  return {
    automation_allowed: AUTOMATION_BY_MODE[e.connectorMode],
    registration_method: 'human_required',
    captcha_policy: 'human_only',
    kyb_required: e.category !== 'loyalty',
    multi_account_allowed: false,
    affiliate_cashback_allowed: cashbackFor(e),
    notes: `conservative seed (${e.category}); ToS not verified`,
  };
}

export interface ProviderRow {
  id: string;
  name: string;
  category: ProviderCategory;
  connector_mode: ConnectorMode;
  kyb_required: boolean;
  policy: ProviderPolicy;
}

/** Derive the DB `provider` row for a catalog entry. */
export function providerRowFor(e: CatalogEntry): ProviderRow {
  const policy = policyFor(e);
  return { id: e.id, name: e.name, category: e.category, connector_mode: e.connectorMode, kyb_required: policy.kyb_required, policy };
}

export const CATALOG_IDS: readonly string[] = PROVIDER_CATALOG.map((e) => e.id);

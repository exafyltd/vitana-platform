/**
 * Strongly-typed Stripe Checkout Session metadata.
 *
 * Stripe stores metadata as a flat string→string map (≤ 50 keys, ≤ 500 chars
 * each). Encode here, decode in the webhook handler. Schema version tag lets
 * us evolve the shape later without breaking in-flight sessions.
 */

import type { WalletCurrency } from '../../types/wallet';

export const CHECKOUT_METADATA_SCHEMA_VERSION = '1';

export interface WalletCheckoutMetadata {
  schema_version: typeof CHECKOUT_METADATA_SCHEMA_VERSION;
  vitana_user_id: string;
  account_id: string;
  deposit_id: string;
  currency: WalletCurrency;
  environment: string;
}

export function encodeCheckoutMetadata(m: WalletCheckoutMetadata): Record<string, string> {
  return {
    schema_version: m.schema_version,
    vitana_user_id: m.vitana_user_id,
    account_id: m.account_id,
    deposit_id: m.deposit_id,
    currency: m.currency,
    environment: m.environment,
  };
}

export function decodeCheckoutMetadata(
  raw: Record<string, string> | null | undefined
): WalletCheckoutMetadata | null {
  if (!raw) return null;
  if (raw.schema_version !== CHECKOUT_METADATA_SCHEMA_VERSION) return null;
  if (!raw.vitana_user_id || !raw.account_id || !raw.deposit_id) return null;
  if (raw.currency !== 'EUR' && raw.currency !== 'USD') return null;
  return {
    schema_version: CHECKOUT_METADATA_SCHEMA_VERSION,
    vitana_user_id: raw.vitana_user_id,
    account_id: raw.account_id,
    deposit_id: raw.deposit_id,
    currency: raw.currency,
    environment: raw.environment || 'unknown',
  };
}

/**
 * Wallet checkout metadata — VTID-03201
 *
 * Stripe stores metadata as a flat string→string map. We encode at session
 * creation and decode in the webhook handler. The schema_version tag lets
 * us evolve later; an unknown version means "ignore, don't credit".
 */

import {
  encodeCheckoutMetadata,
  decodeCheckoutMetadata,
  CHECKOUT_METADATA_SCHEMA_VERSION,
} from '../src/services/wallet/checkout-metadata';

describe('wallet checkout metadata', () => {
  const valid = {
    schema_version: CHECKOUT_METADATA_SCHEMA_VERSION,
    vitana_user_id: 'user-uuid',
    account_id: 'account-uuid',
    deposit_id: 'deposit-uuid',
    currency: 'EUR' as const,
    environment: 'production',
  };

  it('round-trips a valid metadata object', () => {
    const encoded = encodeCheckoutMetadata(valid);
    const decoded = decodeCheckoutMetadata(encoded);
    expect(decoded).toEqual(valid);
  });

  it('encodes every field as a string (Stripe metadata contract)', () => {
    const encoded = encodeCheckoutMetadata(valid);
    for (const value of Object.values(encoded)) {
      expect(typeof value).toBe('string');
    }
  });

  it('rejects null / undefined input', () => {
    expect(decodeCheckoutMetadata(null)).toBeNull();
    expect(decodeCheckoutMetadata(undefined)).toBeNull();
  });

  it('rejects an unknown schema_version (forward-compat guard)', () => {
    const encoded = encodeCheckoutMetadata(valid);
    encoded.schema_version = '99';
    expect(decodeCheckoutMetadata(encoded)).toBeNull();
  });

  it('rejects metadata missing required fields', () => {
    const encoded = encodeCheckoutMetadata(valid);
    delete (encoded as Partial<typeof encoded>).deposit_id;
    expect(decodeCheckoutMetadata(encoded)).toBeNull();
  });

  it('rejects an unsupported currency', () => {
    const encoded = encodeCheckoutMetadata(valid);
    encoded.currency = 'GBP';
    expect(decodeCheckoutMetadata(encoded)).toBeNull();
  });

  it('accepts USD', () => {
    const usd = { ...valid, currency: 'USD' as const };
    const decoded = decodeCheckoutMetadata(encodeCheckoutMetadata(usd));
    expect(decoded?.currency).toBe('USD');
  });

  it('defaults environment to "unknown" when missing', () => {
    const encoded = encodeCheckoutMetadata(valid);
    delete (encoded as Partial<typeof encoded>).environment;
    const decoded = decodeCheckoutMetadata(encoded);
    expect(decoded?.environment).toBe('unknown');
  });
});

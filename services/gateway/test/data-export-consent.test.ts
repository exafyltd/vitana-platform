/**
 * Phase 1 W2 (BOOTSTRAP-PHASE1-W2-CONSENT-METADATA) — consent-gate unit tests.
 *
 * Asserts the contract the dataset-extraction PII gate depends on: an emitted
 * event's payload carries `data_export_ok: true` ONLY when export consent is
 * established for the surface, and is absent otherwise. The producing surfaces
 * (orb-live, intent emitter, memory writer) build their payload by spreading
 * `dataExportConsentTag(...)`, so we exercise that exact path with a mock
 * consent resolver standing in for the tenant-policy read.
 */

process.env.NODE_ENV = 'test';

import {
  dataExportConsentTag,
  isDataExportConsented,
  type ConsentResolver,
} from '../src/services/data-export-consent';

const consentGranted: ConsentResolver = async () => true;
const consentDenied: ConsentResolver = async () => false;
const consentThrows: ConsentResolver = async () => {
  throw new Error('tenant policy lookup blew up');
};

describe('dataExportConsentTag', () => {
  test('includes data_export_ok:true when the consent resolver returns true', async () => {
    const tag = await dataExportConsentTag({ userId: 'u-1' }, consentGranted);
    expect(tag).toEqual({ data_export_ok: true });
  });

  test('excludes the flag entirely when the consent resolver returns false', async () => {
    const tag = await dataExportConsentTag({ userId: 'u-1' }, consentDenied);
    expect(tag).toEqual({});
    expect('data_export_ok' in tag).toBe(false);
  });

  test('fail-closed: omits the flag when the resolver throws', async () => {
    const tag = await dataExportConsentTag({ tenantId: 't-1' }, consentThrows);
    expect(tag).toEqual({});
  });
});

describe('emit payload assembly (mirrors orb-live / intent / memory surfaces)', () => {
  function buildEmitPayload(tag: Record<string, unknown>) {
    // Shape that orb-live spreads into emitOasisEvent({ payload }).
    return {
      orb_session_id: 'orb-123',
      conversation_id: 'conv-456',
      metadata: { mode: 'orb_voice' },
      ...tag,
    };
  }

  test('emit payload carries the flag for a consented surface', async () => {
    const payload = buildEmitPayload(await dataExportConsentTag({ userId: 'u-1' }, consentGranted));
    expect(payload.data_export_ok).toBe(true);
  });

  test('emit payload stays untagged for a non-consented surface', async () => {
    const payload = buildEmitPayload(await dataExportConsentTag({ userId: 'u-1' }, consentDenied));
    expect((payload as Record<string, unknown>).data_export_ok).toBeUndefined();
  });
});

describe('isDataExportConsented fail-closed defaults', () => {
  test('returns false when neither tenantId nor userId is provided', async () => {
    await expect(isDataExportConsented({})).resolves.toBe(false);
  });

  test('returns false for empty-string ids', async () => {
    await expect(isDataExportConsented({ tenantId: '', userId: '' })).resolves.toBe(false);
  });
});

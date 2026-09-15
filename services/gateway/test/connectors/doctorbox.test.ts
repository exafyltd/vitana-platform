/**
 * VTID-03885 — DoctorBox connector (sandbox/mock) tests.
 *
 * Locks the contract:
 *   - HMAC signature verification: valid/invalid/dev-mode (no secret set).
 *   - missing external_order_ref / unregistered partner -> invalid.
 *   - order not found -> quarantineUnmatchedResult (never guesses a user).
 *   - test.status_changed: raw label mapped to the canonical vocabulary,
 *     delegated to recordStatusChange; an unmapped label is rejected rather
 *     than guessed.
 *   - test.result_ready: delegated through the adapter + ingestPartnerResult.
 *   - unknown event -> invalid.
 */

import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebhookRequest } from '../../src/connectors/types';

const recordStatusChangeMock = jest.fn();
const ingestPartnerResultMock = jest.fn();
const quarantineUnmatchedResultMock = jest.fn();
jest.mock('../../src/services/partner-health/ingestion', () => ({
  recordStatusChange: (...args: any[]) => recordStatusChangeMock(...args),
  ingestPartnerResult: (...args: any[]) => ingestPartnerResultMock(...args),
  quarantineUnmatchedResult: (...args: any[]) => quarantineUnmatchedResultMock(...args),
}));

const receiveResultMock = jest.fn();
const validateResultMock = jest.fn();
jest.mock('../../src/services/partner-health/doctorbox-adapter', () => ({
  __esModule: true,
  default: {
    partnerKey: 'doctorbox',
    receiveResult: (...args: any[]) => receiveResultMock(...args),
    validateResult: (...args: any[]) => validateResultMock(...args),
  },
}));

type TableResult = { data?: unknown; error?: { message: string } | null };
let tableHandlers: Record<string, () => TableResult>;

function fakeSb() {
  return {
    from(table: string) {
      const handler = tableHandlers[table];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.maybeSingle = () => Promise.resolve(handler ? handler() : { data: null, error: null });
      return builder;
    },
  } as unknown as SupabaseClient;
}

jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => fakeSb() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const doctorBoxConnector = require('../../src/connectors/health/doctorbox').default;

const ORIGINAL_ENV = process.env.DOCTORBOX_WEBHOOK_SECRET;

function makeReq(body: Record<string, unknown>, secret?: string): WebhookRequest {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (secret) {
    headers['x-doctorbox-signature'] = createHmac('sha256', secret).update(raw).digest('hex');
  }
  return { headers, body: raw, raw_body: raw };
}

beforeEach(() => {
  jest.clearAllMocks();
  tableHandlers = {};
  delete process.env.DOCTORBOX_WEBHOOK_SECRET;
});

afterAll(() => {
  if (ORIGINAL_ENV) process.env.DOCTORBOX_WEBHOOK_SECRET = ORIGINAL_ENV;
});

describe('doctorbox connector — signature verification', () => {
  it('accepts any request in dev mode (secret unset)', async () => {
    tableHandlers.partner_registry = () => ({ data: { id: 'partner-1' } });
    tableHandlers.partner_health_test_orders = () => ({ data: null });
    quarantineUnmatchedResultMock.mockResolvedValue({ ok: true, inbox_id: 'inbox-1' });

    const res = await doctorBoxConnector.handleWebhook(makeReq({ event: 'test.status_changed', external_order_ref: 'DB-1', status: 'shipped' }));
    expect(res.valid).toBe(true);
  });

  it('rejects an invalid signature when a secret is configured', async () => {
    process.env.DOCTORBOX_WEBHOOK_SECRET = 'sandbox-secret';
    const req = makeReq({ event: 'test.status_changed', external_order_ref: 'DB-1', status: 'shipped' }, 'wrong-secret');
    const res = await doctorBoxConnector.handleWebhook(req);
    expect(res.valid).toBe(false);
    expect(res.error).toBe('signature_invalid');
  });

  it('accepts a valid signature when a secret is configured', async () => {
    process.env.DOCTORBOX_WEBHOOK_SECRET = 'sandbox-secret';
    tableHandlers.partner_registry = () => ({ data: { id: 'partner-1' } });
    tableHandlers.partner_health_test_orders = () => ({ data: null });
    quarantineUnmatchedResultMock.mockResolvedValue({ ok: true, inbox_id: 'inbox-1' });

    const req = makeReq({ event: 'test.status_changed', external_order_ref: 'DB-1', status: 'shipped' }, 'sandbox-secret');
    const res = await doctorBoxConnector.handleWebhook(req);
    expect(res.valid).toBe(true);
  });
});

describe('doctorbox connector — identity resolution', () => {
  it('rejects a payload with no external_order_ref', async () => {
    const res = await doctorBoxConnector.handleWebhook(makeReq({ event: 'test.status_changed', status: 'shipped' }));
    expect(res.valid).toBe(false);
    expect(res.error).toBe('missing_external_order_ref');
  });

  it('rejects when the partner is not registered', async () => {
    tableHandlers.partner_registry = () => ({ data: null });
    const res = await doctorBoxConnector.handleWebhook(makeReq({ event: 'test.status_changed', external_order_ref: 'DB-1', status: 'shipped' }));
    expect(res.valid).toBe(false);
    expect(res.error).toBe('partner_not_registered');
  });

  it('quarantines (never guesses) when no order matches the external_order_ref', async () => {
    tableHandlers.partner_registry = () => ({ data: { id: 'partner-1' } });
    tableHandlers.partner_health_test_orders = () => ({ data: null });
    quarantineUnmatchedResultMock.mockResolvedValue({ ok: true, inbox_id: 'inbox-1' });

    const res = await doctorBoxConnector.handleWebhook(makeReq({ event: 'test.status_changed', external_order_ref: 'DB-UNKNOWN', status: 'shipped' }));
    expect(res.valid).toBe(true);
    expect(quarantineUnmatchedResultMock).toHaveBeenCalledWith(
      expect.anything(), 'partner-1', expect.objectContaining({ external_order_ref: 'DB-UNKNOWN' }), [], 'no_match',
    );
    expect(recordStatusChangeMock).not.toHaveBeenCalled();
  });
});

describe('doctorbox connector — test.status_changed', () => {
  beforeEach(() => {
    tableHandlers.partner_registry = () => ({ data: { id: 'partner-1' } });
    tableHandlers.partner_health_test_orders = () => ({
      data: { id: 'order-1', tenant_id: 'tenant-1', user_id: 'user-1', status: 'ordered', test_name: 'Cholesterol Panel' },
    });
  });

  it('maps a known raw status and delegates to recordStatusChange', async () => {
    recordStatusChangeMock.mockResolvedValue({ ok: true });
    const res = await doctorBoxConnector.handleWebhook(makeReq({ event: 'test.status_changed', external_order_ref: 'DB-1', status: 'in_lab' }));
    expect(res.valid).toBe(true);
    expect(recordStatusChangeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to_status: 'processing', changed_by: 'partner_webhook', source_ref: 'in_lab' }),
    );
  });

  it('rejects an unmapped raw status rather than guessing', async () => {
    const res = await doctorBoxConnector.handleWebhook(makeReq({ event: 'test.status_changed', external_order_ref: 'DB-1', status: 'some_new_label_doctorbox_invented' }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/unmapped_status/);
    expect(recordStatusChangeMock).not.toHaveBeenCalled();
  });
});

describe('doctorbox connector — test.result_ready', () => {
  beforeEach(() => {
    tableHandlers.partner_registry = () => ({ data: { id: 'partner-1' } });
    tableHandlers.partner_health_test_orders = () => ({
      data: { id: 'order-1', tenant_id: 'tenant-1', user_id: 'user-1', status: 'processing', test_name: 'Cholesterol Panel' },
    });
  });

  it('delegates through the adapter + ingestPartnerResult', async () => {
    receiveResultMock.mockResolvedValue({ external_order_ref: 'DB-1', biomarkers: [], raw: {} });
    ingestPartnerResultMock.mockResolvedValue({ ok: true, quarantined: false, result_id: 'result-1', biomarker_result_ids: [] });

    const res = await doctorBoxConnector.handleWebhook(makeReq({
      event: 'test.result_ready',
      external_order_ref: 'DB-1',
      result: { result_date: '2026-09-14', biomarkers: [] },
    }));

    expect(res.valid).toBe(true);
    expect(receiveResultMock).toHaveBeenCalledWith({ result_date: '2026-09-14', biomarkers: [] });
    expect(ingestPartnerResultMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ partner_key: 'doctorbox', received_via: 'webhook' }),
    );
  });

  it('reports a quarantined outcome as valid (the webhook itself was legitimate)', async () => {
    receiveResultMock.mockResolvedValue({ external_order_ref: 'DB-1', biomarkers: [], raw: {} });
    ingestPartnerResultMock.mockResolvedValue({ ok: true, quarantined: true, reason: 'consent_missing' });

    const res = await doctorBoxConnector.handleWebhook(makeReq({ event: 'test.result_ready', external_order_ref: 'DB-1', result: {} }));
    expect(res.valid).toBe(true);
    expect(res.events[0].topic).toBe('connector.health_lab.doctorbox.result_quarantined');
  });
});

describe('doctorbox connector — unknown event', () => {
  it('rejects an unrecognized event type', async () => {
    tableHandlers.partner_registry = () => ({ data: { id: 'partner-1' } });
    tableHandlers.partner_health_test_orders = () => ({
      data: { id: 'order-1', tenant_id: 'tenant-1', user_id: 'user-1', status: 'ordered', test_name: 'Cholesterol Panel' },
    });
    const res = await doctorBoxConnector.handleWebhook(makeReq({ event: 'test.something_else', external_order_ref: 'DB-1' }));
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/unknown_event/);
  });
});

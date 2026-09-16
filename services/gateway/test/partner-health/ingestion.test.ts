/**
 * VTID-03885 — Partner Health Test Integration: ingestion pipeline tests.
 *
 * Mocked SupabaseClient (no network) + mocked notification/OASIS/i18n
 * side effects. Covers the pipeline's hard safety requirements:
 *   - consent missing -> quarantine, zero partner_health_results write
 *   - invalid payload -> quarantine, no projection into biomarker_results
 *   - valid payload -> full projection + status flip + notify + event
 *   - duplicate webhook delivery -> idempotent no-op, not a second write
 */

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../src/services/notification-service', () => ({
  notifyUserAsync: jest.fn(),
}));
jest.mock('../../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn(async () => 'en'),
}));
jest.mock('../../src/i18n/catalog', () => ({
  tt: jest.fn((key: string) => key),
}));
jest.mock('../../src/services/partner-health/consent', () => ({
  checkDataSharingConsent: jest.fn(async () => true),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ingestPartnerResult,
  recordStatusChange,
  quarantineUnmatchedResult,
  type PartnerOrderRow,
} from '../../src/services/partner-health/ingestion';
import type { PartnerResultPayload } from '../../src/services/partner-health/types';
import { emitOasisEvent } from '../../src/services/oasis-event-service';
import { notifyUserAsync } from '../../src/services/notification-service';
import { checkDataSharingConsent } from '../../src/services/partner-health/consent';

const ORDER: PartnerOrderRow = {
  id: 'order-1',
  tenant_id: 'tenant-1',
  user_id: 'user-1',
  partner_id: 'partner-1',
  partner_display_name: 'DoctorBox',
  status: 'processing',
  test_name: 'Cholesterol Panel',
};

const VALID_PAYLOAD: PartnerResultPayload = {
  external_order_ref: 'db-ext-1',
  result_date: '2026-09-10T00:00:00.000Z',
  biomarkers: [
    { name: 'LDL Cholesterol', value: 130, unit: 'mg/dL', ref_range_low: 0, ref_range_high: 100 },
    { name: 'HDL Cholesterol', value: 55, unit: 'mg/dL', ref_range_low: 40, ref_range_high: 999 },
  ],
  raw: { foo: 'bar' },
};

const alwaysValid = () => ({ valid: true, errors: [] });
const alwaysInvalid = () => ({ valid: false, errors: ['missing required field X'] });

/**
 * Queue-based fake SupabaseClient — each `.from()` call consumes the next
 * queued response in call order (this pipeline's call sequence per table is
 * deterministic per path, so ordering is enough; no need to key by table).
 */
function fakeSb(responses: Array<{ data?: unknown; error?: { message: string } | null }>) {
  const calls: Array<{ table: string; op: string; arg?: unknown }> = [];
  let i = 0;
  const client = {
    from(table: string) {
      const record = { table, op: 'select', arg: undefined as unknown };
      calls.push(record);
      const resolveVal = () => {
        const res = responses[i++] ?? { data: null, error: null };
        return { data: res.data ?? null, error: res.error ?? null };
      };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.eq = chain;
      builder.is = chain;
      builder.insert = (row: unknown) => {
        record.op = 'insert';
        record.arg = row;
        return builder;
      };
      builder.update = (row: unknown) => {
        record.op = 'update';
        record.arg = row;
        return builder;
      };
      builder.single = () => Promise.resolve(resolveVal());
      builder.maybeSingle = () => Promise.resolve(resolveVal());
      builder.then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(resolveVal()).then(onFulfilled, onRejected);
      return builder;
    },
  };
  return { sb: client as unknown as SupabaseClient, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  (checkDataSharingConsent as jest.Mock).mockResolvedValue(true);
});

describe('ingestPartnerResult', () => {
  it('quarantines when consent is missing, and never writes partner_health_results', async () => {
    (checkDataSharingConsent as jest.Mock).mockResolvedValue(false);
    const { sb, calls } = fakeSb([
      { data: null }, // idempotency check: no existing valid result
      { data: { id: 'inbox-1' } }, // inbox insert
    ]);

    const outcome = await ingestPartnerResult(sb, {
      order: ORDER,
      partner_key: 'doctorbox',
      received_via: 'webhook',
      payload: VALID_PAYLOAD,
      validate: alwaysValid,
      changed_by: 'partner_webhook',
    });

    expect(outcome).toMatchObject({ ok: true, quarantined: true, reason: 'consent_missing', inbox_id: 'inbox-1' });
    expect(calls.some((c) => c.table === 'partner_health_results' && c.op === 'insert')).toBe(false);
    expect(calls.some((c) => c.table === 'partner_health_result_inbox' && c.op === 'insert')).toBe(true);
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'health_test.result_quarantined' }));
    expect(notifyUserAsync).not.toHaveBeenCalled();
  });

  it('quarantines invalid payloads after recording provenance, never projecting into biomarker_results', async () => {
    const { sb, calls } = fakeSb([
      { data: null }, // idempotency check
      { data: { id: 'result-1' } }, // partner_health_results insert
      { data: null }, // partner_health_results update -> invalid
      { data: { id: 'inbox-2' } }, // inbox insert
    ]);

    const outcome = await ingestPartnerResult(sb, {
      order: ORDER,
      partner_key: 'doctorbox',
      received_via: 'webhook',
      payload: VALID_PAYLOAD,
      validate: alwaysInvalid,
      changed_by: 'partner_webhook',
    });

    expect(outcome).toMatchObject({ ok: true, quarantined: true, reason: 'invalid_payload', result_id: 'result-1' });
    expect(calls.some((c) => c.table === 'biomarker_results')).toBe(false);
    expect(calls.some((c) => c.table === 'lab_reports')).toBe(false);
    const inboxInsert = calls.find((c) => c.table === 'partner_health_result_inbox');
    expect((inboxInsert?.arg as { reason: string }).reason).toBe('invalid_payload');
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'health_test.result_quarantined' }));
  });

  it('projects a valid result into lab_reports/biomarker_results, flips status, notifies, and emits result_ready', async () => {
    const { sb, calls } = fakeSb([
      { data: null }, // idempotency check: no existing valid result
      { data: { id: 'result-1' } }, // partner_health_results insert
      { data: { id: 'lab-report-1' } }, // lab_reports insert
      { data: [{ id: 'bm-1' }, { id: 'bm-2' }] }, // biomarker_results insert (.select('id') without .single())
      { data: null }, // partner_health_results update -> valid
      { data: null }, // status_history insert (recordStatusChange)
      { data: null }, // partner_health_test_orders update (recordStatusChange)
    ]);

    const outcome = await ingestPartnerResult(sb, {
      order: ORDER,
      partner_key: 'doctorbox',
      received_via: 'webhook',
      payload: VALID_PAYLOAD,
      validate: alwaysValid,
      changed_by: 'partner_webhook',
    });

    expect(outcome).toMatchObject({ ok: true, quarantined: false, result_id: 'result-1' });
    if (outcome.ok && !outcome.quarantined) {
      expect(outcome.biomarker_result_ids).toEqual(['bm-1', 'bm-2']);
    }

    const labInsert = calls.find((c) => c.table === 'lab_reports' && c.op === 'insert');
    expect((labInsert?.arg as { source: string; partner_result_id: string }).source).toBe('partner:doctorbox');
    expect((labInsert?.arg as { partner_result_id: string }).partner_result_id).toBe('result-1');

    const historyInsert = calls.find((c) => c.table === 'partner_health_test_status_history' && c.op === 'insert');
    expect(historyInsert?.arg).toMatchObject({ order_id: 'order-1', from_status: 'processing', to_status: 'result_ready' });

    const orderUpdate = calls.find((c) => c.table === 'partner_health_test_orders' && c.op === 'update');
    expect(orderUpdate?.arg).toMatchObject({ status: 'result_ready' });

    expect(notifyUserAsync).toHaveBeenCalledWith('user-1', 'tenant-1', 'health_test_result_ready', expect.any(Object), sb);
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'health_test.result_ready' }));
  });

  it('is idempotent on a duplicate webhook delivery — one write, one notification, one event, ever', async () => {
    const { sb, calls } = fakeSb([
      { data: { id: 'result-1', biomarker_result_ids: ['bm-1', 'bm-2'] } }, // idempotency check finds an existing valid row
    ]);

    const outcome = await ingestPartnerResult(sb, {
      order: ORDER,
      partner_key: 'doctorbox',
      received_via: 'webhook',
      payload: VALID_PAYLOAD,
      validate: alwaysValid,
      changed_by: 'partner_webhook',
    });

    expect(outcome).toMatchObject({ ok: true, quarantined: false, result_id: 'result-1', already_processed: true, biomarker_result_ids: ['bm-1', 'bm-2'] });
    // Only the one idempotency-check read happened — no insert/update calls at all.
    expect(calls.every((c) => c.op === 'select')).toBe(true);
    expect(notifyUserAsync).not.toHaveBeenCalled();
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('recordStatusChange', () => {
  it('writes a history row, updates the order, emits status_changed, and notifies for a non-terminal status', async () => {
    const { sb, calls } = fakeSb([
      { data: null }, // status_history insert
      { data: null }, // order update
    ]);

    const result = await recordStatusChange(sb, {
      order: ORDER,
      to_status: 'sample_received',
      changed_by: 'partner_webhook',
    });

    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.table === 'partner_health_test_status_history')?.arg).toMatchObject({
      from_status: 'processing',
      to_status: 'sample_received',
    });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'health_test.status_changed' }));
    expect(notifyUserAsync).toHaveBeenCalledWith('user-1', 'tenant-1', 'partner_test_status_changed', expect.any(Object), sb);
  });

  it('does not notify for the terminal delivered status', async () => {
    const { sb } = fakeSb([{ data: null }, { data: null }]);

    await recordStatusChange(sb, {
      order: ORDER,
      to_status: 'delivered',
      changed_by: 'system',
    });

    expect(notifyUserAsync).not.toHaveBeenCalled();
  });
});

describe('quarantineUnmatchedResult', () => {
  it('inserts an inbox row with the given reason and emits result_quarantined, never touching partner_health_results', async () => {
    const { sb, calls } = fakeSb([{ data: { id: 'inbox-9' } }]);

    const outcome = await quarantineUnmatchedResult(sb, 'partner-1', { any: 'thing' }, ['user-a', 'user-b'], 'ambiguous_match');

    expect(outcome).toMatchObject({ ok: true, inbox_id: 'inbox-9' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'partner_health_result_inbox', op: 'insert' });
    expect((calls[0].arg as { reason: string }).reason).toBe('ambiguous_match');
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'health_test.result_quarantined' }));
  });
});

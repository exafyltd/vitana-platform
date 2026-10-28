/**
 * VTID-03885 — Partner Health Test Integration: ORB voice tool tests.
 *
 * Locks the contract:
 *   - Both tools require an authenticated user.
 *   - get_health_test_status: honest "nothing on file" when empty, narrates
 *     the canonical status (never a raw partner label) + partner name for
 *     the latest order, respects an optional test_name filter.
 *   - get_health_test_result: honest "not ready yet" when no result_ready/
 *     delivered order exists, and when a result_ready order exists but has
 *     no biomarker_result_ids yet; narrates real biomarker values once
 *     they're there.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  tool_get_health_test_status,
  tool_get_health_test_result,
} from '../../src/services/orb-tools/partner-health-test-tools';

const IDENT: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const NO_USER: OrbToolIdentity = { user_id: '', tenant_id: 't-1', role: null };

type TableResult = { data?: unknown; error?: { message: string } | null };
type TableConfig = TableResult | ((call: { table: string; filters: Array<Record<string, unknown>> }) => TableResult);

function fakeSb(config: Record<string, TableConfig>) {
  const client = {
    from(table: string) {
      const call = { table, filters: [] as Array<Record<string, unknown>> };
      const resolveVal = () => {
        const cfg = config[table];
        const res = typeof cfg === 'function' ? cfg(call) : cfg ?? { data: [], error: null };
        return { data: res.data ?? null, error: res.error ?? null };
      };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.ilike = chain;
      builder.eq = (k: string, v: unknown) => {
        call.filters.push({ [k]: v });
        return builder;
      };
      builder.in = (k: string, v: unknown) => {
        call.filters.push({ [`in:${k}`]: v });
        return builder;
      };
      builder.maybeSingle = () => Promise.resolve(resolveVal());
      builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resolveVal()).then(onFulfilled, onRejected);
      return builder;
    },
  };
  return client as unknown as SupabaseClient;
}

describe('tool_get_health_test_status', () => {
  it('requires an authenticated user', async () => {
    const res = await tool_get_health_test_status({}, NO_USER, fakeSb({}));
    expect(res.ok).toBe(false);
  });

  it('is honest when there are no partner health tests on file', async () => {
    const sb = fakeSb({ partner_health_test_orders: { data: [] } });
    const res = await tool_get_health_test_status({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/don't have any partner health tests on file/);
  });

  it('is honest when a test_name filter matches nothing', async () => {
    const sb = fakeSb({ partner_health_test_orders: { data: [] } });
    const res = await tool_get_health_test_status({ test_name: 'cholesterol' }, IDENT, sb);
    expect(res.text).toMatch(/don't have a "cholesterol" test on file/);
  });

  it('narrates the canonical status + partner name for the latest order', async () => {
    const sb = fakeSb({
      partner_health_test_orders: {
        data: [
          {
            id: 'order-1',
            test_name: 'Cholesterol Panel',
            status: 'processing',
            status_updated_at: '2026-09-14T00:00:00Z',
            partner_registry: { display_name: 'DoctorBox' },
          },
        ],
      },
    });
    const res = await tool_get_health_test_status({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(res.text).toBe('Your Cholesterol Panel from DoctorBox is being processed at the lab.');
  });

  it('falls back to the raw canonical status value when unmapped, and omits the partner clause when unknown', async () => {
    const sb = fakeSb({
      partner_health_test_orders: {
        data: [{ id: 'order-1', test_name: 'Vitamin D', status: 'quarantined', status_updated_at: '2026-09-14T00:00:00Z', partner_registry: null }],
      },
    });
    const res = await tool_get_health_test_status({}, IDENT, sb);
    expect(res.text).toBe('Your Vitamin D is being checked by our team before it can be shown to you.');
  });
});

describe('tool_get_health_test_result', () => {
  it('requires an authenticated user', async () => {
    const res = await tool_get_health_test_result({}, NO_USER, fakeSb({}));
    expect(res.ok).toBe(false);
  });

  it('is honest when no result_ready/delivered order exists', async () => {
    const sb = fakeSb({ partner_health_test_orders: { data: [] } });
    const res = await tool_get_health_test_result({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(res.result).toBeNull();
    expect(res.text).toMatch(/don't have a completed partner health test result/);
  });

  it('is honest when the order is ready but biomarkers are not populated yet', async () => {
    const sb = fakeSb({
      partner_health_test_orders: { data: [{ id: 'order-1', test_name: 'Cholesterol Panel', status: 'result_ready' }] },
      partner_health_results: { data: null },
    });
    const res = await tool_get_health_test_result({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/marked ready, but I can't find the individual values yet/);
  });

  it('narrates real biomarker values once available', async () => {
    const sb = fakeSb({
      partner_health_test_orders: { data: [{ id: 'order-1', test_name: 'Cholesterol Panel', status: 'result_ready' }] },
      partner_health_results: { data: { biomarker_result_ids: ['bm-1', 'bm-2'] } },
      biomarker_results: {
        data: [
          { name: 'LDL Cholesterol', value: 130, unit: 'mg/dL', status: 'high' },
          { name: 'HDL Cholesterol', value: 55, unit: 'mg/dL', status: 'normal' },
        ],
      },
    });
    const res = await tool_get_health_test_result({}, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(res.text).toBe("Here's your Cholesterol Panel: LDL Cholesterol: 130 mg/dL (high); HDL Cholesterol: 55 mg/dL (normal).");
  });
});

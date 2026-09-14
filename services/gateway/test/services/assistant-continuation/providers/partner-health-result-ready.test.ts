/**
 * VTID-03885 — partner-health-result-ready provider tests.
 *
 * Locks the contract:
 *   - Skips on missing inputs.
 *   - Suppresses (no_unsurfaced_result) when the query returns nothing.
 *   - Errors when the query throws.
 *   - Fires (status=returned, priority 94.5, kind=wake_brief) with a
 *     grounded line naming the real test/partner, and marks the order
 *     surfaced (surfaced_at update) before returning.
 *   - cta is a deterministic navigate to /health.
 *   - dedupeKey is keyed to the order id.
 *   - EN + DE render.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  makePartnerHealthResultReadyProvider,
  renderPartnerHealthResultReadyLine,
  PARTNER_HEALTH_RESULT_READY_PROVIDER_KEY,
  PARTNER_HEALTH_RESULT_READY_EXTRA_KEY,
  PARTNER_HEALTH_RESULT_READY_PRIORITY,
} from '../../../../src/services/assistant-continuation/providers/partner-health-result-ready';

interface QueryResult {
  data?: unknown;
  error?: { message: string } | null;
}

/** Minimal fake matching the one `.from('partner_health_test_orders')` select then update this provider issues. */
function fakeSb(selectResult: QueryResult) {
  const calls: Array<{ op: string; arg?: unknown }> = [];
  const client = {
    from(_table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = chain;
      builder.is = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.update = (row: unknown) => {
        calls.push({ op: 'update', arg: row });
        return builder;
      };
      builder.maybeSingle = () => {
        calls.push({ op: 'select' });
        return Promise.resolve({ data: selectResult.data ?? null, error: selectResult.error ?? null });
      };
      // update(...).eq(id) is awaited directly without a further resolver call
      builder.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onFulfilled);
      return builder;
    },
  };
  return { sb: client as unknown as SupabaseClient, calls };
}

function makeCtx(sb: SupabaseClient, extraOverride: Record<string, unknown> = {}) {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: {
      [PARTNER_HEALTH_RESULT_READY_EXTRA_KEY]: {
        supabase: sb,
        userId: 'u1',
        tenantId: 't1',
        lang: 'en',
        ...extraOverride,
      },
    },
  } as any;
}

describe('renderPartnerHealthResultReadyLine', () => {
  it('names the test and partner in English', () => {
    const line = renderPartnerHealthResultReadyLine({ lang: 'en', testName: 'Cholesterol Panel', partnerName: 'DoctorBox' });
    expect(line).toBe("Your Cholesterol Panel results from DoctorBox are in — I can walk you through them.");
  });

  it('renders real German', () => {
    const line = renderPartnerHealthResultReadyLine({ lang: 'de', testName: 'Cholesterol Panel', partnerName: 'DoctorBox' });
    expect(line).toBe('Deine Cholesterol Panel-Ergebnisse von DoctorBox sind da — ich kann sie mit dir durchgehen.');
  });

  it('omits the partner clause cleanly when unknown', () => {
    const line = renderPartnerHealthResultReadyLine({ lang: 'en', testName: 'Cholesterol Panel', partnerName: null });
    expect(line).toBe('Your Cholesterol Panel results are in — I can walk you through them.');
  });
});

describe('partner-health-result-ready provider', () => {
  const baseOpts = { now: () => 1_000 };

  it('has the right key, surface, and priority', () => {
    const p = makePartnerHealthResultReadyProvider(baseOpts);
    expect(p.key).toBe(PARTNER_HEALTH_RESULT_READY_PROVIDER_KEY);
    expect(p.surfaces).toEqual(['orb_wake']);
    expect(PARTNER_HEALTH_RESULT_READY_PRIORITY).toBe(94.5);
  });

  it('skips when inputs are missing', async () => {
    const p = makePartnerHealthResultReadyProvider(baseOpts);
    const res = await p.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no_partner_health_inputs');
  });

  it('suppresses when there is no unsurfaced result', async () => {
    const { sb } = fakeSb({ data: null });
    const p = makePartnerHealthResultReadyProvider(baseOpts);
    const res = await p.produce(makeCtx(sb));
    expect(res.status).toBe('suppressed');
    expect(res.reason).toBe('no_unsurfaced_result');
  });

  it('errors when the query throws', async () => {
    const { sb } = fakeSb({ data: null, error: { message: 'boom' } });
    const p = makePartnerHealthResultReadyProvider(baseOpts);
    const res = await p.produce(makeCtx(sb));
    expect(res.status).toBe('errored');
    expect(res.reason).toMatch(/boom/);
  });

  it('fires with a grounded line and marks the order surfaced', async () => {
    const { sb, calls } = fakeSb({
      data: { id: 'order-1', test_name: 'Cholesterol Panel', partner_registry: { display_name: 'DoctorBox' } },
    });
    const p = makePartnerHealthResultReadyProvider(baseOpts);
    const res = await p.produce(makeCtx(sb));
    expect(res.status).toBe('returned');
    expect(res.candidate?.priority).toBe(94.5);
    expect(res.candidate?.kind).toBe('wake_brief');
    expect(res.candidate?.userFacingLine).toBe("Your Cholesterol Panel results from DoctorBox are in — I can walk you through them.");
    const updateCall = calls.find((c) => c.op === 'update');
    expect(updateCall?.arg).toHaveProperty('surfaced_at');
  });

  it('sets a deterministic navigate cta to /health carrying the order id', async () => {
    const { sb } = fakeSb({ data: { id: 'order-42', test_name: 'Vitamin D', partner_registry: { display_name: 'DoctorBox' } } });
    const p = makePartnerHealthResultReadyProvider(baseOpts);
    const res = await p.produce(makeCtx(sb));
    expect(res.candidate?.cta).toEqual({
      type: 'navigate',
      route: '/health',
      payload: { screen_id: 'HEALTH.LAB_RESULTS', order_id: 'order-42' },
    });
  });

  it('dedupeKey is keyed to the order id', async () => {
    const { sb } = fakeSb({ data: { id: 'order-99', test_name: 'Vitamin D', partner_registry: null } });
    const p = makePartnerHealthResultReadyProvider(baseOpts);
    const res = await p.produce(makeCtx(sb));
    expect(res.candidate?.dedupeKey).toBe('partner-health-result-ready:order-99');
  });
});

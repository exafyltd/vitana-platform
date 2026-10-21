/**
 * VTID-03260 — Phase 2 getMonthlySpend() unit tests.
 *
 * getMonthlySpend sums product_orders.amount_cents for ONE user, in ONE
 * currency, restricted to state='converted' and the current calendar month.
 * These tests assert:
 *   - it scopes the query with eq(user_id), eq(currency), eq(state,'converted'),
 *     gte(purchased_at, start-of-month) — so refunded/cancelled rows, prior
 *     months, and other currencies are excluded at the source;
 *   - it sums only what the (already-scoped) query returns;
 *   - it degrades to 0 on error / null client.
 */

import { getMonthlySpend, startOfMonthIso } from '../../src/services/budget/spend-service';

type Filter = { op: string; args: any[] };

/** Recording mock: captures every filter applied, returns the seeded rows. */
function makeRecordingClient(rows: any[] | null, error: any = null) {
  const filters: Filter[] = [];
  const builder: any = {
    from: (...a: any[]) => { filters.push({ op: 'from', args: a }); return builder; },
    select: (...a: any[]) => { filters.push({ op: 'select', args: a }); return builder; },
    eq: (...a: any[]) => { filters.push({ op: 'eq', args: a }); return builder; },
    gte: (...a: any[]) => { filters.push({ op: 'gte', args: a }); return builder; },
    then: (resolve: any) => Promise.resolve({ data: rows, error }).then(resolve),
  };
  return { client: builder as any, filters };
}

const USER = '11111111-1111-4000-a000-000000000a01';

const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => consoleErrorSpy.mockClear());

describe('VTID-03260 getMonthlySpend — query scoping', () => {
  test('applies user_id, currency, state=converted, and current-month gte filters', async () => {
    const { client, filters } = makeRecordingClient([{ amount_cents: 1000 }, { amount_cents: 500 }]);
    const total = await getMonthlySpend(client, USER, 'EUR');

    expect(total).toBe(1500);

    expect(filters.some((f) => f.op === 'from' && f.args[0] === 'product_orders')).toBe(true);
    expect(filters.some((f) => f.op === 'eq' && f.args[0] === 'user_id' && f.args[1] === USER)).toBe(true);
    expect(filters.some((f) => f.op === 'eq' && f.args[0] === 'currency' && f.args[1] === 'EUR')).toBe(true);
    // EXCLUDES refunded/cancelled/pending/chargeback — only 'converted' is summed.
    expect(filters.some((f) => f.op === 'eq' && f.args[0] === 'state' && f.args[1] === 'converted')).toBe(true);
    // EXCLUDES prior months via gte(purchased_at, start-of-month).
    const gte = filters.find((f) => f.op === 'gte' && f.args[0] === 'purchased_at');
    expect(gte).toBeDefined();
    expect(gte!.args[1]).toBe(startOfMonthIso());
  });

  test('per-currency only — a USD query carries currency=USD (never mixes)', async () => {
    const { client, filters } = makeRecordingClient([{ amount_cents: 2500 }]);
    const total = await getMonthlySpend(client, USER, 'USD');
    expect(total).toBe(2500);
    expect(filters.some((f) => f.op === 'eq' && f.args[0] === 'currency' && f.args[1] === 'USD')).toBe(true);
    expect(filters.some((f) => f.op === 'eq' && f.args[0] === 'currency' && f.args[1] === 'EUR')).toBe(false);
  });

  test('sums only the rows the scoped query returns', async () => {
    const { client } = makeRecordingClient([
      { amount_cents: 100 },
      { amount_cents: 250 },
      { amount_cents: null }, // tolerated → treated as 0
    ]);
    expect(await getMonthlySpend(client, USER, 'EUR')).toBe(350);
  });

  test('empty result → 0', async () => {
    const { client } = makeRecordingClient([]);
    expect(await getMonthlySpend(client, USER, 'EUR')).toBe(0);
  });

  test('query error → 0 (advisory read must not throw)', async () => {
    const { client } = makeRecordingClient(null, { message: 'boom' });
    expect(await getMonthlySpend(client, USER, 'EUR')).toBe(0);
  });

  test('null client → 0', async () => {
    expect(await getMonthlySpend(null, USER, 'EUR')).toBe(0);
  });
});

describe('VTID-03260 startOfMonthIso', () => {
  test('returns the first instant of the current UTC month', () => {
    const fixed = new Date(Date.UTC(2026, 5, 17, 13, 45, 0)); // 2026-06-17
    expect(startOfMonthIso(fixed)).toBe('2026-06-01T00:00:00.000Z');
  });
});

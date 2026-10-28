/**
 * new-facts-detector — unit tests (BOOTSTRAP-MEMORY-DAILY-LEARNING)
 *
 * Contract:
 *   - counts non-superseded memory_facts newer than the cutoff
 *   - clamps the cutoff to LOOKBACK_CAP_MS (returning users aren't flooded)
 *   - excludes plumbing keys (preferred_language) from count and sample
 *   - sample capped at 3, values truncated
 *   - degrades to zero on error
 *   - surfaced-stamp read/write round-trips through user_assistant_state
 */

import {
  detectNewFacts,
  markLearningSurfaced,
  readLearningSurfacedAt,
  LOOKBACK_CAP_MS,
  SIGNAL_LEARNING_SURFACED,
} from '../../../src/services/conversation/new-facts-detector';

interface Recorded {
  method: string;
  args: any[];
}

function makeClient(rows: any[] | null, error: any = null) {
  const calls: Recorded[] = [];
  const upserts: any[] = [];
  const chain: any = {};
  for (const m of ['select', 'eq', 'is', 'gt', 'order', 'limit', 'in', 'like']) {
    chain[m] = (...args: any[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  chain.maybeSingle = () => Promise.resolve({ data: rows?.[0] ?? null, error });
  chain.then = (res: any, rej: any) => Promise.resolve({ data: rows, error }).then(res, rej);
  const client: any = {
    from: jest.fn(() => chain),
  };
  chain.upsert = (row: any) => {
    upserts.push(row);
    return Promise.resolve({ data: null, error: null });
  };
  return { client, calls, upserts };
}

describe('detectNewFacts', () => {
  const NOW = Date.parse('2026-07-06T12:00:00Z');

  it('counts fresh facts and returns a capped sample', async () => {
    const rows = [
      { fact_key: 'user_favorite_tea', fact_value: 'Earl Grey' },
      { fact_key: 'user_preference_exercise', fact_value: 'morning runs' },
      { fact_key: 'spouse_name', fact_value: 'Maria' },
      { fact_key: 'user_hobby_dance', fact_value: 'salsa' },
    ];
    const { client } = makeClient(rows);
    const result = await detectNewFacts({
      supabase: client,
      userId: 'u1',
      sinceIso: '2026-07-06T00:00:00Z',
      nowMs: NOW,
    });
    expect(result.count).toBe(4);
    expect(result.sample).toHaveLength(3);
    expect(result.sample[0]).toEqual({ key: 'user_favorite_tea', value: 'Earl Grey' });
  });

  it('excludes plumbing keys like preferred_language', async () => {
    const { client } = makeClient([
      { fact_key: 'preferred_language', fact_value: 'de' },
      { fact_key: 'user_name', fact_value: 'Dragan' },
    ]);
    const result = await detectNewFacts({
      supabase: client,
      userId: 'u1',
      sinceIso: '2026-07-06T00:00:00Z',
      nowMs: NOW,
    });
    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.key)).toEqual(['user_name']);
  });

  it('clamps the cutoff to the 7-day lookback cap', async () => {
    const { client, calls } = makeClient([]);
    await detectNewFacts({
      supabase: client,
      userId: 'u1',
      sinceIso: '2020-01-01T00:00:00Z', // ancient last session
      nowMs: NOW,
    });
    const gtCall = calls.find((c) => c.method === 'gt');
    expect(gtCall).toBeDefined();
    expect(gtCall!.args[0]).toBe('extracted_at');
    expect(Date.parse(gtCall!.args[1])).toBe(NOW - LOOKBACK_CAP_MS);
  });

  it('filters superseded rows and tenant-scopes when given', async () => {
    const { client, calls } = makeClient([]);
    await detectNewFacts({
      supabase: client,
      userId: 'u1',
      tenantId: 't1',
      sinceIso: '2026-07-06T00:00:00Z',
      nowMs: NOW,
    });
    expect(calls).toContainEqual({ method: 'is', args: ['superseded_at', null] });
    expect(calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
  });

  it('returns zero on query error and on missing inputs', async () => {
    const { client } = makeClient(null, { message: 'boom' });
    expect(
      await detectNewFacts({ supabase: client, userId: 'u1', sinceIso: '2026-07-06T00:00:00Z' }),
    ).toEqual({ count: 0, sample: [] });
    expect(await detectNewFacts({ supabase: client, userId: '', sinceIso: 'x' })).toEqual({
      count: 0,
      sample: [],
    });
  });
});

describe('learning-surfaced stamp', () => {
  it('markLearningSurfaced upserts the signal row', async () => {
    const { client, upserts } = makeClient([]);
    await markLearningSurfaced(client, 't1', 'u1', 3, '2026-07-06T18:10:00Z');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      tenant_id: 't1',
      user_id: 'u1',
      signal_name: SIGNAL_LEARNING_SURFACED,
      value: { surfaced_at: '2026-07-06T18:10:00Z', count: 3 },
    });
  });

  it('readLearningSurfacedAt returns the stamp or null', async () => {
    const { client } = makeClient([{ value: { surfaced_at: '2026-07-06T18:10:00Z', count: 3 } }]);
    expect(await readLearningSurfacedAt(client, 't1', 'u1')).toBe('2026-07-06T18:10:00Z');
    const { client: emptyClient } = makeClient([]);
    expect(await readLearningSurfacedAt(emptyClient, 't1', 'u1')).toBeNull();
  });
});

/**
 * preference-facts — unit tests (BOOTSTRAP-MEMORY-DAILY-LEARNING)
 *
 * Contract under test:
 *   - reads memory_facts filtered to the user_preference_* prefix with
 *     superseded rows excluded (and tenant scoping when provided)
 *   - provenance_source 'user_stated' → explicit (always kept);
 *     everything else → inferred, dropped below the 0.55 floor
 *   - newest row per key wins; a skipped (low-confidence) key is not
 *     resurrected from an older row
 *   - degrades to [] on query error / throwing client
 */

import {
  fetchPreferenceFacts,
  PREFERENCE_FACT_KEY_PREFIX,
  INFERRED_PREFERENCE_MIN_CONFIDENCE,
} from '../../src/services/preference-facts';

interface RecordedCall {
  method: string;
  args: any[];
}

function makeClient(rows: any[], error: any = null) {
  const calls: RecordedCall[] = [];
  const chain: any = {};
  for (const m of ['select', 'eq', 'like', 'is', 'order', 'limit', 'gte', 'in']) {
    chain[m] = (...args: any[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  chain.then = (resolve: any, reject: any) =>
    Promise.resolve({ data: rows, error }).then(resolve, reject);
  const client = { from: jest.fn(() => chain) };
  return { client, calls };
}

const fact = (key: string, value: string, source: string, confidence: number) => ({
  fact_key: `${PREFERENCE_FACT_KEY_PREFIX}${key}`,
  fact_value: value,
  provenance_source: source,
  provenance_confidence: confidence,
});

describe('fetchPreferenceFacts', () => {
  it('maps user_stated to explicit and other provenance to inferred', async () => {
    const { client } = makeClient([
      fact('exercise', 'morning runs', 'user_stated', 0.8),
      fact('music', 'jazz', 'assistant_inferred', 0.7),
      fact('sessions', 'evening', 'behavior_inferred', 0.6),
    ]);
    const result = await fetchPreferenceFacts(client, 'u1');
    expect(result).toEqual([
      { key: 'exercise', value: 'morning runs', source: 'explicit', confidence: 0.8 },
      { key: 'music', value: 'jazz', source: 'inferred', confidence: 0.7 },
      { key: 'sessions', value: 'evening', source: 'inferred', confidence: 0.6 },
    ]);
  });

  it(`drops inferred facts below the ${INFERRED_PREFERENCE_MIN_CONFIDENCE} confidence floor but keeps low-confidence explicit ones`, async () => {
    const { client } = makeClient([
      fact('diet', 'vegetarian', 'assistant_inferred', 0.3),
      fact('drink', 'green tea', 'user_stated', 0.2),
    ]);
    const result = await fetchPreferenceFacts(client, 'u1');
    expect(result.map((r) => r.key)).toEqual(['drink']);
  });

  it('keeps only the newest row per key and never resurrects a skipped key', async () => {
    // Rows arrive newest-first (order extracted_at desc).
    const { client } = makeClient([
      fact('music', 'techno', 'assistant_inferred', 0.4), // newest, below floor → key skipped
      fact('music', 'jazz', 'user_stated', 0.9), // older — must NOT come back
      fact('drink', 'coffee', 'user_stated', 0.8),
      fact('drink', 'tea', 'user_stated', 0.8), // older duplicate — dropped
    ]);
    const result = await fetchPreferenceFacts(client, 'u1');
    expect(result).toEqual([{ key: 'drink', value: 'coffee', source: 'explicit', confidence: 0.8 }]);
  });

  it('respects the limit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => fact(`k${i}`, `v${i}`, 'user_stated', 0.8));
    const { client } = makeClient(rows);
    const result = await fetchPreferenceFacts(client, 'u1', { limit: 3 });
    expect(result).toHaveLength(3);
  });

  it('filters on the user_preference_ prefix, excludes superseded rows, and tenant-scopes when given', async () => {
    const { client, calls } = makeClient([]);
    await fetchPreferenceFacts(client, 'u1', { tenantId: 't1' });
    expect(client.from).toHaveBeenCalledWith('memory_facts');
    expect(calls).toContainEqual({ method: 'like', args: ['fact_key', `${PREFERENCE_FACT_KEY_PREFIX}%`] });
    expect(calls).toContainEqual({ method: 'is', args: ['superseded_at', null] });
    expect(calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
  });

  it('returns [] on query error and on a throwing client', async () => {
    const { client: errClient } = makeClient(null as any, { message: 'boom' });
    expect(await fetchPreferenceFacts(errClient, 'u1')).toEqual([]);

    const throwing = { from: () => { throw new Error('no like method'); } };
    expect(await fetchPreferenceFacts(throwing as any, 'u1')).toEqual([]);
  });

  it('returns [] without querying when client or userId is missing', async () => {
    expect(await fetchPreferenceFacts(null as any, 'u1')).toEqual([]);
    const { client } = makeClient([]);
    expect(await fetchPreferenceFacts(client, '')).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });
});

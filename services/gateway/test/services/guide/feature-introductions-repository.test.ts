import * as repo from '../../../src/services/guide/feature-introductions-repository';

/**
 * Functional stub Supabase client — a from()-chain that records every call
 * and resolves to a configurable {data,error,count} response, matching the
 * pattern used for the other B1 repository tests.
 */
function makeSupabaseStub(response: { data?: any; error?: any; count?: number | null } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of [
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'like', 'or',
    'order', 'limit', 'range', 'filter', 'update', 'insert', 'upsert', 'delete',
  ]) {
    chain[m] = record(m);
  }
  chain.single = jest.fn(() => Promise.resolve(resolved));
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });

  return { from, calls, chain };
}

describe('feature-introductions-repository', () => {
  describe('fetchFeatureIntroductions', () => {
    it('scopes by user_id, newest-first, capped at 50', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchFeatureIntroductions(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('user_feature_introductions');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['feature_key, introduced_at, channel'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['introduced_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [50] });
    });
  });

  describe('upsertFeatureIntroduction', () => {
    it('conflicts on user_id,feature_key', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', feature_key: 'life_compass', introduced_at: 'iso', channel: 'voice', context: {} };
      await repo.upsertFeatureIntroduction(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('user_feature_introductions');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'user_id,feature_key' }] });
    });
  });
});

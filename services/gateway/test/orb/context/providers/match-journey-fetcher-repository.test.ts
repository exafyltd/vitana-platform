import * as repo from '../../../../src/orb/context/providers/match-journey-fetcher-repository';

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

describe('match-journey-fetcher-repository', () => {
  describe('fetchVitanaIdForUser', () => {
    it('scopes by user_id, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchVitanaIdForUser(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('profiles');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['vitana_id'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });

  describe('fetchLatestIntentMatch', () => {
    it('scopes by vitana_id_a, orders state_changed_at then created_at desc, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchLatestIntentMatch(sb as any, 'v1');
      expect(sb.from).toHaveBeenCalledWith('intent_matches');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: ['match_id, intent_a_id, state, state_changed_at, created_at'],
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['vitana_id_a', 'v1'] });
      expect(sb.calls).toContainEqual({
        method: 'order',
        args: ['state_changed_at', { ascending: false, nullsFirst: false }],
      });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });
});

import * as repo from '../../../src/services/journey-stage/journey-stage-fetcher-repository';

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

describe('journey-stage-fetcher-repository', () => {
  describe('fetchAppUserById', () => {
    it('scopes by user_id, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchAppUserById(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['user_id, created_at'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });

  describe('fetchUserActiveDays', () => {
    it('scopes by user_id, newest-first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUserActiveDays(sb as any, 'u1', 1000);
      expect(sb.from).toHaveBeenCalledWith('user_active_days');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['active_date'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['active_date', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1000] });
    });
  });

  describe('fetchVitanaIndexHistory', () => {
    it('scopes by tenant_id + user_id, newest-first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchVitanaIndexHistory(sb as any, 't1', 'u1', 30);
      expect(sb.from).toHaveBeenCalledWith('vitana_index_scores');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['date, score_total'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['date', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [30] });
    });
  });
});

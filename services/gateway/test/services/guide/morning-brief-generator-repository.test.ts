import * as repo from '../../../src/services/guide/morning-brief-generator-repository';

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

describe('morning-brief-generator-repository', () => {
  describe('fetchLatestIndexScore', () => {
    it('scopes by user_id, newest-first, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchLatestIndexScore(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('vitana_index_scores');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['score_total, date'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['date', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('fetchFirstIndexScoreDate', () => {
    it('scopes by user_id, oldest-first, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchFirstIndexScoreDate(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('vitana_index_scores');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['date'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['date', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('fetchTopNewCommunityRecommendations', () => {
    it('scopes by user_id + community source_type + new status, ranked by impact_score, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchTopNewCommunityRecommendations(sb as any, 'u1', 10);
      expect(sb.from).toHaveBeenCalledWith('autopilot_recommendations');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: ['id, title, source_ref, impact_score, economic_axis, contribution_vector, domain, status'],
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['source_type', 'community'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'new'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['impact_score', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [10] });
    });
  });
});

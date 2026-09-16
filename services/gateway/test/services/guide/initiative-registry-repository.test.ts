import * as repo from '../../../src/services/guide/initiative-registry-repository';

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

describe('initiative-registry-repository', () => {
  describe('fetchTopOpenAutopilotRecommendation', () => {
    it('scopes by user_id + new/pending status, highest-priority-first, limit 1', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchTopOpenAutopilotRecommendation(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('autopilot_recommendations');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, title, summary, priority'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['status', ['new', 'pending']] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['priority', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('fetchMostDormantConnectionNode', () => {
    it('scopes by owner_user_id + person node type, oldest-updated-first, limit 1', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchMostDormantConnectionNode(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('relationship_nodes');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, display_name, metadata'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['owner_user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['node_type', 'person'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['updated_at', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });
});

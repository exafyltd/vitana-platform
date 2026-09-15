import * as repo from '../../../src/services/concept-mastery/concept-mastery-fetcher-repository';

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

describe('concept-mastery-fetcher-repository', () => {
  describe('fetchConceptMasteryState', () => {
    it('scopes by tenant_id + user_id + the three signal-name families, newest-first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchConceptMasteryState(sb as any, 't1', 'u1', 200);
      expect(sb.from).toHaveBeenCalledWith('user_assistant_state');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: ['signal_name, value, count, confidence, source, last_seen_at'],
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({
        method: 'or',
        args: ['signal_name.like.concept_explained:%,signal_name.like.concept_mastery:%,signal_name.like.dyk_card_seen:%'],
      });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['last_seen_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [200] });
    });
  });
});

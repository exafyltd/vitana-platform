import * as repo from '../../../src/services/guide/pause-check-repository';

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

describe('pause-check-repository', () => {
  describe('fetchActivePauses', () => {
    it('scopes by user_id, still-active (paused_until > now), newest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActivePauses(sb as any, 'u1', '2026-08-29T00:00:00Z');
      expect(sb.from).toHaveBeenCalledWith('user_proactive_pause');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['*'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'gt', args: ['paused_until', '2026-08-29T00:00:00Z'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
    });
  });
});

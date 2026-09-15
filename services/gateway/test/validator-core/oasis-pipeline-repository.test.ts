import * as repo from '../../src/validator-core/oasis-pipeline-repository';

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

describe('oasis-pipeline-repository', () => {
  describe('insertOasisEventV1', () => {
    it('inserts into oasis_events_v1', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { task_type: 'x', metadata: {}, vtid: 'VTID-00000' };
      await repo.insertOasisEventV1(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('oasis_events_v1');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
    });
  });
});

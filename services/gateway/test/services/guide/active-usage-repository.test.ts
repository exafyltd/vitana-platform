import * as repo from '../../../src/services/guide/active-usage-repository';

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

describe('active-usage-repository', () => {
  describe('upsertActiveUsageDay', () => {
    it('conflicts on user_id,active_date, ignoring duplicates', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.upsertActiveUsageDay(sb as any, 'u1', '2026-08-29');
      expect(sb.from).toHaveBeenCalledWith('user_active_days');
      expect(sb.calls).toContainEqual({
        method: 'upsert',
        args: [
          { user_id: 'u1', active_date: '2026-08-29' },
          { onConflict: 'user_id,active_date', ignoreDuplicates: true },
        ],
      });
    });
  });

  describe('countActiveUsageDaysForUser', () => {
    it('scopes by user_id, exact head-only count', async () => {
      const sb = makeSupabaseStub({ count: 3 });
      await repo.countActiveUsageDaysForUser(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('user_active_days');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['user_id', { count: 'exact', head: true }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });
});

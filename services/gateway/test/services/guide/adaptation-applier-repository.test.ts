import * as repo from '../../../src/services/guide/adaptation-applier-repository';

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

describe('adaptation-applier-repository', () => {
  describe('fetchPendingAdaptationPlans', () => {
    it('requires approved_at non-null and applied_at null', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchPendingAdaptationPlans(sb as any, 'u1', 20);
      expect(sb.from).toHaveBeenCalledWith('adaptation_plans');
      expect(sb.calls).toContainEqual({ method: 'not', args: ['approved_at', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'is', args: ['applied_at', null] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [20] });
    });
  });

  describe('markAdaptationPlanApplied', () => {
    it('writes applied_at by plan id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.markAdaptationPlanApplied(sb as any, 'p1', 'now-iso');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ applied_at: 'now-iso' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'p1'] });
    });
  });

  describe('countPendingAdaptationPlans', () => {
    it('head-counts the same pending shape as fetchPendingAdaptationPlans', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countPendingAdaptationPlans(sb as any, 'u1');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id', { count: 'exact', head: true }] });
      expect(sb.calls).toContainEqual({ method: 'not', args: ['approved_at', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'is', args: ['applied_at', null] });
    });
  });

  describe('fetchMostRecentAppliedPlan', () => {
    it('requires applied_at non-null, newest-first, caller limit, count:exact (not head)', async () => {
      const sb = makeSupabaseStub({ data: [], count: 0 });
      await repo.fetchMostRecentAppliedPlan(sb as any, 'u1', 1);
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, applied_at', { count: 'exact' }] });
      expect(sb.calls).toContainEqual({ method: 'not', args: ['applied_at', 'is', null] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['applied_at', { ascending: false }] });
    });
  });

  describe('upsertJourneyOverride', () => {
    it('conflicts on user_id,wave_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', wave_id: 'w1', overrides: {}, source: 'd43_adaptation' };
      await repo.upsertJourneyOverride(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('user_journey_overrides');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'user_id,wave_id' }] });
    });
  });
});

import * as repo from '../../../src/services/journey/goal-plan-i18n-repository';

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

describe('goal-plan-i18n-repository', () => {
  describe('fetchCachedStepTranslations / upsertStepTranslations', () => {
    it('fetch filters by locale + the step-id set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchCachedStepTranslations(sb as any, 'de', ['s1', 's2']);
      expect(sb.from).toHaveBeenCalledWith('goal_plan_step_i18n');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['locale', 'de'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['step_id', ['s1', 's2']] });
    });

    it('upsert conflicts on step_id,locale (reused by localizeGoalPlan and seedGoalPlanSourceCache)', async () => {
      const sb = makeSupabaseStub({ data: null });
      const rows = [{ step_id: 's1', locale: 'de', title: 'x', description: null }];
      await repo.upsertStepTranslations(sb as any, rows);
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [rows, { onConflict: 'step_id,locale' }] });
    });
  });

  describe('fetchCachedPlanTranslation / upsertPlanTranslation', () => {
    it('fetch filters by locale + plan_id, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchCachedPlanTranslation(sb as any, 'de', 'plan1');
      expect(sb.from).toHaveBeenCalledWith('goal_plan_i18n');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['locale', 'de'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['plan_id', 'plan1'] });
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });

    it('upsert conflicts on plan_id,locale (reused by localizeGoalPlan and seedGoalPlanSourceCache)', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { plan_id: 'plan1', locale: 'de', goal_text: 'x', plan_summary: 'y' };
      await repo.upsertPlanTranslation(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'plan_id,locale' }] });
    });
  });
});

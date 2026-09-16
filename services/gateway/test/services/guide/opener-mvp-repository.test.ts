import * as repo from '../../../src/services/guide/opener-mvp-repository';

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

describe('opener-mvp-repository', () => {
  describe('fetchActiveGoalForOpener / insertDefaultLifeCompassGoal', () => {
    it('fetch scopes to user_id + is_active, newest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActiveGoalForOpener(sb as any, 'u1', 1);
      expect(sb.from).toHaveBeenCalledWith('life_compass');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, primary_goal, category'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_active', true] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
    });

    it('insert seeds the row and selects back id/primary_goal/category', async () => {
      const sb = makeSupabaseStub({ data: { id: 'g1' } });
      const row = { user_id: 'u1', primary_goal: 'x', category: 'longevity', is_active: true, version: 1 };
      await repo.insertDefaultLifeCompassGoal(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, primary_goal, category'] });
      expect(sb.chain.single).toHaveBeenCalled();
    });
  });

  describe('fetchOverdueCalendarEvent / fetchUpcomingCalendarEvent', () => {
    it('overdue filters start_time strictly before cutoff, newest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchOverdueCalendarEvent(sb as any, 'u1', 'now-iso', 1);
      expect(sb.from).toHaveBeenCalledWith('calendar_events');
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['start_time', 'now-iso'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['start_time', { ascending: false }] });
    });

    it('upcoming bounds start_time between now (gt) and the horizon (lt), soonest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUpcomingCalendarEvent(sb as any, 'u1', 'now-iso', 'in24h-iso', 1);
      expect(sb.calls).toContainEqual({ method: 'gt', args: ['start_time', 'now-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['start_time', 'in24h-iso'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['start_time', { ascending: true }] });
    });
  });

  describe('fetchTopNewRecommendation', () => {
    it('filters status=new within the given role_scope set, newest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchTopNewRecommendation(sb as any, 'u1', ['any', 'community'], 1);
      expect(sb.from).toHaveBeenCalledWith('autopilot_recommendations');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'new'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['role_scope', ['any', 'community']] });
    });
  });

  describe('fetchUserRegisteredAt', () => {
    it('reads created_at by the app_users "id" column (not user_id)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUserRegisteredAt(sb as any, 'u1', 1);
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'u1'] });
    });
  });

  describe('fetchNudgeSilencedUntil', () => {
    it('scopes by user_id + nudge_key', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchNudgeSilencedUntil(sb as any, 'u1', 'goal:g1:2026-01-01', 1);
      expect(sb.from).toHaveBeenCalledWith('user_nudge_state');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['nudge_key', 'goal:g1:2026-01-01'] });
    });
  });
});

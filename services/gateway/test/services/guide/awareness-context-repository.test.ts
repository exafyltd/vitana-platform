import * as repo from '../../../src/services/guide/awareness-context-repository';

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

describe('awareness-context-repository', () => {
  describe('fetchActiveLifeCompassGoal', () => {
    it('scopes to user_id + is_active, newest-first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActiveLifeCompassGoal(sb as any, 'u1', 1);
      expect(sb.from).toHaveBeenCalledWith('life_compass');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_active', true] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('countRecsByStatus / countRecsByStatusSince', () => {
    it('the plain status count has no date filter (used for "new")', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countRecsByStatus(sb as any, 'u1', 'new');
      expect(sb.from).toHaveBeenCalledWith('autopilot_recommendations');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'new'] });
      expect(sb.calls.some((c) => c.method === 'gte')).toBe(false);
    });

    it('the since-scoped count adds updated_at gte, reused for activated and rejected', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countRecsByStatusSince(sb as any, 'u1', 'rejected', 'since-iso');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'rejected'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['updated_at', 'since-iso'] });
    });
  });

  describe('countOverdueAutopilotEvents / countUpcomingAutopilotEvents', () => {
    it('overdue filters start_time strictly before the cutoff', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countOverdueAutopilotEvents(sb as any, 'u1', 'now-iso');
      expect(sb.from).toHaveBeenCalledWith('calendar_events');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['event_type', 'autopilot'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'scheduled'] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['start_time', 'now-iso'] });
      expect(sb.calls.some((c) => c.method === 'gt')).toBe(false);
    });

    it('upcoming bounds start_time between now (gt) and the 24h horizon (lt)', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countUpcomingAutopilotEvents(sb as any, 'u1', 'now-iso', 'in24h-iso');
      expect(sb.calls).toContainEqual({ method: 'gt', args: ['start_time', 'now-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['start_time', 'in24h-iso'] });
    });
  });
});

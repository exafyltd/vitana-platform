import * as repo from '../../../src/services/guide/conversation-focus-repository';

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

describe('conversation-focus-repository', () => {
  describe('fetchOverdueOrUpcomingAutopilotEvent', () => {
    it('overdue: filters user + autopilot + scheduled, lt(start_time,now), newest-first, limit 1', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchOverdueOrUpcomingAutopilotEvent(sb as any, 'u1', 'overdue');
      expect(sb.from).toHaveBeenCalledWith('calendar_events');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['event_type', 'autopilot'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'scheduled'] });
      expect(sb.calls.some((c) => c.method === 'lt' && c.args[0] === 'start_time')).toBe(true);
      expect(sb.calls).toContainEqual({ method: 'order', args: ['start_time', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
      // overdue must not use the upcoming branch's gt() bound
      expect(sb.calls.some((c) => c.method === 'gt')).toBe(false);
    });

    it('upcoming: bounds start_time between now (gt) and +24h (lt), oldest-first, limit 1', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchOverdueOrUpcomingAutopilotEvent(sb as any, 'u1', 'upcoming');
      expect(sb.calls.some((c) => c.method === 'gt' && c.args[0] === 'start_time')).toBe(true);
      expect(sb.calls.some((c) => c.method === 'lt' && c.args[0] === 'start_time')).toBe(true);
      expect(sb.calls).toContainEqual({ method: 'order', args: ['start_time', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('fetchTopNewAutopilotRecommendation', () => {
    it('scopes by user_id + new status, highest-priority-first, limit 1', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchTopNewAutopilotRecommendation(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('autopilot_recommendations');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id, title, summary, priority'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'new'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['priority', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });
});

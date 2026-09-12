import * as repo from '../../../src/services/guide/morning-brief-scheduler-repository';

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

describe('morning-brief-scheduler-repository', () => {
  describe('fetchRecentOrbSessionStartedEvents', () => {
    it('filters by topic + since cutoff, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentOrbSessionStartedEvents(sb as any, 'since-iso', 10000);
      expect(sb.from).toHaveBeenCalledWith('oasis_events');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['metadata'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['topic', 'orb.session.started'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', 'since-iso'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [10000] });
    });
  });

  describe('fetchUsersAlreadySentMorningBriefToday', () => {
    it('filters by surface + sent_at cutoff', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUsersAlreadySentMorningBriefToday(sb as any, '2026-08-29T00:00:00Z');
      expect(sb.from).toHaveBeenCalledWith('user_proactive_touches');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['user_id'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['surface', 'morning_brief'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['sent_at', '2026-08-29T00:00:00Z'] });
    });
  });

  describe('fetchUsersForMorningBrief', () => {
    it('filters by a user_id list', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUsersForMorningBrief(sb as any, ['u1', 'u2']);
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['user_id, tenant_id, display_name'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
    });
  });
});

import * as repo from '../../../src/services/guide/presence-pacer-repository';

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

describe('presence-pacer-repository', () => {
  describe('fetchTodaysTouches', () => {
    it('scopes to user_id + sent_at since the start-of-day cutoff', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchTodaysTouches(sb as any, 'u1', 'start-of-day-iso');
      expect(sb.from).toHaveBeenCalledWith('user_proactive_touches');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['sent_at', 'start-of-day-iso'] });
    });
  });

  describe('insertProactiveTouch', () => {
    it('inserts the row verbatim', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', surface: 'welcome_banner', reason_tag: null, metadata: {} };
      await repo.insertProactiveTouch(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
    });
  });

  describe('fetchUnresolvedTouch', () => {
    it('scopes by user+surface+sent_at cutoff, resolution-column is-null, newest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUnresolvedTouch(sb as any, 'u1', 'welcome_banner', 'start-of-day-iso', 'dismissed_at', 1);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['surface', 'welcome_banner'] });
      expect(sb.calls).toContainEqual({ method: 'is', args: ['dismissed_at', null] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['sent_at', { ascending: false }] });
    });

    it('accepts acknowledged_at as the resolution column too (same call shape)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUnresolvedTouch(sb as any, 'u1', 'priority_card', 'start-of-day-iso', 'acknowledged_at', 1);
      expect(sb.calls).toContainEqual({ method: 'is', args: ['acknowledged_at', null] });
    });
  });

  describe('updateTouchResolution', () => {
    it('forwards the dynamic-key patch by touch id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.updateTouchResolution(sb as any, 't1', { dismissed_at: 'now-iso' });
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ dismissed_at: 'now-iso' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 't1'] });
    });
  });

  describe('fetchPresencePreference', () => {
    it('scopes by user_id + preference_type=proactive_presence_level', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchPresencePreference(sb as any, 'u1', 1);
      expect(sb.from).toHaveBeenCalledWith('user_preferences');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['preference_type', 'proactive_presence_level'] });
    });
  });
});

import * as repo from '../../../src/services/guide/awareness-extensions-repository';

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

describe('awareness-extensions-repository', () => {
  describe('fetchGuidedJourneyState', () => {
    it('reads by user_id, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchGuidedJourneyState(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('user_guided_journey_state');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });
  });

  describe('fetchNextChecklistTopics', () => {
    it('requires published+enabled, orders session then position, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchNextChecklistTopics(sb as any, 3, 50);
      expect(sb.from).toHaveBeenCalledWith('journey_checklist_topics');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'published'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['enabled', true] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['session', 3] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['session', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['position', { ascending: true }] });
    });
  });

  describe('fetchRecentGreetingOpenings', () => {
    it('reads recent_greeting_openings by user_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchRecentGreetingOpenings(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('user_journey');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['recent_greeting_openings'] });
    });
  });

  describe('fetchProfileCompletionFields', () => {
    it('reads the six completion-relevant columns from app_users', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchProfileCompletionFields(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: ['first_name, last_name, date_of_birth, gender, city, country, avatar_url'],
      });
    });
  });

  describe('countActivatedRecommendations', () => {
    it('head-counts status=activated for the user', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countActivatedRecommendations(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('autopilot_recommendations');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['status', 'activated'] });
    });
  });

  describe('fetchActivePauseRows', () => {
    it('filters paused_until strictly after now', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActivePauseRows(sb as any, 'u1', 'now-iso');
      expect(sb.from).toHaveBeenCalledWith('user_proactive_pause');
      expect(sb.calls).toContainEqual({ method: 'gt', args: ['paused_until', 'now-iso'] });
    });
  });

  describe('countDiaryEntriesSince', () => {
    it('head-counts entries since the given cutoff', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countDiaryEntriesSince(sb as any, 'u1', '2026-01-01T00:00:00.000Z');
      expect(sb.from).toHaveBeenCalledWith('memory_diary_entries');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', '2026-01-01T00:00:00.000Z'] });
    });
  });
});

import * as repo from '../../../src/services/guide/session-summaries-repository';

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

describe('session-summaries-repository', () => {
  describe('fetchRecentSessionSummaries', () => {
    it('scopes by user_id, newest-first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentSessionSummaries(sb as any, 'u1', 3);
      expect(sb.from).toHaveBeenCalledWith('user_session_summaries');
      expect(sb.calls).toContainEqual({ method: 'order', args: ['ended_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [3] });
    });
  });

  describe('upsertSessionSummary', () => {
    it('conflicts on user_id,session_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', session_id: 's1', channel: 'voice', summary: 'x' };
      await repo.upsertSessionSummary(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'user_id,session_id' }] });
    });
  });

  describe('fetchSessionSummariesInWindow', () => {
    it('bounds ended_at between from (gte) and to (lt), oldest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchSessionSummariesInWindow(sb as any, 'u1', 'yesterday-start-iso', 'today-end-iso');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['ended_at', 'yesterday-start-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lt', args: ['ended_at', 'today-end-iso'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['ended_at', { ascending: true }] });
    });
  });
});

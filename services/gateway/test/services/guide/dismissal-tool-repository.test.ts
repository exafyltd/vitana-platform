import * as repo from '../../../src/services/guide/dismissal-tool-repository';

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

describe('dismissal-tool-repository', () => {
  describe('insertProactivePause', () => {
    it('inserts the row and selects the full row back', async () => {
      const sb = makeSupabaseStub({ data: { id: 'p1' } });
      const row = { user_id: 'u1', scope: 'all', paused_until: 'later-iso' };
      await repo.insertProactivePause(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('user_proactive_pause');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
      expect(sb.calls).toContainEqual({ method: 'select', args: [] });
      expect(sb.chain.single).toHaveBeenCalled();
    });
  });

  describe('clearActivePausesForUser', () => {
    it('scopes by user_id and paused_until strictly after now, selects back ids', async () => {
      const sb = makeSupabaseStub({ data: [{ id: 'p1' }] });
      await repo.clearActivePausesForUser(sb as any, 'u1', 'now-iso');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ paused_until: 'now-iso' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'gt', args: ['paused_until', 'now-iso'] });
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id'] });
    });
  });

  describe('upsertNudgeSilence', () => {
    it('conflicts on user_id,nudge_key', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', nudge_key: 'goal:g1', silenced_until: 'later-iso' };
      await repo.upsertNudgeSilence(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('user_nudge_state');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'user_id,nudge_key' }] });
    });
  });
});

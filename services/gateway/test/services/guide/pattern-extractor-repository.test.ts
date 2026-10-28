import * as repo from '../../../src/services/guide/pattern-extractor-repository';

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

describe('pattern-extractor-repository', () => {
  describe('fetchUserRoutines', () => {
    it('scopes by user_id + min confidence, orders confidence descending', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUserRoutines(sb as any, 'u1', 0.4, 8);
      expect(sb.from).toHaveBeenCalledWith('user_routines');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['confidence', 0.4] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['confidence', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [8] });
    });
  });

  describe('upsertUserRoutine', () => {
    it('conflicts on user_id,routine_kind,routine_key', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', routine_kind: 'time_of_day_preference', routine_key: 'tod:morning' };
      await repo.upsertUserRoutine(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'user_id,routine_kind,routine_key' }] });
    });
  });

  describe('fetchCalendarEventsSince', () => {
    it('does not select a time_slot column (verified missing from live schema)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchCalendarEventsSince(sb as any, 'u1', 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('calendar_events');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: ['id, start_time, completion_status, status, event_type, wellness_tags'],
      });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['start_time', 'since-iso'] });
    });
  });
});

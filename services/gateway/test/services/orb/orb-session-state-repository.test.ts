import * as repo from '../../../src/services/orb/orb-session-state-repository';

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

describe('orb-session-state-repository', () => {
  describe('fetchOrbSessionStateValue', () => {
    it('scopes by user_id + key, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchOrbSessionStateValue(sb as any, 'u1', 'continuity');
      expect(sb.from).toHaveBeenCalledWith('orb_session_state');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['value, expires_at'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['key', 'continuity'] });
    });
  });

  describe('upsertOrbSessionStateValue', () => {
    it('conflicts on user_id,key', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', key: 'continuity', value: { a: 1 }, expires_at: 'exp', updated_at: 'upd' };
      await repo.upsertOrbSessionStateValue(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('orb_session_state');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'user_id,key' }] });
    });
  });

  describe('deleteOrbSessionStateValue', () => {
    it('scopes the delete by user_id + key', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.deleteOrbSessionStateValue(sb as any, 'u1', 'pending_cta');
      expect(sb.from).toHaveBeenCalledWith('orb_session_state');
      expect(sb.calls).toContainEqual({ method: 'delete', args: [] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['key', 'pending_cta'] });
    });
  });
});

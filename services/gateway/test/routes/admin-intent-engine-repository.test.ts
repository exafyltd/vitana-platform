import * as repo from '../../src/routes/admin-intent-engine-repository';

/**
 * Functional stub Supabase client — a from()/rpc()-chain that records
 * every call and resolves to a configurable {data,error,count} response,
 * matching the pattern used for other B1 repository tests (e.g.
 * test/routes/admin-marketplace-repository.test.ts).
 */
function makeSupabaseStub(response: { data?: any; error?: any; count?: number | null } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'limit', 'update', 'insert']) {
    chain[m] = record(m);
  }
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });
  const rpc = jest.fn((...args: any[]) => {
    calls.push({ method: 'rpc', args });
    return Promise.resolve(resolved);
  });

  return { from, rpc, calls, chain };
}

describe('admin-intent-engine-repository', () => {
  describe('fetchAdminIntentById', () => {
    it('selects by intent_id and returns maybeSingle', async () => {
      const sb = makeSupabaseStub({ data: { intent_id: 'i1' } });
      const result = await repo.fetchAdminIntentById(sb as any, 'i1');
      expect(sb.from).toHaveBeenCalledWith('user_intents');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['intent_id', 'i1'] });
      expect(result.data).toEqual({ intent_id: 'i1' });
    });
  });

  describe('closeAdminIntent', () => {
    it('updates status to closed by intent_id', async () => {
      const sb = makeSupabaseStub();
      await repo.closeAdminIntent(sb as any, 'i1');
      expect(sb.from).toHaveBeenCalledWith('user_intents');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ status: 'closed' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['intent_id', 'i1'] });
    });
  });

  describe('insertAdminIntentCloseEvent', () => {
    it('inserts an admin.force_close event with the given actor/reason', async () => {
      const sb = makeSupabaseStub();
      await repo.insertAdminIntentCloseEvent(sb as any, {
        intentId: 'i1',
        actorUserId: 'u1',
        actorVitanaId: 'v1',
        reason: 'spam',
      });
      expect(sb.from).toHaveBeenCalledWith('intent_events');
      expect(sb.calls).toContainEqual({
        method: 'insert',
        args: [
          {
            intent_id: 'i1',
            actor_user_id: 'u1',
            actor_vitana_id: 'v1',
            event_type: 'admin.force_close',
            payload: { reason: 'spam' },
          },
        ],
      });
    });
  });

  describe('recomputeIntentMatchesDaily', () => {
    it('calls the compute_intent_matches_daily RPC with no args', async () => {
      const sb = makeSupabaseStub({ data: { ok: true } });
      await repo.recomputeIntentMatchesDaily(sb as any);
      expect(sb.rpc).toHaveBeenCalledWith('compute_intent_matches_daily');
    });
  });

  describe('fetchAdminIntentEngineStats', () => {
    it('queries the 4 stat counts and returns them by name', async () => {
      const sb = makeSupabaseStub({ count: 3 });
      const result = await repo.fetchAdminIntentEngineStats(sb as any);
      const tables = sb.calls.filter((c) => c.method === 'from').map((c) => c.args[0]);
      expect(tables).toEqual(['user_intents', 'user_intents', 'intent_matches', 'user_intents']);
      expect(result).toEqual({ totalIntents: 3, openIntents: 3, totalMatches: 3, stuckOpen: 3 });
    });
  });

  describe('fetchAdminIntentEngineKpi', () => {
    it('queries all 7 KPI sources in the documented order', async () => {
      const sb = makeSupabaseStub({ count: 1, data: [] });
      await repo.fetchAdminIntentEngineKpi(sb as any);
      const tables = sb.calls.filter((c) => c.method === 'from').map((c) => c.args[0]);
      expect(tables).toEqual([
        'user_intents',
        'user_intents',
        'user_intents',
        'intent_matches',
        'intent_disputes',
        'user_intents',
        'user_intents',
      ]);
    });
  });

  describe('archiveOldIntentMatches', () => {
    it('calls the archive RPC with the given params', async () => {
      const sb = makeSupabaseStub({ data: [{ archived: 10, remaining: 5 }] });
      await repo.archiveOldIntentMatches(sb as any, 90, 500);
      expect(sb.rpc).toHaveBeenCalledWith('archive_old_intent_matches', { p_older_than_days: 90, p_batch_size: 500 });
    });
  });
});

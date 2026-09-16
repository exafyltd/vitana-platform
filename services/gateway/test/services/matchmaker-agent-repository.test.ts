import * as repo from '../../src/services/matchmaker-agent-repository';

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

describe('matchmaker-agent-repository', () => {
  describe('upsertIntentMatchRecommendation', () => {
    it('conflicts on intent_id, reused across status/complete/error row shapes', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { intent_id: 'i1', status: 'pending' };
      await repo.upsertIntentMatchRecommendation(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('intent_match_recommendations');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'intent_id' }] });
    });
  });

  describe('fetchProfilesByVitanaIds / fetchRequesterProfile / fetchProfilesByUserIds / fetchProfilesWithDancePreferences', () => {
    it('fetchProfilesByVitanaIds filters by the vitana_id set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchProfilesByVitanaIds(sb as any, ['v1', 'v2']);
      expect(sb.from).toHaveBeenCalledWith('profiles');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['vitana_id', ['v1', 'v2']] });
    });

    it('fetchRequesterProfile reads by user_id, single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchRequesterProfile(sb as any, 'u1');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });

    it('fetchProfilesByUserIds filters by the user_id set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchProfilesByUserIds(sb as any, ['u1', 'u2']);
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
    });

    it('fetchProfilesWithDancePreferences excludes the caller and requires a non-empty dance_preferences object', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchProfilesWithDancePreferences(sb as any, 'u1', 20);
      expect(sb.calls).toContainEqual({ method: 'neq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'not', args: ['dance_preferences', 'eq', '{}'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [20] });
    });
  });

  describe('fetchIntentRequesterAndKind / fetchSourceIntent / fetchIntentsByIds / fetchRecentIntents / countOpenIntentsExcludingUser', () => {
    it('fetchIntentRequesterAndKind reads by intent_id, narrow columns', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchIntentRequesterAndKind(sb as any, 'i1');
      expect(sb.from).toHaveBeenCalledWith('user_intents');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['requester_vitana_id, intent_kind'] });
    });

    it('fetchSourceIntent reads the full context column list by intent_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchSourceIntent(sb as any, 'i1');
      expect(sb.calls).toContainEqual({
        method: 'select',
        args: ['intent_id, intent_kind, category, title, scope, kind_payload, requester_user_id, requester_vitana_id, tenant_id'],
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['intent_id', 'i1'] });
    });

    it('fetchIntentsByIds uses the same column list but filters by an id SET (not eq)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchIntentsByIds(sb as any, ['i1', 'i2']);
      expect(sb.calls).toContainEqual({ method: 'in', args: ['intent_id', ['i1', 'i2']] });
      expect(sb.calls.some((c) => c.method === 'eq' && c.args[0] === 'intent_id')).toBe(false);
    });

    it('fetchRecentIntents scopes by requester, newest-first, caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentIntents(sb as any, 'u1', 10);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['requester_user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
    });

    it('countOpenIntentsExcludingUser head-counts excluding the caller within a status set', async () => {
      const sb = makeSupabaseStub({ count: 3 });
      await repo.countOpenIntentsExcludingUser(sb as any, 'u1', ['open', 'matched', 'engaged']);
      expect(sb.calls).toContainEqual({ method: 'select', args: ['intent_id', { count: 'exact', head: true }] });
      expect(sb.calls).toContainEqual({ method: 'neq', args: ['requester_user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['status', ['open', 'matched', 'engaged']] });
    });
  });

  describe('fetchLifeCompassCategory', () => {
    it('reads category by user_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchLifeCompassCategory(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('life_compass_active_view');
    });
  });

  describe('fetchRecentMatchOutcomes / fetchSqlMatchesForIntent / upsertProfileFallbackMatches', () => {
    it('fetchRecentMatchOutcomes scopes by vitana_id_a, newest-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentMatchOutcomes(sb as any, 'v1', 20);
      expect(sb.from).toHaveBeenCalledWith('intent_matches');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['vitana_id_a', 'v1'] });
    });

    it('fetchSqlMatchesForIntent scopes by intent_a_id, orders by score descending', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchSqlMatchesForIntent(sb as any, 'i1', 20);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['intent_a_id', 'i1'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['score', { ascending: false }] });
    });

    it('upsertProfileFallbackMatches conflicts on the compound key with ignoreDuplicates', async () => {
      const sb = makeSupabaseStub({ data: null });
      const rows = [{ intent_a_id: 'i1', external_target_kind: 'profile_match', external_target_id: 'u1' }];
      await repo.upsertProfileFallbackMatches(sb as any, rows);
      expect(sb.calls).toContainEqual({
        method: 'upsert',
        args: [rows, { onConflict: 'intent_a_id,external_target_kind,external_target_id', ignoreDuplicates: true }],
      });
    });
  });
});

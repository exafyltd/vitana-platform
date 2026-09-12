import * as repo from '../../src/services/social-connect-repository';

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

describe('social-connect-repository', () => {
  describe('upsertSocialConnection', () => {
    it('upserts on tenant_id,user_id,provider and selects back id', async () => {
      const sb = makeSupabaseStub({ data: { id: 'c1' } });
      const row = { tenant_id: 't1', user_id: 'u1', provider: 'instagram' };
      await repo.upsertSocialConnection(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('social_connections');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id,user_id,provider' }] });
      expect(sb.calls).toContainEqual({ method: 'select', args: ['id'] });
      expect(sb.chain.single).toHaveBeenCalled();
    });
  });

  describe('deactivateSocialConnection', () => {
    it('nulls out tokens and marks inactive by user+provider', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.deactivateSocialConnection(sb as any, 'u1', 'facebook', '2026-01-01T00:00:00.000Z');
      expect(sb.from).toHaveBeenCalledWith('social_connections');
      expect(sb.calls).toContainEqual({
        method: 'update',
        args: [{ is_active: false, disconnected_at: '2026-01-01T00:00:00.000Z', access_token: null, refresh_token: null }],
      });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['provider', 'facebook'] });
    });
  });

  describe('fetchUserActiveConnections', () => {
    it('scopes to is_active + orders newest-connected-first', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUserActiveConnections(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('social_connections');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_active', true] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['connected_at', { ascending: false }] });
    });
  });

  describe('fetchConnectionById', () => {
    it('scopes to id + user_id (ownership check)', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchConnectionById(sb as any, 'c1', 'u1');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'c1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });
  });

  describe('updateConnectionEnrichmentStatus / updateConnectionEnrichmentComplete', () => {
    it('status update carries the status + updated_at by id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.updateConnectionEnrichmentStatus(sb as any, 'c1', 'enriching', 'now-iso');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ enrichment_status: 'enriching', updated_at: 'now-iso' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'c1'] });
    });

    it('complete update forwards the full patch verbatim', async () => {
      const sb = makeSupabaseStub({ data: null });
      const patch = { enrichment_status: 'completed', enrichment_data: { foo: 'bar' } };
      await repo.updateConnectionEnrichmentComplete(sb as any, 'c1', patch);
      expect(sb.calls).toContainEqual({ method: 'update', args: [patch] });
    });
  });

  describe('fetchActiveConnectionsForProviders', () => {
    it('scopes by user + is_active + the provider set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActiveConnectionsForProviders(sb as any, 'u1', ['instagram', 'facebook']);
      expect(sb.from).toHaveBeenCalledWith('social_connections');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['provider', ['instagram', 'facebook']] });
    });
  });

  describe('fetchAppUserProfileFields / updateAppUserProfile', () => {
    it('fetch reads display_name/avatar_url/bio by user_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchAppUserProfileFields(sb as any, 'u1');
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });

    it('update writes the patch by user_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      const patch = { avatar_url: 'x' };
      await repo.updateAppUserProfile(sb as any, 'u1', patch);
      expect(sb.calls).toContainEqual({ method: 'update', args: [patch] });
    });
  });

  describe('upsertMemoryFactSimple', () => {
    it('upserts on user_id,key (reused for both fact and media storage call sites)', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { user_id: 'u1', key: 'social_bio_instagram', value: 'x' };
      await repo.upsertMemoryFactSimple(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('memory_facts');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'user_id,key' }] });
    });
  });

  describe('upsertUserTopicProfile', () => {
    it('upserts on tenant_id,user_id,topic_key', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { tenant_id: 't1', user_id: 'u1', topic_key: 'fitness' };
      await repo.upsertUserTopicProfile(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('user_topic_profile');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id,user_id,topic_key' }] });
    });
  });

  describe('fetchSharePrefs / upsertSharePrefs', () => {
    it('fetch scopes by user + tenant', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchSharePrefs(sb as any, 'u1', 't1');
      expect(sb.from).toHaveBeenCalledWith('social_share_prefs');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
    });

    it('upsert conflicts on tenant_id,user_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { tenant_id: 't1', user_id: 'u1' };
      await repo.upsertSharePrefs(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id,user_id' }] });
    });
  });

  describe('insertShareLogEntry / updateShareLogStatus', () => {
    it('insert selects back the id', async () => {
      const sb = makeSupabaseStub({ data: { id: 'log1' } });
      const row = { tenant_id: 't1', user_id: 'u1', provider: 'facebook', share_status: 'pending' };
      await repo.insertShareLogEntry(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('social_share_log');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [row] });
      expect(sb.chain.single).toHaveBeenCalled();
    });

    it('status update forwards the patch by log id (shared by posted/failed cases)', async () => {
      const sb = makeSupabaseStub({ data: null });
      const patch = { share_status: 'posted', posted_at: 'now-iso' };
      await repo.updateShareLogStatus(sb as any, 'log1', patch);
      expect(sb.calls).toContainEqual({ method: 'update', args: [patch] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'log1'] });
    });
  });
});

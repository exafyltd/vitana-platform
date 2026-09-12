import * as repo from '../../src/services/automation-handlers/business-marketplace-repository';

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
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'like', 'or', 'overlaps',
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

describe('business-marketplace-repository', () => {
  describe('fetchServiceCatalogSummary / fetchServicesByType / fetchServiceByTopicOverlap', () => {
    it('summary reads by id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchServiceCatalogSummary(sb as any, 's1');
      expect(sb.from).toHaveBeenCalledWith('services_catalog');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 's1'] });
    });

    it('byType scopes to tenant + service_type with caller limit', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchServicesByType(sb as any, 't1', 'coach', 3);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['service_type', 'coach'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [3] });
    });

    it('byTopicOverlap uses overlaps() and returns a single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchServiceByTopicOverlap(sb as any, 't1', ['fitness'], 1);
      expect(sb.calls).toContainEqual({ method: 'overlaps', args: ['topic_keys', ['fitness']] });
      expect(sb.chain.maybeSingle).toHaveBeenCalled();
    });
  });

  describe('fetchTopicMatchedUsers', () => {
    it('filters by topic_key set + min score, orders score descending', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchTopicMatchedUsers(sb as any, 't1', ['fitness', 'yoga'], 60, 50);
      expect(sb.from).toHaveBeenCalledWith('user_topic_profile');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['topic_key', ['fitness', 'yoga']] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['score', 60] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['score', { ascending: false }] });
    });
  });

  describe('upsertServiceRelationshipEdge', () => {
    it('conflicts on tenant_id,user_id,target_type,target_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { tenant_id: 't1', user_id: 'u1', target_type: 'service', target_id: 's1' };
      await repo.upsertServiceRelationshipEdge(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('relationship_edges');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id,user_id,target_type,target_id' }] });
    });
  });

  describe('fetchProductCatalogSummary / fetchProductTopicKeys / fetchProductName', () => {
    it('each reads products_catalog by id with a different column list', async () => {
      const sb1 = makeSupabaseStub({ data: null });
      await repo.fetchProductCatalogSummary(sb1 as any, 'p1');
      expect(sb1.calls).toContainEqual({ method: 'select', args: ['name, product_type, topic_keys'] });

      const sb2 = makeSupabaseStub({ data: null });
      await repo.fetchProductTopicKeys(sb2 as any, 'p1');
      expect(sb2.calls).toContainEqual({ method: 'select', args: ['topic_keys'] });

      const sb3 = makeSupabaseStub({ data: null });
      await repo.fetchProductName(sb3 as any, 'p1');
      expect(sb3.calls).toContainEqual({ method: 'select', args: ['name'] });
    });
  });

  describe('fetchRecommendationsByPillarOverlap', () => {
    it('scopes to tenant and overlaps the pillar array', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecommendationsByPillarOverlap(sb as any, 't1', ['fitness'], 50);
      expect(sb.from).toHaveBeenCalledWith('recommendations');
      expect(sb.calls).toContainEqual({ method: 'overlaps', args: ['pillar', ['fitness']] });
    });
  });

  describe('upsertUserOfferMemory / fetchUsedOffersInWindow', () => {
    it('upsert conflicts on tenant_id,user_id,target_type,target_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { tenant_id: 't1', user_id: 'u1', target_type: 'service', target_id: 's1', state: 'viewed' };
      await repo.upsertUserOfferMemory(sb as any, row);
      expect(sb.from).toHaveBeenCalledWith('user_offers_memory');
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id,user_id,target_type,target_id' }] });
    });

    it('fetch scopes by tenant, state=used, target_type param, and window bounds', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchUsedOffersInWindow(sb as any, 't1', 'product', 'from-iso', 'to-iso', 50);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['state', 'used'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['target_type', 'product'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['updated_at', 'from-iso'] });
      expect(sb.calls).toContainEqual({ method: 'lte', args: ['updated_at', 'to-iso'] });
    });
  });

  describe('countExistingOutcome', () => {
    it('head-counts usage_outcomes scoped to tenant+user+target', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countExistingOutcome(sb as any, 't1', 'u1', 'target1');
      expect(sb.from).toHaveBeenCalledWith('usage_outcomes');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['target_id', 'target1'] });
    });
  });

  describe('fetchRecentHostedRooms / fetchRoomCategoriesInWindow / fetchRoomHostIds', () => {
    it('recentHostedRooms excludes null host_user_id', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRecentHostedRooms(sb as any, 't1', 'since-iso', 1000);
      expect(sb.from).toHaveBeenCalledWith('live_rooms');
      expect(sb.calls).toContainEqual({ method: 'not', args: ['host_user_id', 'is', null] });
    });

    it('categoriesInWindow has no host_user_id filter', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRoomCategoriesInWindow(sb as any, 't1', 'since-iso', 5000);
      expect(sb.calls.some((c) => c.method === 'not')).toBe(false);
    });

    it('roomHostIds excludes null host_user_id, no date filter', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRoomHostIds(sb as any, 't1', 5000);
      expect(sb.calls).toContainEqual({ method: 'not', args: ['host_user_id', 'is', null] });
      expect(sb.calls.some((c) => c.method === 'gte')).toBe(false);
    });
  });

  describe('fetchVitanaIdsForUsers', () => {
    it('scopes by the user_id set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchVitanaIdsForUsers(sb as any, ['u1', 'u2']);
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
    });
  });

  describe('countAttendanceForRooms', () => {
    it('scopes by room-id set and joined_at cutoff', async () => {
      const sb = makeSupabaseStub({ count: 0 });
      await repo.countAttendanceForRooms(sb as any, ['r1', 'r2'], 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('live_room_attendance');
      expect(sb.calls).toContainEqual({ method: 'in', args: ['live_room_id', ['r1', 'r2']] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['joined_at', 'since-iso'] });
    });
  });

  describe('fetchServicePaymentsForPayee', () => {
    it('scopes by payee_vitana_id and state set', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchServicePaymentsForPayee(sb as any, 'vitana1', ['captured', 'released'], 'since-iso');
      expect(sb.from).toHaveBeenCalledWith('service_payments');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['payee_vitana_id', 'vitana1'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['state', ['captured', 'released']] });
    });
  });
});

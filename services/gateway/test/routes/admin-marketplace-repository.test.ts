import * as repo from '../../src/routes/admin-marketplace-repository';

/**
 * Functional stub Supabase client — a from()-chain that records every
 * call and resolves to a configurable {data,error,count} response,
 * matching the pattern used elsewhere for B1 repository tests (e.g.
 * test/routes/admin-autopilot.test.ts's `chainable`).
 */
function makeSupabaseStub(response: { data?: any; error?: any; count?: number | null } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of ['select', 'eq', 'in', 'or', 'gte', 'lte', 'ilike', 'order', 'range', 'limit', 'update', 'insert', 'upsert']) {
    chain[m] = record(m);
  }
  chain.single = jest.fn(() => Promise.resolve(resolved));
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  // Thenable, so `await chain` (without .single()/.maybeSingle()) resolves too.
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });

  return { from, calls, chain };
}

describe('admin-marketplace-repository', () => {
  describe('fetchAdminMarketplaceOverviewStats', () => {
    it('queries all 6 tables in parallel with the expected filters', async () => {
      const sb = makeSupabaseStub({ data: [], count: 5 });
      await repo.fetchAdminMarketplaceOverviewStats(sb as any);
      const tables = sb.calls.filter((c) => c.method === 'from').map((c) => c.args[0]);
      expect(tables).toEqual([
        'merchants',
        'products',
        'products',
        'catalog_sources',
        'product_clicks',
        'product_orders',
      ]);
    });
  });

  describe('listAdminMarketplaceMerchants', () => {
    it('applies only the filters that were passed', async () => {
      const sb = makeSupabaseStub({ data: [{ id: 'm1' }], count: 1 });
      const result = await repo.listAdminMarketplaceMerchants(sb as any, { offset: 0, limit: 50 });
      expect(sb.from).toHaveBeenCalledWith('merchants');
      const methods = sb.calls.map((c) => c.method);
      expect(methods).not.toContain('eq');
      expect(methods).not.toContain('ilike');
      expect(result).toEqual({ data: [{ id: 'm1' }], error: null, count: 1 });
    });

    it('chains source_network/is_active/search filters when provided', async () => {
      const sb = makeSupabaseStub();
      await repo.listAdminMarketplaceMerchants(sb as any, {
        sourceNetwork: 'awin',
        isActive: 'true',
        search: 'acme',
        offset: 10,
        limit: 20,
      });
      const eqCalls = sb.calls.filter((c) => c.method === 'eq');
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['source_network', 'awin'] });
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['is_active', true] });
      expect(sb.calls).toContainEqual({ method: 'ilike', args: ['name', '%acme%'] });
      expect(sb.calls).toContainEqual({ method: 'range', args: [10, 29] });
    });
  });

  describe('updateAdminMarketplaceMerchant', () => {
    it('updates by id and returns a single row', async () => {
      const sb = makeSupabaseStub({ data: { id: 'm1', name: 'Acme' } });
      const result = await repo.updateAdminMarketplaceMerchant(sb as any, 'm1', { name: 'Acme' });
      expect(sb.from).toHaveBeenCalledWith('merchants');
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ name: 'Acme' }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'm1'] });
      expect(result.data).toEqual({ id: 'm1', name: 'Acme' });
    });
  });

  describe('listAdminMarketplaceProducts', () => {
    it('applies every optional filter when all are provided', async () => {
      const sb = makeSupabaseStub();
      await repo.listAdminMarketplaceProducts(sb as any, {
        requiresAdminReview: 'true',
        isActive: 'false',
        sourceNetwork: 'amazon',
        category: 'electronics',
        originRegion: 'EU',
        search: 'phone',
        offset: 0,
        limit: 50,
      });
      const eqCalls = sb.calls.filter((c) => c.method === 'eq');
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['requires_admin_review', true] });
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['is_active', false] });
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['source_network', 'amazon'] });
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['category', 'electronics'] });
      expect(eqCalls).toContainEqual({ method: 'eq', args: ['origin_region', 'EU'] });
      expect(sb.calls).toContainEqual({ method: 'ilike', args: ['title', '%phone%'] });
    });

    it('applies no filters when none are provided', async () => {
      const sb = makeSupabaseStub();
      await repo.listAdminMarketplaceProducts(sb as any, { offset: 0, limit: 50 });
      expect(sb.calls.some((c) => c.method === 'eq')).toBe(false);
      expect(sb.calls.some((c) => c.method === 'ilike')).toBe(false);
    });
  });

  describe('updateAdminMarketplaceProduct / bulkUpdateAdminMarketplaceProducts', () => {
    it('updateAdminMarketplaceProduct updates a single product by id', async () => {
      const sb = makeSupabaseStub({ data: { id: 'p1' } });
      await repo.updateAdminMarketplaceProduct(sb as any, 'p1', { is_active: false });
      expect(sb.from).toHaveBeenCalledWith('products');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'p1'] });
    });

    it('bulkUpdateAdminMarketplaceProducts updates via .in() over product ids', async () => {
      const sb = makeSupabaseStub({ data: [{ id: 'p1' }, { id: 'p2' }] });
      const result = await repo.bulkUpdateAdminMarketplaceProducts(sb as any, ['p1', 'p2'], { is_active: false });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['id', ['p1', 'p2']] });
      expect(result.data).toHaveLength(2);
    });
  });

  describe('fetchAdminMarketplaceIngestionCoverage', () => {
    it('selects origin_region/ships_to_regions for active products', async () => {
      const sb = makeSupabaseStub({ data: [{ origin_region: 'EU', ships_to_regions: ['UK'] }] });
      await repo.fetchAdminMarketplaceIngestionCoverage(sb as any);
      expect(sb.from).toHaveBeenCalledWith('products');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['origin_region, ships_to_regions'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_active', true] });
    });
  });

  describe('fetchAdminMarketplaceFeedCurationConfigs', () => {
    it('ORs tenant_id null with the given tenant id', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchAdminMarketplaceFeedCurationConfigs(sb as any, 'tenant-1');
      expect(sb.from).toHaveBeenCalledWith('default_feed_config');
      expect(sb.calls).toContainEqual({ method: 'or', args: ['tenant_id.is.null,tenant_id.eq.tenant-1'] });
    });
  });

  describe('updateAdminMarketplaceFeedCurationConfig', () => {
    it('updates by id', async () => {
      const sb = makeSupabaseStub({ data: { id: 'c1' } });
      await repo.updateAdminMarketplaceFeedCurationConfig(sb as any, 'c1', { notes: 'x' });
      expect(sb.from).toHaveBeenCalledWith('default_feed_config');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'c1'] });
    });
  });

  describe('listAdminMarketplaceIngestionRuns', () => {
    it('filters by source_network only when provided', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listAdminMarketplaceIngestionRuns(sb as any, { offset: 0, limit: 50 });
      expect(sb.calls.some((c) => c.method === 'eq')).toBe(false);

      const sb2 = makeSupabaseStub({ data: [] });
      await repo.listAdminMarketplaceIngestionRuns(sb2 as any, { sourceNetwork: 'cj', offset: 0, limit: 50 });
      expect(sb2.calls).toContainEqual({ method: 'eq', args: ['source_network', 'cj'] });
    });
  });

  describe('geo policy repository functions', () => {
    it('listAdminMarketplaceGeoPolicies orders by user_region then rule_type', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listAdminMarketplaceGeoPolicies(sb as any);
      expect(sb.from).toHaveBeenCalledWith('geo_policy');
      expect(sb.calls).toContainEqual({ method: 'order', args: ['user_region', { ascending: true }] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['rule_type', { ascending: true }] });
    });

    it('updateAdminMarketplaceGeoPolicy updates by id', async () => {
      const sb = makeSupabaseStub({ data: { id: 'g1' } });
      await repo.updateAdminMarketplaceGeoPolicy(sb as any, 'g1', { is_active: false });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 'g1'] });
    });

    it('insertAdminMarketplaceGeoPolicy inserts the payload', async () => {
      const sb = makeSupabaseStub({ data: { id: 'g2' } });
      const payload = { user_region: 'EU', rule_type: 'block' };
      await repo.insertAdminMarketplaceGeoPolicy(sb as any, payload);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [payload] });
    });
  });

  describe('fetchAdminMarketplaceAwinSourceConfig', () => {
    it('scopes to the active awin source', async () => {
      const sb = makeSupabaseStub({ data: [{ config: { api_key: 'x' } }] });
      await repo.fetchAdminMarketplaceAwinSourceConfig(sb as any);
      expect(sb.from).toHaveBeenCalledWith('marketplace_sources_config');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['source_network', 'awin'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_active', true] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('sources repository functions', () => {
    it('listAdminMarketplaceSources filters by network only when given', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listAdminMarketplaceSources(sb as any);
      expect(sb.calls.some((c) => c.method === 'eq')).toBe(false);

      const sb2 = makeSupabaseStub({ data: [] });
      await repo.listAdminMarketplaceSources(sb2 as any, 'shopify');
      expect(sb2.calls).toContainEqual({ method: 'eq', args: ['source_network', 'shopify'] });
    });

    it('insertAdminMarketplaceSource inserts the given payload', async () => {
      const sb = makeSupabaseStub({ data: { id: 's1' } });
      const payload = { source_network: 'shopify', display_name: 'x', config: {} };
      await repo.insertAdminMarketplaceSource(sb as any, payload);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [payload] });
    });

    it('updateAdminMarketplaceSource updates by id', async () => {
      const sb = makeSupabaseStub({ data: { id: 's1' } });
      await repo.updateAdminMarketplaceSource(sb as any, 's1', { is_active: false });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['id', 's1'] });
    });
  });

  describe('commission settings repository functions', () => {
    it('fetchAdminMarketplaceCommissionSetting reads the named key', async () => {
      const sb = makeSupabaseStub({ data: { value: { rate: 0.2 } } });
      await repo.fetchAdminMarketplaceCommissionSetting(sb as any);
      expect(sb.from).toHaveBeenCalledWith('admin_settings');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['key', 'recommendation_commission_default_rate'] });
    });

    it('upsertAdminMarketplaceCommissionSetting upserts on the key conflict target', async () => {
      const sb = makeSupabaseStub({ data: null, error: null });
      await repo.upsertAdminMarketplaceCommissionSetting(sb as any, { rate: 0.3 }, 'user-1');
      const upsertCall = sb.calls.find((c) => c.method === 'upsert');
      expect(upsertCall?.args[0]).toMatchObject({
        key: 'recommendation_commission_default_rate',
        value: { rate: 0.3 },
        updated_by: 'user-1',
      });
      expect(upsertCall?.args[1]).toEqual({ onConflict: 'key' });
    });
  });
});

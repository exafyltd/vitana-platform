import { createClient } from '@supabase/supabase-js';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

describe('Persona Registry', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.useFakeTimers();
    originalEnv = { ...process.env };
    process.env.SUPABASE_URL = 'http://localhost';
    process.env.SUPABASE_SERVICE_ROLE = 'key';
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('coalesces concurrent loadPersonaRegistryForTenant requests', async () => {
    process.env.FF_OPTIMIZE_PERSONA_REGISTRY = 'false';
    let loadPersonaRegistryForTenant: any;
    let clearTenantPersonaCache: any;
    let clearPersonaRegistryCache: any;
    
    jest.isolateModules(() => {
      const mod = require('../src/services/persona-registry');
      loadPersonaRegistryForTenant = mod.loadPersonaRegistryForTenant;
      clearTenantPersonaCache = mod.clearTenantPersonaCache;
      clearPersonaRegistryCache = mod.clearPersonaRegistryCache;
    });

    let platformResolvers: any[] = [];
    let tenantResolvers: any[] = [];

    const mockSupabase = {
      from: jest.fn((table: string) => {
        if (table === 'agent_personas_registry') {
          return {
            select: () => new Promise(resolve => platformResolvers.push(resolve))
          };
        }
        if (table === 'agent_personas_tenant_overrides') {
          return {
            select: () => ({
              eq: () => new Promise(resolve => tenantResolvers.push(resolve))
            })
          };
        }
      })
    };

    (createClient as jest.Mock).mockReturnValue(mockSupabase);

    clearPersonaRegistryCache();
    clearTenantPersonaCache();

    // Trigger two concurrent requests (thundering herd simulation)
    const p1 = loadPersonaRegistryForTenant('tenant-1');
    const p2 = loadPersonaRegistryForTenant('tenant-1');

    // Wait for the promises to be registered
    await Promise.resolve();

    // They should have only hit the DB once per table (one for platform registry, one for tenant overrides)
    expect(mockSupabase.from).toHaveBeenCalledTimes(2);

    // Resolve the single background query
    platformResolvers.forEach(r => r({ data: [], error: null }));
    tenantResolvers.forEach(r => r({ data: [], error: null }));

    const results = await Promise.all([p1, p2]);
    // Both returned maps should be the identical instance since they coalesce
    expect(results[0]).toBe(results[1]); 
  });

  it('instantly returns stale cache and fetches in background when FF is true', async () => {
    process.env.FF_OPTIMIZE_PERSONA_REGISTRY = 'true';
    let loadPersonaRegistryForTenant: any;
    let clearTenantPersonaCache: any;
    let clearPersonaRegistryCache: any;
    
    jest.isolateModules(() => {
      const mod = require('../src/services/persona-registry');
      loadPersonaRegistryForTenant = mod.loadPersonaRegistryForTenant;
      clearTenantPersonaCache = mod.clearTenantPersonaCache;
      clearPersonaRegistryCache = mod.clearPersonaRegistryCache;
    });

    let dbCallCount = 0;
    let platformResolvers: any[] = [];
    let tenantResolvers: any[] = [];

    const mockSupabase = {
      from: jest.fn((table: string) => {
        dbCallCount++;
        if (table === 'agent_personas_registry') {
          return {
            select: () => new Promise(resolve => platformResolvers.push(resolve))
          };
        }
        if (table === 'agent_personas_tenant_overrides') {
          return {
            select: () => ({
              eq: () => new Promise(resolve => tenantResolvers.push(resolve))
            })
          };
        }
      })
    };

    (createClient as jest.Mock).mockReturnValue(mockSupabase);

    clearPersonaRegistryCache();
    clearTenantPersonaCache();

    // 1. Initial request (blocks and fetches)
    const p1 = loadPersonaRegistryForTenant('tenant-2');
    await Promise.resolve();
    
    expect(dbCallCount).toBe(2);
    
    const mockPlatformData = [{ id: 'p1', key: 'test', greeting_templates: {} }];
    platformResolvers.forEach(r => r({ data: mockPlatformData, error: null }));
    tenantResolvers.forEach(r => r({ data: [], error: null }));
    platformResolvers = [];
    tenantResolvers = [];
    
    const initialMap = await p1;
    expect(initialMap.has('test')).toBe(true);

    // 2. Advance time past CACHE_TTL_MS (60s) to make cache stale
    jest.setSystemTime(Date.now() + 65_000);

    // 3. Second request should hit SWR flow and return instantly with stale map
    let secondResolved = false;
    let returnedMap: any = null;
    const p2 = loadPersonaRegistryForTenant('tenant-2').then((res: any) => {
      secondResolved = true;
      returnedMap = res;
    });
    
    await Promise.resolve(); 
    expect(secondResolved).toBe(true);
    expect(returnedMap).toBe(initialMap);
    
    // 4. Background update should have triggered new DB calls without blocking returning value
    expect(dbCallCount).toBe(4);
    
    // Resolve background fetches cleanly
    platformResolvers.forEach(r => r({ data: mockPlatformData, error: null }));
    tenantResolvers.forEach(r => r({ data: [], error: null }));
  });
});
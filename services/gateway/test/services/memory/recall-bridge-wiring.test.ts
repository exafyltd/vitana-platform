// VTID-04452 — fetchMemoryContextWithIdentity reads the ORB memory through recall().
// memory-legacy-read-retire: recall() is the only read for an identified caller. A not-ok
// recall returns ok:false and runs no legacy query (no fallback, no shadow).
const mockRecall = jest.fn();
jest.mock('../../../src/services/memory/recall', () => ({
  isOrbRecallEnabled: () => process.env.MEMORY_ORB_RECALL_ENABLED === 'true',
  recallOrbMemoryItems: (...a: any[]) => mockRecall(...a),
}));

import { fetchMemoryContextWithIdentity } from '../../../src/services/orb-memory-bridge';

const ID = { user_id: '11111111-1111-1111-1111-111111111111', tenant_id: '22222222-2222-2222-2222-222222222222' };
// VTID-04687: a current timestamp. selectContextWindow decays relevance with
// age, and the importance-40 episode sits exactly on the health domain's
// minimum — a fixed date turned this test red once the date aged.
const T = new Date().toISOString();

const RECALL_OK = {
  ok: true, latency_ms: 5, degraded: false, sections: { facts: 1, episodes: 1, diary: 0 },
  items: [
    { id: 'f1', category_key: 'personal', source: 'memory_facts', content: 'child_name: Mia', content_json: {}, importance: 95, occurred_at: T, created_at: T },
    { id: 'e1', category_key: 'health_wellness', source: 'session_summary', content: 'Knee hurt after the run', content_json: {}, importance: 40, occurred_at: T, created_at: T },
  ],
};
const RECALL_NOT_OK = {
  ok: false, items: [], latency_ms: 1, degraded: true, sections: { facts: 0, episodes: 0, diary: 0 }, error: 'memory_broker_disabled',
};

describe('fetchMemoryContextWithIdentity + recall()', () => {
  const env = { ...process.env };
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    mockRecall.mockReset();
    // Supabase looks configured, so any legacy query would run and be seen by the fetch spy.
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
    fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(async () => {
      throw new Error('no network in this test');
    });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...env };
  });

  it('the prompt is built from recall items', async () => {
    mockRecall.mockResolvedValue(RECALL_OK);
    const r = await fetchMemoryContextWithIdentity(ID);
    expect(mockRecall).toHaveBeenCalledWith(ID);
    expect(r.ok).toBe(true);
    expect(r.items.map(i => i.id)).toEqual(expect.arrayContaining(['f1', 'e1']));
    expect(r.formatted_context).toContain('Mia');
  });

  it('recall is used whatever MEMORY_ORB_RECALL_ENABLED says', async () => {
    process.env.MEMORY_ORB_RECALL_ENABLED = 'false';
    mockRecall.mockResolvedValue(RECALL_OK);
    const r = await fetchMemoryContextWithIdentity(ID);
    expect(mockRecall).toHaveBeenCalledWith(ID);
    expect(r.ok).toBe(true);
  });

  it('recall not ok: ok:false with no items, and no legacy query runs', async () => {
    process.env.MEMORY_ORB_RECALL_ENABLED = 'true';
    process.env.MEMORY_ORB_RECALL_SHADOW = 'true';
    mockRecall.mockResolvedValue(RECALL_NOT_OK);
    const r = await fetchMemoryContextWithIdentity(ID);
    await new Promise(res => setImmediate(res));
    expect(mockRecall).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.items).toEqual([]);
    expect(r.error).toBe('memory_broker_disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a successful read starts no background shadow read', async () => {
    process.env.MEMORY_ORB_RECALL_SHADOW = 'true';
    mockRecall.mockResolvedValue(RECALL_OK);
    await fetchMemoryContextWithIdentity(ID);
    await new Promise(res => setImmediate(res));
    expect(mockRecall).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no identity, bridge disabled (not a dev environment): recall is not used', async () => {
    await fetchMemoryContextWithIdentity(null);
    expect(mockRecall).not.toHaveBeenCalled();
  });

  it('no identity, dev sandbox: DEV_IDENTITY is read through recall()', async () => {
    process.env.ENVIRONMENT = 'dev-sandbox';
    mockRecall.mockResolvedValue(RECALL_OK);
    let devFetch!: typeof fetchMemoryContextWithIdentity;
    let devId!: { USER_ID: string; TENANT_ID: string };
    jest.isolateModules(() => {
      // fresh module: isMemoryBridgeEnabled() caches its answer per module instance
      const m = require('../../../src/services/orb-memory-bridge');
      devFetch = m.fetchMemoryContextWithIdentity;
      devId = m.DEV_IDENTITY;
    });
    const r = await devFetch(null);
    expect(mockRecall).toHaveBeenCalledTimes(1);
    expect(mockRecall.mock.calls[0][0]).toEqual(expect.objectContaining({ user_id: devId.USER_ID, tenant_id: devId.TENANT_ID }));
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

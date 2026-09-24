// VTID-04452 — fetchMemoryContextWithIdentity dispatches to recall() only
// behind MEMORY_ORB_RECALL_ENABLED, and falls back to the legacy read.
const mockRecall = jest.fn();
jest.mock('../../../src/services/memory/recall', () => ({
  isOrbRecallEnabled: () => process.env.MEMORY_ORB_RECALL_ENABLED === 'true',
  recallOrbMemoryItems: (...a: any[]) => mockRecall(...a),
}));

import { fetchMemoryContextWithIdentity } from '../../../src/services/orb-memory-bridge';

const ID = { user_id: '11111111-1111-1111-1111-111111111111', tenant_id: '22222222-2222-2222-2222-222222222222' };
const T = '2026-09-23T08:00:00Z';

describe('fetchMemoryContextWithIdentity + recall()', () => {
  const env = { ...process.env };
  beforeEach(() => {
    mockRecall.mockReset();
    // No Supabase: the legacy path returns a recognisable "not configured".
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
  afterEach(() => { process.env = { ...env }; });

  it('flag off: recall is never called', async () => {
    delete process.env.MEMORY_ORB_RECALL_ENABLED;
    const r = await fetchMemoryContextWithIdentity(ID);
    expect(mockRecall).not.toHaveBeenCalled();
    expect(r.error).toBe('Supabase not configured');
  });

  it('flag on: the prompt is built from recall items', async () => {
    process.env.MEMORY_ORB_RECALL_ENABLED = 'true';
    mockRecall.mockResolvedValue({
      ok: true, latency_ms: 5, degraded: false, sections: { facts: 1, episodes: 1, diary: 0 },
      items: [
        { id: 'f1', category_key: 'personal', source: 'memory_facts', content: 'child_name: Mia', content_json: {}, importance: 95, occurred_at: T, created_at: T },
        { id: 'e1', category_key: 'health_wellness', source: 'session_summary', content: 'Knee hurt after the run', content_json: {}, importance: 40, occurred_at: T, created_at: T },
      ],
    });
    const r = await fetchMemoryContextWithIdentity(ID);
    expect(mockRecall).toHaveBeenCalledWith(ID);
    expect(r.ok).toBe(true);
    expect(r.items.map(i => i.id)).toEqual(expect.arrayContaining(['f1', 'e1']));
    expect(r.formatted_context).toContain('Mia');
  });

  it('flag on but recall not ok: falls back to the legacy read', async () => {
    process.env.MEMORY_ORB_RECALL_ENABLED = 'true';
    mockRecall.mockResolvedValue({ ok: false, items: [], latency_ms: 1, degraded: true, sections: { facts: 0, episodes: 0, diary: 0 }, error: 'memory_broker_disabled' });
    const r = await fetchMemoryContextWithIdentity(ID);
    expect(mockRecall).toHaveBeenCalled();
    expect(r.error).toBe('Supabase not configured');
  });

  it('no identity (dev sandbox): recall is not used', async () => {
    process.env.MEMORY_ORB_RECALL_ENABLED = 'true';
    await fetchMemoryContextWithIdentity(null);
    expect(mockRecall).not.toHaveBeenCalled();
  });
});

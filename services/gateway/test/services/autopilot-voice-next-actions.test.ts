// VTID-02969 — unit tests for the voice next-action resolver
// (getTopAutopilotNextActions). This module projects the user's top
// autopilot recommendations into a small NextAction[] shape for voice
// tool responses.
//
// Scope:
//   1. Degrade-to-[] behavior — never throws, always returns [] on any
//      internal failure (bad result shape, query throw, missing creds).
//   2. Limit clamping ([1,3]) and fetchLimit derivation (max(limit*3,5)).
//   3. Query args passed to queryRecommendationsByRole (role default/
//      lowercasing, user_id, status filter, offset).
//   4. Projection: id/title/summary -> NextAction, id-less recs dropped,
//      empty-label recs dropped, label truncation at 80 chars.
//   5. Community-role re-rank path: dynamic import of the ranker + the
//      supabase client, re-ordering applied, and graceful fallback to
//      query ordering when the ranker throws or creds are missing.
//   6. Non-community roles never invoke the ranker.

const mockQueryRecommendationsByRole = jest.fn();
jest.mock('../../src/routes/autopilot-recommendations', () => ({
  queryRecommendationsByRole: (...args: any[]) => mockQueryRecommendationsByRole(...args),
}));

const mockBuildRankerContext = jest.fn();
const mockRankBatch = jest.fn();
jest.mock('../../src/services/recommendation-engine/ranking/index-pillar-weighter', () => ({
  buildRankerContext: (...args: any[]) => mockBuildRankerContext(...args),
  rankBatch: (...args: any[]) => mockRankBatch(...args),
}));

const mockCreateClient = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

import { getTopAutopilotNextActions } from '../../src/services/autopilot-voice-next-actions';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE: 'svc-role' };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function rec(overrides: Partial<{ id: string; title: string | null; summary: string | null }> = {}) {
  return { id: 'rec-1', title: 'Book a session', summary: 'summary text', ...overrides };
}

describe('getTopAutopilotNextActions — degrade-to-empty', () => {
  it('returns [] when the query result is not ok', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: false });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1' });
    expect(actions).toEqual([]);
  });

  it('returns [] when data is undefined', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1' });
    expect(actions).toEqual([]);
  });

  it('returns [] when data is an empty array', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [] });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1' });
    expect(actions).toEqual([]);
  });

  it('returns [] (never throws) when queryRecommendationsByRole rejects', async () => {
    mockQueryRecommendationsByRole.mockRejectedValue(new Error('network down'));
    const actions = await getTopAutopilotNextActions({ user_id: 'u1' });
    expect(actions).toEqual([]);
  });
});

describe('getTopAutopilotNextActions — query args', () => {
  it('defaults role to community (lowercased) and clamps limit to 1 when omitted', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [] });
    await getTopAutopilotNextActions({ user_id: 'u1' });
    expect(mockQueryRecommendationsByRole).toHaveBeenCalledWith('community', 'u1', ['new'], 5, 0);
  });

  it('lowercases an explicit role and passes it through', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [] });
    await getTopAutopilotNextActions({ user_id: 'u2', role: 'DEVELOPER' });
    expect(mockQueryRecommendationsByRole).toHaveBeenCalledWith('developer', 'u2', ['new'], 5, 0);
  });

  it('clamps limit above 3 down to 3, and derives fetchLimit = max(limit*3, 5)', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [] });
    await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin', limit: 10 });
    // limit clamps to 3 -> fetchLimit = max(3*3, 5) = 9
    expect(mockQueryRecommendationsByRole).toHaveBeenCalledWith('admin', 'u1', ['new'], 9, 0);
  });

  it('clamps limit below 1 up to 1', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [] });
    await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin', limit: 0 });
    expect(mockQueryRecommendationsByRole).toHaveBeenCalledWith('admin', 'u1', ['new'], 5, 0);
  });

  it('limit=2 derives fetchLimit = max(2*3, 5) = 6', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [] });
    await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin', limit: 2 });
    expect(mockQueryRecommendationsByRole).toHaveBeenCalledWith('admin', 'u1', ['new'], 6, 0);
  });
});

describe('getTopAutopilotNextActions — projection (non-community role, no ranker)', () => {
  it('projects id/title into NextAction shape with type=activate_recommendation, source=autopilot', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({
      ok: true,
      data: [rec({ id: 'rec-a', title: 'Join the wellness group' })],
    });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin' });
    expect(actions).toEqual([
      { id: 'rec-a', type: 'activate_recommendation', label: 'Join the wellness group', source: 'autopilot' },
    ]);
    expect(mockBuildRankerContext).not.toHaveBeenCalled();
    expect(mockRankBatch).not.toHaveBeenCalled();
  });

  it('falls back to summary when title is missing', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({
      ok: true,
      data: [rec({ id: 'rec-b', title: null, summary: 'Fallback summary' })],
    });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin' });
    expect(actions).toEqual([
      { id: 'rec-b', type: 'activate_recommendation', label: 'Fallback summary', source: 'autopilot' },
    ]);
  });

  it('drops recs with no id', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({
      ok: true,
      data: [rec({ id: '' }), rec({ id: 'rec-c' })],
    });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin', limit: 3 });
    expect(actions).toEqual([
      { id: 'rec-c', type: 'activate_recommendation', label: 'Book a session', source: 'autopilot' },
    ]);
  });

  it('drops recs whose title and summary are both empty', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({
      ok: true,
      data: [rec({ id: 'rec-d', title: '', summary: '' }), rec({ id: 'rec-e', title: '   ', summary: null })],
    });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin', limit: 3 });
    expect(actions).toEqual([]);
  });

  it('truncates labels over 80 chars with an ellipsis and trims trailing whitespace', async () => {
    const longTitle = 'x'.repeat(100);
    mockQueryRecommendationsByRole.mockResolvedValue({
      ok: true,
      data: [rec({ id: 'rec-f', title: longTitle })],
    });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin' });
    expect(actions[0].label.length).toBe(80);
    expect(actions[0].label.endsWith('…')).toBe(true);
    expect(actions[0].label).toBe('x'.repeat(79) + '…');
  });

  it('slices to the clamped limit after projection', async () => {
    mockQueryRecommendationsByRole.mockResolvedValue({
      ok: true,
      data: [rec({ id: 'r1' }), rec({ id: 'r2' }), rec({ id: 'r3' }), rec({ id: 'r4' })],
    });
    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'admin', limit: 2 });
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.id)).toEqual(['r1', 'r2']);
  });
});

describe('getTopAutopilotNextActions — community role re-rank', () => {
  it('re-ranks via buildRankerContext/rankBatch and reorders recs accordingly', async () => {
    const recA = rec({ id: 'rec-a', title: 'A' });
    const recB = rec({ id: 'rec-b', title: 'B' });
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [recA, recB] });
    mockCreateClient.mockReturnValue({ mock: 'supabase-client' });
    mockBuildRankerContext.mockResolvedValue({ ctx: true });
    // rankBatch reverses order: B first, then A.
    mockRankBatch.mockReturnValue([{ rec: recB }, { rec: recA }]);

    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'community', limit: 2 });

    expect(mockCreateClient).toHaveBeenCalledWith('https://supabase.test', 'svc-role');
    expect(mockBuildRankerContext).toHaveBeenCalledWith({ mock: 'supabase-client' }, 'u1');
    expect(mockRankBatch).toHaveBeenCalledWith([recA, recB], { ctx: true });
    expect(actions.map((a) => a.id)).toEqual(['rec-b', 'rec-a']);
  });

  it('falls back to original query ordering when the ranker throws', async () => {
    const recA = rec({ id: 'rec-a', title: 'A' });
    const recB = rec({ id: 'rec-b', title: 'B' });
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [recA, recB] });
    mockCreateClient.mockReturnValue({ mock: 'supabase-client' });
    mockBuildRankerContext.mockRejectedValue(new Error('ranker exploded'));

    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'community', limit: 2 });

    expect(actions.map((a) => a.id)).toEqual(['rec-a', 'rec-b']);
  });

  it('skips the ranker entirely when Supabase creds are missing, keeping query ordering', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    const recA = rec({ id: 'rec-a', title: 'A' });
    const recB = rec({ id: 'rec-b', title: 'B' });
    mockQueryRecommendationsByRole.mockResolvedValue({ ok: true, data: [recA, recB] });

    const actions = await getTopAutopilotNextActions({ user_id: 'u1', role: 'community', limit: 2 });

    expect(mockBuildRankerContext).not.toHaveBeenCalled();
    expect(actions.map((a) => a.id)).toEqual(['rec-a', 'rec-b']);
  });
});

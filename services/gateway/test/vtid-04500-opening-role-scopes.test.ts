/**
 * VTID-04500 (Community Autopilot CA-2): the ORB opener reads the Autopilot
 * suggestion for the member's active role. After role_scope was backfilled
 * (community rows → 'community', system findings → 'developer'), the opener
 * must ask for those scopes — a patient-mode member still sees their own
 * community suggestion, and a developer never gets a member's personal one.
 */
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../src/services/guide/pause-check', () => ({ isPaused: jest.fn(async () => ({ paused: false })) }));

const fetchTopNewRecommendation = jest.fn(async () => ({ data: [], error: null }));
jest.mock('../src/services/guide/opener-mvp-repository', () => {
  const known: Record<string, unknown> = {
    fetchActiveGoalForOpener: async () => ({
      data: [{ id: 'g1', primary_goal: 'Sleep better', category: 'sleep' }], error: null,
    }),
    fetchTopNewRecommendation: (...a: unknown[]) => (fetchTopNewRecommendation as any)(...a),
  };
  // Every other repository read returns nothing, so the opener falls through
  // to the recommendation step this test is about.
  return new Proxy(known, {
    get: (t, k: string) => (k in t ? t[k] : async () => ({ data: [], error: null })),
  });
});

import { pickOpenerCandidate } from '../src/services/guide/opener-mvp';

beforeEach(() => fetchTopNewRecommendation.mockClear());

const scopesFor = async (active_role: any) => {
  await pickOpenerCandidate({ user_id: 'u1', active_role, channel: 'voice' });
  return (fetchTopNewRecommendation.mock.calls[0] as unknown[])[2];
};

describe('opening reads the Autopilot suggestion for the active role', () => {
  test('community reads community-scoped rows', async () => {
    expect(await scopesFor('community')).toEqual(['any', 'community']);
  });

  test('patient mode still reads its community rows after the backfill', async () => {
    expect(await scopesFor('patient')).toEqual(['any', 'community']);
  });

  test('developer and admin read system findings, never personal suggestions', async () => {
    expect(await scopesFor('developer')).toEqual(['any', 'developer']);
    expect(await scopesFor('admin')).toEqual(['any', 'developer']);
  });
});

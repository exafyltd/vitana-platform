/**
 * NAV-ENTITY-RESOLVE — named-person profile resolution guard.
 *
 * Proves that navigate_to_screen, for a person-profile route, does NOT trust a
 * model-invented identifier. With the flag ON it resolves the NAME through the
 * canonical member directory; with the flag OFF it keeps the old behaviour.
 * The member ranker + supabase are mocked so this is deterministic and never
 * touches a DB.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockFindCommunityMember = jest.fn();
jest.mock('../src/services/voice-tools/community-member-ranker', () => ({
  findCommunityMember: (...a: any[]) => mockFindCommunityMember(...a),
  hashQuery: () => 'hash',
}));

import { tool_navigate_to_screen } from '../src/services/orb-tools-shared';

// Minimal supabase stub: only community_search_history insert is exercised.
const sbStub: any = {
  from: () => ({
    insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { search_id: 'sid-1' } }) }) }),
  }),
};

const authedId = {
  user_id: 'u-1',
  tenant_id: 't-1',
  vitana_id: 'viewer',
  role: 'community',
  lang: 'en',
  session_id: 's-1',
  is_anonymous: false,
  is_mobile: false,
} as any;

beforeEach(() => {
  mockFindCommunityMember.mockReset();
  delete process.env.NAV_ENTITY_RESOLVE;
});

describe('NAV-ENTITY-RESOLVE — profile-by-name', () => {
  test('flag ON: a model-invented identifier is resolved via the member directory', async () => {
    process.env.NAV_ENTITY_RESOLVE = 'true';
    mockFindCommunityMember.mockResolvedValue({
      tier: 1, lane: 'name', winnerUserId: 'maria-user',
      result: {
        ok: true,
        vitana_id: 'maria_m',
        display_name: 'Maria Maksina',
        voice_summary: 'Here is Maria Maksina.',
        match_recipe: {},
        redirect: { screen: 'profile_with_match', route: '/u/maria_m' },
      },
    });

    const r: any = await tool_navigate_to_screen(
      { screen_id: 'PROFILE.PUBLIC', identifier: 'maria-maksina' },
      authedId,
      sbStub,
    );

    expect(mockFindCommunityMember).toHaveBeenCalledTimes(1);
    // It searched the NAME, not the invented slug.
    expect(mockFindCommunityMember.mock.calls[0][1]).toMatchObject({ query: 'maria maksina' });
    expect(r.ok).toBe(true);
    // The dispatched route is the resolved member's real route — never /u/maria-maksina.
    expect(r.result.route).toContain('maria_m');
    expect(r.result.route).not.toContain('maria-maksina');
    expect(r.text).toBe('Here is Maria Maksina.');
  });

  test('flag OFF: behaviour unchanged — the identifier is used as given', async () => {
    const r: any = await tool_navigate_to_screen(
      { screen_id: 'PROFILE.PUBLIC', identifier: 'maria-maksina' },
      authedId,
      sbStub,
    );
    expect(mockFindCommunityMember).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.result.route).toContain('maria-maksina');
  });

  test('flag ON but a concrete @handle (no separators) passes straight through', async () => {
    process.env.NAV_ENTITY_RESOLVE = 'true';
    const r: any = await tool_navigate_to_screen(
      { screen_id: 'PROFILE.PUBLIC', identifier: 'mariamaksina' },
      authedId,
      sbStub,
    );
    expect(mockFindCommunityMember).not.toHaveBeenCalled();
    expect(r.result.route).toContain('mariamaksina');
  });
});

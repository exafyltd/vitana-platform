/**
 * Superlatives voice tools (VTID-02754) — unit tests.
 *
 * The handlers adapt the existing VTID-02754 service layer
 * (services/voice-tools/superlatives.ts + community-member-ranker.ts) into
 * speakable OrbToolResults, so both service modules are mocked here — the
 * service logic itself is covered by test/community-member-ranker.test.ts.
 *
 * Covered per tool: happy path (ok:true + speakable text with the person's
 * name and metric value), unauthenticated gate, empty-community soft state,
 * and the ask_who_is routing/fallback paths.
 */

jest.mock('../../src/services/voice-tools/superlatives', () => ({
  getHighestVitanaIndex: jest.fn(),
  getTopInPillar: jest.fn(),
  getMemberByRegistration: jest.fn(),
  getMostFollowed: jest.fn(),
  askWhoIs: jest.fn(),
}));
jest.mock('../../src/services/voice-tools/community-member-ranker', () => ({
  findCommunityMember: jest.fn(),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getHighestVitanaIndex,
  getTopInPillar,
  getMemberByRegistration,
  getMostFollowed,
  askWhoIs,
} from '../../src/services/voice-tools/superlatives';
import { findCommunityMember } from '../../src/services/voice-tools/community-member-ranker';
import {
  SUPERLATIVES_TOOL_HANDLERS,
  SUPERLATIVES_TOOL_DECLARATIONS,
  tool_get_highest_vitana_index,
  tool_get_top_in_pillar,
  tool_get_first_member,
  tool_get_newest_member,
  tool_get_most_followed,
  tool_ask_who_is,
} from '../../src/services/orb-tools/superlatives-tools';

const sb = {} as unknown as SupabaseClient;
const IDENT = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const ANON = { user_id: '', tenant_id: null, role: null };

const profile = (name: string, overrides: Record<string, unknown> = {}) => ({
  vitana_id: '@' + name.toLowerCase().replace(/\s+/g, ''),
  display_name: name,
  avatar_url: null,
  location: null,
  registration_seq: 1,
  member_since: '2025-03-10T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Exports / registry shape
// ---------------------------------------------------------------------------

describe('superlatives tools — exports', () => {
  const NAMES = [
    'get_highest_vitana_index',
    'get_top_in_pillar',
    'get_first_member',
    'get_newest_member',
    'get_most_followed',
    'ask_who_is',
  ];

  it.each(NAMES)('%s is in SUPERLATIVES_TOOL_HANDLERS', (name) => {
    expect(typeof SUPERLATIVES_TOOL_HANDLERS[name]).toBe('function');
  });

  it.each(NAMES)('%s is declared in SUPERLATIVES_TOOL_DECLARATIONS', (name) => {
    expect(SUPERLATIVES_TOOL_DECLARATIONS.find((d) => d.name === name)).toBeDefined();
  });

  it('declarations use only the Vertex-safe OpenAPI subset (no default/minimum/maximum/format)', () => {
    const raw = JSON.stringify(SUPERLATIVES_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
      expect(raw).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// get_highest_vitana_index
// ---------------------------------------------------------------------------

describe('get_highest_vitana_index', () => {
  it('speaks the top scorer name and score', async () => {
    (getHighestVitanaIndex as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'vitana_index_total',
      metric_value: 871,
      metric_unit: 'points',
      profile: profile('Mariia Maksina'),
      total_eligible: 12,
    });
    const res = await tool_get_highest_vitana_index({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Mariia Maksina');
      expect(res.text).toContain('871');
      expect(res.text).toContain('Vitana Index');
      expect((res.result as any).vitana_id).toBe('@mariiamaksina');
    }
  });

  it('requires an authenticated user', async () => {
    const res = await tool_get_highest_vitana_index({}, ANON as any, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
    expect(getHighestVitanaIndex).not.toHaveBeenCalled();
  });

  it('empty leaderboard stays ok:true with an honest line', async () => {
    (getHighestVitanaIndex as jest.Mock).mockResolvedValue({ ok: false, error: 'no_eligible_candidates' });
    const res = await tool_get_highest_vitana_index({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/no community member/i);
  });

  it('never throws — service exception becomes ok:false', async () => {
    (getHighestVitanaIndex as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await tool_get_highest_vitana_index({}, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// get_top_in_pillar
// ---------------------------------------------------------------------------

describe('get_top_in_pillar', () => {
  it('speaks the pillar leader with score', async () => {
    (getTopInPillar as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'pillar_sleep',
      metric_value: 93,
      metric_unit: 'points',
      profile: profile('Patrick Weber'),
      total_eligible: 8,
    });
    const res = await tool_get_top_in_pillar({ pillar: 'sleep' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Patrick Weber');
      expect(res.text).toContain('sleep');
      expect(res.text).toContain('93');
    }
    expect(getTopInPillar).toHaveBeenCalledWith(sb, 'sleep', 1);
  });

  it('maps a German spoken synonym ("Schlaf") to the canonical pillar', async () => {
    (getTopInPillar as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'pillar_sleep',
      metric_value: 90,
      profile: profile('Patrick Weber'),
      total_eligible: 8,
    });
    const res = await tool_get_top_in_pillar({ pillar: 'Schlaf' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(getTopInPillar).toHaveBeenCalledWith(sb, 'sleep', 1);
  });

  it('rejects an unknown pillar without calling the service', async () => {
    const res = await tool_get_top_in_pillar({ pillar: 'charisma' }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('nutrition');
    expect(getTopInPillar).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const res = await tool_get_top_in_pillar({ pillar: 'sleep' }, ANON as any, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_first_member / get_newest_member
// ---------------------------------------------------------------------------

describe('get_first_member', () => {
  it('speaks the OG member with member-since phrasing', async () => {
    (getMemberByRegistration as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'first_member_registered',
      metric_value: 1,
      profile: profile('Dragan Alexander', { member_since: '2025-03-10T00:00:00.000Z' }),
      total_eligible: 40,
    });
    const res = await tool_get_first_member({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Dragan Alexander');
      expect(res.text).toMatch(/first member/i);
      expect(res.text).toContain('March 2025');
    }
    expect(getMemberByRegistration).toHaveBeenCalledWith(sb, 'first', 1);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_get_first_member({}, ANON as any, sb);
    expect(res.ok).toBe(false);
  });
});

describe('get_newest_member', () => {
  it('speaks the newest member with a relative joined phrase', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    (getMemberByRegistration as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'newest_member_registered',
      metric_value: 40,
      profile: profile('Nina Novak', { member_since: threeDaysAgo }),
      total_eligible: 40,
    });
    const res = await tool_get_newest_member({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Nina Novak');
      expect(res.text).toMatch(/newest/i);
      expect(res.text).toContain('3 days ago');
    }
    expect(getMemberByRegistration).toHaveBeenCalledWith(sb, 'newest', 1);
  });

  it('empty community stays ok:true', async () => {
    (getMemberByRegistration as jest.Mock).mockResolvedValue({ ok: false, error: 'no_eligible_candidates' });
    const res = await tool_get_newest_member({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/no visible community members/i);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_get_newest_member({}, ANON as any, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_most_followed
// ---------------------------------------------------------------------------

describe('get_most_followed', () => {
  it('speaks the most followed member with follower count', async () => {
    (getMostFollowed as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'follower_count',
      metric_value: 27,
      metric_unit: 'followers',
      profile: profile('Mariia Maksina'),
      total_eligible: 15,
    });
    const res = await tool_get_most_followed({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Mariia Maksina');
      expect(res.text).toContain('27 followers');
    }
  });

  it('singular follower phrasing', async () => {
    (getMostFollowed as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'follower_count',
      metric_value: 1,
      profile: profile('Nina Novak'),
      total_eligible: 2,
    });
    const res = await tool_get_most_followed({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain('1 follower');
  });

  it('no followers data stays ok:true with an honest line', async () => {
    (getMostFollowed as jest.Mock).mockResolvedValue({ ok: false, error: 'no_followers_data: relation missing' });
    const res = await tool_get_most_followed({}, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toMatch(/followers/i);
  });

  it('requires an authenticated user', async () => {
    const res = await tool_get_most_followed({}, ANON as any, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ask_who_is
// ---------------------------------------------------------------------------

describe('ask_who_is', () => {
  it('routes to a superlative and speaks its answer', async () => {
    (askWhoIs as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'pillar_exercise',
      metric_value: 88,
      profile: profile('Patrick Weber'),
      total_eligible: 9,
    });
    const res = await tool_ask_who_is({ query: 'who is the fittest?' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Patrick Weber');
      expect(res.text).toContain('exercise');
      expect((res.result as any).routed_to).toBe('pillar_exercise');
    }
    expect(findCommunityMember).not.toHaveBeenCalled();
  });

  it('falls back to the find_community_member ranking on clarify', async () => {
    (askWhoIs as jest.Mock).mockResolvedValue({ ok: 'clarify', question: 'Which metric do you mean?' });
    (findCommunityMember as jest.Mock).mockResolvedValue({
      tier: 3,
      lane: 'motivation',
      winnerUserId: 'u-9',
      result: {
        ok: true,
        vitana_id: '@ninanovak',
        display_name: 'Nina Novak',
        voice_summary: 'Nina Novak is on the most inspiring trajectory we can see right now. Opening their profile.',
        match_recipe: { interpreted_intent: 'x', tier: 3, lane: 'motivation', ethics_reroute: false, signals_considered: [] },
        redirect: { screen: 'profile_with_match', route: '/u/@ninanovak' },
      },
    });
    const res = await tool_ask_who_is({ query: 'who is the most inspiring?' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('Nina Novak');
      expect((res.result as any).routed_to).toBe('find_community_member');
    }
    expect(findCommunityMember).toHaveBeenCalledWith(sb, expect.objectContaining({
      viewer_user_id: 'u-1',
      viewer_tenant_id: 't-1',
      query: 'who is the most inspiring?',
    }));
  });

  it('speaks the clarify question when the ranker fallback also fails', async () => {
    (askWhoIs as jest.Mock).mockResolvedValue({ ok: 'clarify', question: 'Which metric do you mean?' });
    (findCommunityMember as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await tool_ask_who_is({ query: 'who is the best?' }, IDENT, sb);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('Which metric do you mean?');
  });

  it('errors when both router and fallback fail with no clarify text', async () => {
    (askWhoIs as jest.Mock).mockResolvedValue({ ok: false, error: 'index_query_failed: x' });
    (findCommunityMember as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await tool_ask_who_is({ query: 'who is the healthiest?' }, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('db down');
  });

  it('accepts question as an alias arg for query', async () => {
    (askWhoIs as jest.Mock).mockResolvedValue({
      ok: true,
      metric: 'follower_count',
      metric_value: 5,
      profile: profile('Mariia Maksina'),
      total_eligible: 3,
    });
    const res = await tool_ask_who_is({ question: 'who is the most popular?' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(askWhoIs).toHaveBeenCalledWith(sb, { question: 'who is the most popular?' });
  });

  it('requires a non-empty query', async () => {
    const res = await tool_ask_who_is({}, IDENT, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('query');
  });

  it('requires an authenticated user with tenant', async () => {
    const res = await tool_ask_who_is({ query: 'who is the fittest?' }, { user_id: 'u-1', tenant_id: null, role: null } as any, sb);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authenticated');
  });
});

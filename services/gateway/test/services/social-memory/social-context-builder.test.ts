/**
 * Tests for social-context-builder.ts — buildSocialContextPack(), the
 * top-level assembly of the assistant's live Social Context Pack.
 *
 * Focus areas:
 *   - Fail-closed contract: if privacy exclusions can't be loaded, the
 *     whole pack ships empty rather than risking unfiltered content.
 *   - Section resilience: one section failing degrades gracefully
 *     (meta.degraded_sections) without failing the whole build.
 *   - Isolation: every downstream call is scoped to the (tenant, user)
 *     the pack was built for, and two consecutive builds for different
 *     users/tenants never cross-contaminate.
 *   - Derived fields: mutual_ids, shared_group_counts, location_terms,
 *     compact-mode limit scaling, and the recommended-actions assembly.
 */

import { makeSupabaseSequence, QueryResult } from './_supabase-mock';

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));
jest.mock('../../../src/services/social-memory/social-memory-repository', () => ({
  fetchExclusions: jest.fn(),
  fetchFollowEdges: jest.fn(),
  fetchMatches: jest.fn(),
  fetchRecentMessageContacts: jest.fn(),
  fetchGroupChats: jest.fn(),
  fetchCandidatePosts: jest.fn(),
  fetchUpcomingEvents: jest.fn(),
  fetchEventParticipants: jest.fn(),
  fetchGroupsForUsers: jest.fn(),
  fetchInterests: jest.fn(),
  fetchPersonById: jest.fn(),
  fetchPeople: jest.fn(),
}));
jest.mock('../../../src/services/social-memory/social-memory-ranker', () => ({
  rankInterestingPosts: jest.fn(),
  rankInterestingEvents: jest.fn(),
  extractTerms: jest.fn(),
  buildMatchScoreMap: jest.fn(),
}));
jest.mock('../../../src/services/social-memory/person-context-builder', () => ({
  buildPersonContext: jest.fn(),
}));
jest.mock('../../../src/services/social-memory/community-activity-builder', () => ({
  buildPersonActivity: jest.fn(),
  buildNetworkDigest: jest.fn(),
}));
jest.mock('../../../src/services/social-memory/social-memory-prompts', () => ({
  detectSocialIntent: jest.fn(),
  buildAssistantSystemHints: jest.fn(),
}));

import { getSupabase } from '../../../src/lib/supabase';
import * as repo from '../../../src/services/social-memory/social-memory-repository';
import * as ranker from '../../../src/services/social-memory/social-memory-ranker';
import * as personCtx from '../../../src/services/social-memory/person-context-builder';
import * as activityBuilder from '../../../src/services/social-memory/community-activity-builder';
import * as prompts from '../../../src/services/social-memory/social-memory-prompts';
import { buildSocialContextPack } from '../../../src/services/social-memory/social-context-builder';
import { SocialPerson, MatchSummary, MessageContact, RankedEvent } from '../../../src/services/social-memory/social-memory-types';

const mockGetSupabase = getSupabase as jest.Mock;
const rp = repo as jest.Mocked<typeof repo>;
const rk = ranker as jest.Mocked<typeof ranker>;
const pc = personCtx as jest.Mocked<typeof personCtx>;
const ab = activityBuilder as jest.Mocked<typeof activityBuilder>;
const pr = prompts as jest.Mocked<typeof prompts>;

function person(id: string): SocialPerson {
  return {
    user_id: id,
    display_name: `Name-${id}`,
    handle: null,
    vitana_id: null,
    avatar_url: null,
    bio: null,
    city: 'Berlin',
    country: 'Germany',
    visibility: 'public',
  };
}

function useSupabaseSequence(sequence: QueryResult[]) {
  const { client, log } = makeSupabaseSequence(sequence);
  mockGetSupabase.mockReturnValue(client);
  return log;
}

function resetDefaults() {
  rp.fetchExclusions.mockResolvedValue({ blocked: new Set(), muted: new Set(), hidden_posts: new Set() });
  rp.fetchFollowEdges.mockResolvedValue({ following: [], followers: [] });
  rp.fetchMatches.mockResolvedValue([]);
  rp.fetchRecentMessageContacts.mockResolvedValue([]);
  rp.fetchGroupChats.mockResolvedValue([]);
  rp.fetchCandidatePosts.mockResolvedValue([]);
  rp.fetchUpcomingEvents.mockResolvedValue([]);
  rp.fetchEventParticipants.mockResolvedValue(new Map());
  rp.fetchGroupsForUsers.mockResolvedValue(new Map());
  rp.fetchInterests.mockResolvedValue(new Map());
  rp.fetchPersonById.mockResolvedValue(null);
  rp.fetchPeople.mockResolvedValue(new Map());

  rk.rankInterestingPosts.mockReturnValue([]);
  rk.rankInterestingEvents.mockReturnValue([]);
  rk.extractTerms.mockReturnValue([]);
  rk.buildMatchScoreMap.mockReturnValue(new Map());

  pc.buildPersonContext.mockResolvedValue(null);
  ab.buildPersonActivity.mockResolvedValue(null as any);
  ab.buildNetworkDigest.mockResolvedValue(null as any);

  pr.detectSocialIntent.mockReturnValue({ is_social: true, kinds: [], person_hint: null });
  pr.buildAssistantSystemHints.mockReturnValue([]);

  useSupabaseSequence([{ data: [] }]); // life_compass (fetchGoalTerms)
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDefaults();
});

// ---------------------------------------------------------------------------
// Fail-closed contract
// ---------------------------------------------------------------------------

describe('fail-closed on exclusions failure', () => {
  it('ships an empty pack and never calls downstream reads when exclusions cannot be loaded', async () => {
    rp.fetchExclusions.mockRejectedValue(new Error('exclusions down'));
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });

    expect(pack.meta.degraded_sections).toEqual(['exclusions_fail_closed']);
    expect(pack.meta.sections_loaded).toEqual([]);
    expect(pack.meta.privacy_filters_applied).toEqual([]);
    expect(pack.user).toBeNull();
    expect(pack.relationships).toEqual({ following: [], followers: [], following_count: 0, followers_count: 0, mutual_ids: [] });
    expect(pack.matches).toEqual([]);
    expect(pack.interesting_posts).toEqual([]);
    expect(pack.assistant_system_hints[0]).toMatch(/Social context is unavailable/);

    expect(rp.fetchFollowEdges).not.toHaveBeenCalled();
    expect(rp.fetchMatches).not.toHaveBeenCalled();
    expect(rp.fetchCandidatePosts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Section resilience — one section failing degrades, doesn't crash the build
// ---------------------------------------------------------------------------

describe('section resilience', () => {
  it('records a degraded section and falls back to its empty default, while sections_loaded still lists it as attempted', async () => {
    rp.fetchMatches.mockRejectedValue(new Error('matches table down'));
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.matches).toEqual([]);
    expect(pack.meta.degraded_sections).toContain('matches');
    expect(pack.meta.sections_loaded).toContain('matches');
  });

  it('the full build still succeeds (does not throw) when every optional section fails', async () => {
    rp.fetchFollowEdges.mockRejectedValue(new Error('x'));
    rp.fetchMatches.mockRejectedValue(new Error('x'));
    rp.fetchRecentMessageContacts.mockRejectedValue(new Error('x'));
    rp.fetchGroupChats.mockRejectedValue(new Error('x'));
    rp.fetchCandidatePosts.mockRejectedValue(new Error('x'));
    rp.fetchUpcomingEvents.mockRejectedValue(new Error('x'));
    await expect(buildSocialContextPack({ tenant_id: 't', user_id: 'u' })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Standard sections + fixed metadata
// ---------------------------------------------------------------------------

describe('standard build', () => {
  it('always reports the fixed privacy_filters_applied list on a successful build', async () => {
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.meta.privacy_filters_applied).toEqual([
      'blocked_authors',
      'muted_authors',
      'hidden_posts',
      'public_posts_only',
      'private_profile_minimization',
      'own_conversations_only',
      'tenant_scope',
    ]);
  });

  it('lists the base sections as loaded', async () => {
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.meta.sections_loaded).toEqual(expect.arrayContaining([
      'relationships', 'matches', 'messages', 'group_chats', 'interesting_posts', 'interesting_events',
    ]));
  });

  it('uses assistant_system_hints from buildAssistantSystemHints(pack)', async () => {
    pr.buildAssistantSystemHints.mockReturnValue(['hint one']);
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.assistant_system_hints).toEqual(['hint one']);
  });
});

// ---------------------------------------------------------------------------
// Derived fields
// ---------------------------------------------------------------------------

describe('relationships.mutual_ids', () => {
  it('computes mutuals as the intersection of following and followers, not their union', async () => {
    rp.fetchFollowEdges.mockResolvedValue({
      following: [{ person: person('A'), since: 't' }, { person: person('B'), since: 't' }],
      followers: [{ person: person('A'), since: 't' }, { person: person('C'), since: 't' }],
    });
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.relationships.mutual_ids).toEqual(['A']);
    expect(pack.relationships.following_count).toBe(2);
    expect(pack.relationships.followers_count).toBe(2);
  });
});

describe('shared_group_counts signal', () => {
  it('excludes the viewer and zero-overlap users, counting only real overlaps', async () => {
    rp.fetchGroupsForUsers.mockResolvedValue(new Map([
      ['u', new Set(['g1', 'g2'])], // viewer's own groups
      ['friend-1', new Set(['g1'])], // 1 shared
      ['friend-2', new Set(['g3'])], // 0 shared
    ]));
    await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    const signals = rk.rankInterestingPosts.mock.calls[0][1];
    expect(signals.shared_group_counts.get('friend-1')).toBe(1);
    expect(signals.shared_group_counts.has('friend-2')).toBe(false);
    expect(signals.shared_group_counts.has('u')).toBe(false);
  });
});

describe('location_terms signal', () => {
  it('derives lowercased location terms from the viewer profile', async () => {
    rp.fetchPersonById.mockResolvedValue(person('u'));
    await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    const signals = rk.rankInterestingEvents.mock.calls[0][1];
    expect(signals.location_terms).toEqual(['berlin', 'germany']);
  });

  it('is empty when the viewer profile could not be resolved', async () => {
    rp.fetchPersonById.mockResolvedValue(null);
    await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    const signals = rk.rankInterestingEvents.mock.calls[0][1];
    expect(signals.location_terms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// person_context / activity_context triggering
// ---------------------------------------------------------------------------

describe('person_context triggering', () => {
  it('builds person_context when input.person_id is set', async () => {
    pc.buildPersonContext.mockResolvedValue({ person: person('p1') } as any);
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u', person_id: 'p1' });
    expect(pc.buildPersonContext).toHaveBeenCalledWith({ tenant_id: 't', user_id: 'u', person_id: 'p1', person_hint: undefined });
    expect(pack.person_context).not.toBeNull();
    expect(pack.meta.sections_loaded).toContain('person_context');
  });

  it('builds person_context when the detected intent carries a person_hint', async () => {
    pr.detectSocialIntent.mockReturnValue({ is_social: true, kinds: [], person_hint: 'Mariia' });
    pc.buildPersonContext.mockResolvedValue({ person: person('p1') } as any);
    await buildSocialContextPack({ tenant_id: 't', user_id: 'u', question: 'tell me about Mariia' });
    expect(pc.buildPersonContext).toHaveBeenCalledWith({ tenant_id: 't', user_id: 'u', person_id: undefined, person_hint: 'Mariia' });
  });

  it('does not build person_context when neither person_id nor a hint is present', async () => {
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pc.buildPersonContext).not.toHaveBeenCalled();
    expect(pack.person_context).toBeNull();
    expect(pack.meta.sections_loaded).not.toContain('person_context');
  });
});

describe('activity_context triggering', () => {
  it('builds per-person activity, scoped to the RESOLVED person id, when intent asks for person_activity', async () => {
    pr.detectSocialIntent.mockReturnValue({ is_social: true, kinds: ['person_activity'], person_hint: 'Mariia' });
    pc.buildPersonContext.mockResolvedValue({ person: person('resolved-id') } as any);
    ab.buildPersonActivity.mockResolvedValue({ person: person('resolved-id'), items: [], window_days: 14 });
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u', question: 'what has Mariia been up to' });
    expect(ab.buildPersonActivity).toHaveBeenCalledWith('resolved-id');
    expect(ab.buildNetworkDigest).not.toHaveBeenCalled();
    expect(pack.activity_context).not.toBeNull();
  });

  it('does not build per-person activity when person_context failed to resolve, even if the intent asked for it', async () => {
    pr.detectSocialIntent.mockReturnValue({ is_social: true, kinds: ['person_activity'], person_hint: 'Ghost' });
    pc.buildPersonContext.mockResolvedValue(null);
    await buildSocialContextPack({ tenant_id: 't', user_id: 'u', question: 'what has Ghost been up to' });
    expect(ab.buildPersonActivity).not.toHaveBeenCalled();
  });

  it('builds the network digest for community_changes intent, scoped to importantIds and blocked exclusions', async () => {
    rp.fetchFollowEdges.mockResolvedValue({ following: [{ person: person('friend-1'), since: 't' }], followers: [] });
    rp.fetchExclusions.mockResolvedValue({ blocked: new Set(['blocked-1']), muted: new Set(), hidden_posts: new Set() });
    pr.detectSocialIntent.mockReturnValue({ is_social: true, kinds: ['community_changes'], person_hint: null });
    ab.buildNetworkDigest.mockResolvedValue({ person: null, items: [], window_days: 2 });
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u', question: 'what changed since yesterday' });
    expect(ab.buildNetworkDigest).toHaveBeenCalledWith(['friend-1'], new Set(['blocked-1']));
    expect(pack.activity_context).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recommended_actions assembly
// ---------------------------------------------------------------------------

describe('recommended_actions', () => {
  it('surfaces the person_context next-action first', async () => {
    pc.buildPersonContext.mockResolvedValue({
      person: person('p1'),
      recommended_next_action: 'Say hello!',
    } as any);
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u', person_id: 'p1' });
    expect(pack.recommended_actions[0]).toEqual({
      action: 'Say hello!',
      reason: 'About Name-p1',
      route: '/profile/p1',
    });
  });

  it('recommends an untouched, non-rejected current match', async () => {
    const match: MatchSummary = {
      person: person('m1'),
      score: 70,
      reasons: ['Shared interests'],
      source: 'daily_match',
      matched_at: 't',
      action: null,
      conversation_started: false,
      is_current: true,
    };
    rp.fetchMatches.mockResolvedValue([match]);
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.recommended_actions.some((a) => a.route === '/matches')).toBe(true);
  });

  it('does not recommend a rejected match', async () => {
    const match: MatchSummary = {
      person: person('m1'),
      score: 70,
      reasons: [],
      source: 'daily_match',
      matched_at: 't',
      action: 'rejected',
      conversation_started: false,
      is_current: true,
    };
    rp.fetchMatches.mockResolvedValue([match]);
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.recommended_actions.some((a) => a.route === '/matches')).toBe(false);
  });

  it('recommends a top-ranked event only when its score clears the 30-point bar', async () => {
    const lowEvent: RankedEvent = {
      event_id: 'e1', title: 'Low', event_type: null, start_time: 't', location: null, url: '/e/low',
      participant_count: null, followed_attendees: [], matched_attendees: [], score: 10, reason: ['x'],
    };
    rk.rankInterestingEvents.mockReturnValue([lowEvent]);
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.recommended_actions.some((a) => a.route === '/e/low')).toBe(false);
  });

  it('recommends reconnecting with a stale (7+ day) message contact', async () => {
    const stale: MessageContact = {
      person: person('c1'),
      last_message_at: new Date(Date.now() - 10 * 86400000).toISOString(),
      last_direction: 'sent',
      last_snippet: null,
      messages_30d: 1,
    };
    rp.fetchRecentMessageContacts.mockResolvedValue([stale]);
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.recommended_actions.some((a) => a.route === '/messages/c1')).toBe(true);
  });

  it('falls back to "follow a few members" only when there are zero actions and zero follows', async () => {
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.recommended_actions).toHaveLength(1);
    expect(pack.recommended_actions[0].route).toBe('/community');
  });

  it('does not add the fallback when the viewer already follows people', async () => {
    rp.fetchFollowEdges.mockResolvedValue({ following: [{ person: person('f1'), since: 't' }], followers: [] });
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(pack.recommended_actions.every((a) => a.route !== '/community')).toBe(true);
  });

  it('caps recommended_actions at 3', async () => {
    pc.buildPersonContext.mockResolvedValue({ person: person('p1'), recommended_next_action: 'Action 1' } as any);
    const match: MatchSummary = {
      person: person('m1'), score: 70, reasons: ['r'], source: 'daily_match', matched_at: 't',
      action: null, conversation_started: false, is_current: true,
    };
    rp.fetchMatches.mockResolvedValue([match]);
    rk.rankInterestingEvents.mockReturnValue([{
      event_id: 'e1', title: 'Big Event', event_type: null, start_time: 't', location: null, url: '/e/big',
      participant_count: null, followed_attendees: [], matched_attendees: [], score: 50, reason: ['x'],
    }]);
    const stale: MessageContact = {
      person: person('c1'), last_message_at: new Date(Date.now() - 10 * 86400000).toISOString(),
      last_direction: 'sent', last_snippet: null, messages_30d: 1,
    };
    rp.fetchRecentMessageContacts.mockResolvedValue([stale]);
    const pack = await buildSocialContextPack({ tenant_id: 't', user_id: 'u', person_id: 'p1' });
    expect(pack.recommended_actions.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// compact mode — limit scaling
// ---------------------------------------------------------------------------

describe('compact mode', () => {
  it('caps repository limits and ranker topK down in compact mode', async () => {
    await buildSocialContextPack({ tenant_id: 't', user_id: 'u', compact: true });
    expect(rp.fetchFollowEdges).toHaveBeenCalledWith('u', expect.any(Set), 20);
    expect(rp.fetchMatches).toHaveBeenCalledWith('u', expect.any(Set), 10);
    expect(rp.fetchRecentMessageContacts).toHaveBeenCalledWith('u', 't', expect.any(Set), 8);
    expect(rp.fetchCandidatePosts).toHaveBeenCalledWith('u', [], expect.anything(), 25);
    expect(rp.fetchUpcomingEvents).toHaveBeenCalledWith(25);
    expect(rk.rankInterestingPosts).toHaveBeenCalledWith(expect.anything(), expect.anything(), 5);
    expect(rk.rankInterestingEvents).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4);
  });

  it('uses the wider default limits outside compact mode', async () => {
    await buildSocialContextPack({ tenant_id: 't', user_id: 'u' });
    expect(rp.fetchFollowEdges).toHaveBeenCalledWith('u', expect.any(Set), 50);
    expect(rp.fetchMatches).toHaveBeenCalledWith('u', expect.any(Set), 20);
    expect(rp.fetchRecentMessageContacts).toHaveBeenCalledWith('u', 't', expect.any(Set), 15);
    expect(rp.fetchCandidatePosts).toHaveBeenCalledWith('u', [], expect.anything(), 40);
    expect(rp.fetchUpcomingEvents).toHaveBeenCalledWith(40);
    expect(rk.rankInterestingPosts).toHaveBeenCalledWith(expect.anything(), expect.anything(), 8);
    expect(rk.rankInterestingEvents).toHaveBeenCalledWith(expect.anything(), expect.anything(), 6);
  });
});

// ---------------------------------------------------------------------------
// Isolation across consecutive builds for different tenants/users
// ---------------------------------------------------------------------------

describe('isolation across builds', () => {
  it('scopes every downstream call to the (tenant, user) the pack was built for', async () => {
    await buildSocialContextPack({ tenant_id: 'tenant-A', user_id: 'viewer-A' });
    expect(rp.fetchExclusions).toHaveBeenCalledWith('viewer-A');
    expect(rp.fetchRecentMessageContacts).toHaveBeenCalledWith('viewer-A', 'tenant-A', expect.any(Set), expect.any(Number));
    expect(rp.fetchGroupChats).toHaveBeenCalledWith('viewer-A', 'tenant-A');
  });

  it('does not leak the previous build\'s user/tenant into the next build', async () => {
    await buildSocialContextPack({ tenant_id: 'tenant-A', user_id: 'viewer-A' });
    jest.clearAllMocks();
    resetDefaults();
    await buildSocialContextPack({ tenant_id: 'tenant-B', user_id: 'viewer-B' });

    expect(rp.fetchExclusions).toHaveBeenCalledWith('viewer-B');
    expect(rp.fetchExclusions).not.toHaveBeenCalledWith('viewer-A');
    expect(rp.fetchGroupChats).toHaveBeenCalledWith('viewer-B', 'tenant-B');
    expect(rp.fetchGroupChats).not.toHaveBeenCalledWith('viewer-A', 'tenant-A');
  });
});

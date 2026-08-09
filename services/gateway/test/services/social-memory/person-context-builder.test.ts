/**
 * Tests for person-context-builder.ts — "tell me about X" Person
 * Intelligence assembly.
 *
 * Privacy focus (per file header): blocked people return null (as if not
 * found); private profiles with no viewer relationship are data-minimized
 * to name-only with privacy_limited=true; the exclusions read fails
 * closed (blocked reads can't be verified -> treat as not-found).
 * Isolation focus: building context for viewer A must scope every
 * downstream repository call to A + the resolved target, never to some
 * other user, and two back-to-back builds for different viewers must not
 * bleed into one another.
 */

jest.mock('../../../src/services/social-memory/social-memory-repository', () => ({
  fetchPersonById: jest.fn(),
  resolvePersonByName: jest.fn(),
  fetchFollowFlags: jest.fn(),
  fetchMatches: jest.fn(),
  fetchExclusions: jest.fn(),
  fetchInterests: jest.fn(),
  fetchGroupsForUsers: jest.fn(),
  fetchEventsForUsers: jest.fn(),
  fetchGroupNames: jest.fn(),
  fetchEventTitles: jest.fn(),
  fetchPersonPosts: jest.fn(),
  fetchLastChatAt: jest.fn(),
}));

import * as repo from '../../../src/services/social-memory/social-memory-repository';
import {
  buildPersonContext,
  buildRelevanceSummary,
} from '../../../src/services/social-memory/person-context-builder';
import { PersonContext, SocialPerson, MatchSummary } from '../../../src/services/social-memory/social-memory-types';

const m = repo as jest.Mocked<typeof repo>;

function person(id: string, overrides: Partial<SocialPerson> = {}): SocialPerson {
  return {
    user_id: id,
    display_name: `Name-${id}`,
    handle: null,
    vitana_id: null,
    avatar_url: null,
    bio: 'bio',
    city: 'City',
    country: 'Country',
    visibility: 'public',
    ...overrides,
  };
}

function emptyDefaults() {
  m.fetchFollowFlags.mockResolvedValue({ you_follow: false, follows_you: false });
  m.fetchMatches.mockResolvedValue([]);
  m.fetchInterests.mockResolvedValue(new Map());
  m.fetchGroupsForUsers.mockResolvedValue(new Map());
  m.fetchEventsForUsers.mockResolvedValue(new Map());
  m.fetchGroupNames.mockResolvedValue(new Map());
  m.fetchEventTitles.mockResolvedValue(new Map());
  m.fetchPersonPosts.mockResolvedValue([]);
  m.fetchLastChatAt.mockResolvedValue(null);
  m.fetchExclusions.mockResolvedValue({ blocked: new Set(), muted: new Set(), hidden_posts: new Set() });
}

beforeEach(() => {
  jest.clearAllMocks();
  emptyDefaults();
});

describe('target resolution', () => {
  it('resolves by person_id when given', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(m.fetchPersonById).toHaveBeenCalledWith('p1');
    expect(m.resolvePersonByName).not.toHaveBeenCalled();
  });

  it('resolves by fuzzy hint when person_id is absent', async () => {
    m.resolvePersonByName.mockResolvedValue(person('p1'));
    await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_hint: 'Mariia' });
    expect(m.resolvePersonByName).toHaveBeenCalledWith('Mariia');
    expect(m.fetchPersonById).not.toHaveBeenCalled();
  });

  it('returns null when neither person_id nor person_hint resolves anyone', async () => {
    m.fetchPersonById.mockResolvedValue(null);
    const out = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'ghost' });
    expect(out).toBeNull();
  });

  it('returns null when the resolved person is the viewer themselves', async () => {
    m.fetchPersonById.mockResolvedValue(person('viewer'));
    const out = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'viewer' });
    expect(out).toBeNull();
    // Must short-circuit before any relationship reads.
    expect(m.fetchExclusions).not.toHaveBeenCalled();
  });
});

describe('blocked-person privacy contract', () => {
  it('returns null (as if not found) when the resolved person is blocked', async () => {
    m.fetchPersonById.mockResolvedValue(person('blocked-1'));
    m.fetchExclusions.mockResolvedValue({ blocked: new Set(['blocked-1']), muted: new Set(), hidden_posts: new Set() });
    const out = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'blocked-1' });
    expect(out).toBeNull();
  });

  it('fails closed to null when the exclusions read throws (cannot verify not-blocked)', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchExclusions.mockRejectedValue(new Error('exclusions_read_failed'));
    const out = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(out).toBeNull();
    // Fails closed before running any further relationship reads.
    expect(m.fetchFollowFlags).not.toHaveBeenCalled();
  });
});

describe('isolation — scoping of downstream reads', () => {
  it('scopes every downstream repository call to (viewer, target) — never a third party', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    await buildPersonContext({ tenant_id: 'tenant-A', user_id: 'viewer-A', person_id: 'p1' });

    expect(m.fetchExclusions).toHaveBeenCalledWith('viewer-A');
    expect(m.fetchFollowFlags).toHaveBeenCalledWith('viewer-A', 'p1');
    expect(m.fetchMatches).toHaveBeenCalledWith('viewer-A', expect.any(Set), 30);
    expect(m.fetchInterests).toHaveBeenCalledWith(['viewer-A', 'p1']);
    expect(m.fetchGroupsForUsers).toHaveBeenCalledWith(['viewer-A', 'p1']);
    expect(m.fetchEventsForUsers).toHaveBeenCalledWith(['viewer-A', 'p1']);
    expect(m.fetchPersonPosts).toHaveBeenCalledWith('p1', 5);
    expect(m.fetchLastChatAt).toHaveBeenCalledWith('viewer-A', 'tenant-A', 'p1');
  });

  it('does not leak state between two consecutive builds for different viewers', async () => {
    m.fetchPersonById.mockResolvedValueOnce(person('target-1'));
    await buildPersonContext({ tenant_id: 'tenant-A', user_id: 'viewer-A', person_id: 'target-1' });

    jest.clearAllMocks();
    emptyDefaults();
    m.fetchPersonById.mockResolvedValueOnce(person('target-2'));
    await buildPersonContext({ tenant_id: 'tenant-B', user_id: 'viewer-B', person_id: 'target-2' });

    expect(m.fetchExclusions).toHaveBeenCalledWith('viewer-B');
    expect(m.fetchExclusions).not.toHaveBeenCalledWith('viewer-A');
    expect(m.fetchLastChatAt).toHaveBeenCalledWith('viewer-B', 'tenant-B', 'target-2');
  });
});

describe('shared interests / groups / events computation', () => {
  it('intersects interests, keeping only terms the viewer also has', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchInterests.mockResolvedValue(new Map([
      ['viewer', ['yoga', 'chess']],
      ['p1', ['yoga', 'painting']],
    ]));
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.shared_interests).toEqual(['yoga']);
  });

  it('resolves shared group/event names only for ids present in both sets', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchGroupsForUsers.mockResolvedValue(new Map([
      ['viewer', new Set(['g1', 'g2'])],
      ['p1', new Set(['g2', 'g3'])],
    ]));
    m.fetchGroupNames.mockResolvedValue(new Map([['g2', 'Shared Group']]));
    m.fetchEventsForUsers.mockResolvedValue(new Map([
      ['viewer', new Set(['e1'])],
      ['p1', new Set(['e1', 'e2'])],
    ]));
    m.fetchEventTitles.mockResolvedValue(new Map([['e1', 'Shared Event']]));
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.shared_groups).toEqual(['Shared Group']);
    expect(ctx!.shared_events).toEqual(['Shared Event']);
    // fetchGroupNames must have been called with only the intersection.
    expect(m.fetchGroupNames).toHaveBeenCalledWith(['g2']);
  });
});

describe('privacy minimization for private profiles with no relationship', () => {
  it('minimizes a private profile to name-only when there is no relationship at all', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1', { visibility: 'private', bio: 'secret', city: 'Secret City', country: 'Secretland' }));
    m.fetchPersonPosts.mockResolvedValue([{ id: 'post1', user_id: 'p1', content: 'hi', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' }]);
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.privacy_limited).toBe(true);
    expect(ctx!.person.bio).toBeNull();
    expect(ctx!.person.city).toBeNull();
    expect(ctx!.person.country).toBeNull();
    expect(ctx!.latest_posts).toEqual([]);
    expect(ctx!.upcoming_events).toEqual([]);
    expect(ctx!.shared_interests).toEqual([]);
    expect(ctx!.recommended_next_action).toBeNull();
  });

  it('does NOT minimize a private profile when the viewer follows them', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1', { visibility: 'private' }));
    m.fetchFollowFlags.mockResolvedValue({ you_follow: true, follows_you: false });
    m.fetchPersonPosts.mockResolvedValue([{ id: 'post1', user_id: 'p1', content: 'hi', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' }]);
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.privacy_limited).toBe(false);
    expect(ctx!.latest_posts).toHaveLength(1);
  });

  it('does NOT minimize a private profile when there is a match', async () => {
    const match: MatchSummary = { person: person('p1'), score: 80, reasons: [], source: 'daily_match', matched_at: 't', action: null, conversation_started: false, is_current: true };
    m.fetchPersonById.mockResolvedValue(person('p1', { visibility: 'private' }));
    m.fetchMatches.mockResolvedValue([match]);
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.privacy_limited).toBe(false);
  });

  it('does NOT minimize a private profile when there is prior chat history', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1', { visibility: 'private' }));
    m.fetchLastChatAt.mockResolvedValue('2026-01-01T00:00:00Z');
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.privacy_limited).toBe(false);
  });

  it('a public profile is never privacy-limited regardless of relationship', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1', { visibility: 'public' }));
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.privacy_limited).toBe(false);
  });
});

describe('recommended next action', () => {
  it('recommends a first message for an untouched match with no chat history', async () => {
    const match: MatchSummary = { person: person('p1'), score: 80, reasons: [], source: 'daily_match', matched_at: 't', action: null, conversation_started: false, is_current: true };
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchMatches.mockResolvedValue([match]);
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.recommended_next_action).toMatch(/Send a first message/);
  });

  it('recommends reconnecting when the last chat was over a week ago', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchLastChatAt.mockResolvedValue(new Date(Date.now() - 10 * 86400000).toISOString());
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.recommended_next_action).toMatch(/Reconnect/);
  });

  it('recommends continuing the conversation for a recent chat', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchLastChatAt.mockResolvedValue(new Date(Date.now() - 1 * 86400000).toISOString());
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.recommended_next_action).toBe('Continue your conversation.');
  });

  it('recommends following back when they follow the viewer but not vice versa', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchFollowFlags.mockResolvedValue({ you_follow: false, follows_you: true });
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.recommended_next_action).toMatch(/follow back/);
  });

  it('recommends opening the profile when the viewer already follows them', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchFollowFlags.mockResolvedValue({ you_follow: true, follows_you: false });
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.recommended_next_action).toBe('Open their profile to see their latest activity.');
  });

  it('recommends saying hello in a shared group as a fallback signal', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchGroupsForUsers.mockResolvedValue(new Map([
      ['viewer', new Set(['g1'])],
      ['p1', new Set(['g1'])],
    ]));
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.recommended_next_action).toMatch(/shared group/);
  });

  it('falls back to "learn more" with zero signals', async () => {
    m.fetchPersonById.mockResolvedValue(person('p1'));
    const ctx = await buildPersonContext({ tenant_id: 't', user_id: 'viewer', person_id: 'p1' });
    expect(ctx!.recommended_next_action).toBe('Open their profile to learn more.');
  });
});

describe('buildRelevanceSummary', () => {
  function baseCtx(overrides: Partial<PersonContext> = {}): PersonContext {
    return {
      person: person('p1'),
      you_follow: false,
      follows_you: false,
      match: null,
      shared_interests: [],
      shared_groups: [],
      shared_events: [],
      latest_posts: [],
      upcoming_events: [],
      last_chat_at: null,
      privacy_limited: false,
      recommended_next_action: null,
      relevance_summary: '',
      ...overrides,
    };
  }

  it('returns the privacy-limited sentence when privacy_limited is true', () => {
    const s = buildRelevanceSummary(baseCtx({ privacy_limited: true }));
    expect(s).toContain('keeps their profile private');
  });

  it('falls back to the generic community sentence with zero relevance signals', () => {
    const s = buildRelevanceSummary(baseCtx());
    expect(s).toBe('Name-p1 is a member of your Maxina community.');
  });

  it('mentions mutual follow when both directions are true', () => {
    const s = buildRelevanceSummary(baseCtx({ you_follow: true, follows_you: true }));
    expect(s).toContain('you follow each other');
  });

  it('appends the recommended next action when present', () => {
    const s = buildRelevanceSummary(baseCtx({ recommended_next_action: 'Say hi.' }));
    expect(s).toContain('Best next step: Say hi.');
  });

  it('includes the match score and lowercased top reason', () => {
    const match: MatchSummary = { person: person('p1'), score: 88, reasons: ['Shared Goals'], source: 'daily_match', matched_at: 't', action: null, conversation_started: false, is_current: true };
    const s = buildRelevanceSummary(baseCtx({ match }));
    expect(s).toContain('88-point match');
    expect(s).toContain('shared goals');
  });
});

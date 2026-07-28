/**
 * Tests for social-memory-repository.ts — the sole Supabase read layer for
 * Social Memory Intelligence.
 *
 * Privacy/tenant-isolation focus (CLAUDE.md ALWAYS-28 "scope memory by
 * tenant + role", NEVER-7 "never mix tenant data"): every function that
 * reads user- or tenant-scoped rows is checked both for (a) the in-process
 * filtering it performs on the JS side (blocked/muted/hidden exclusion,
 * self-exclusion, dedupe) and (b) that it actually issues the scoping
 * filter to Supabase (.eq('user_id', ...), .eq('tenant_id', ...)) rather
 * than fetching unscoped and relying on something else to filter.
 */

import { makeSupabaseSequence, QueryResult } from './supabase-mock';

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

import { getSupabase } from '../../../src/lib/supabase';
import * as repo from '../../../src/services/social-memory/social-memory-repository';

const mockGetSupabase = getSupabase as jest.Mock;

function useSequence(sequence: QueryResult[]) {
  const { client, log } = makeSupabaseSequence(sequence);
  mockGetSupabase.mockReturnValue(client);
  return log;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// fetchPeople
// ---------------------------------------------------------------------------

describe('fetchPeople', () => {
  it('returns an empty map and makes no query for an empty id list', async () => {
    const log = useSequence([]);
    const out = await repo.fetchPeople([]);
    expect(out.size).toBe(0);
    expect(log).toHaveLength(0);
  });

  it('dedupes and drops falsy ids before querying', async () => {
    const log = useSequence([{ data: [] }]);
    await repo.fetchPeople(['u1', 'u1', '', null as any, 'u2']);
    const inCall = log[0].calls.find((c) => c[0] === 'in');
    expect(inCall![2]).toEqual(['u1', 'u2']);
  });

  it('maps rows to SocialPerson with nullish-coalesced fields', async () => {
    useSequence([{ data: [{ user_id: 'u1', display_name: 'Ada', handle: null, avatar_url: null, bio: null, city: null, country: null, account_visibility: 'public', vitana_id: 'v1' }] }]);
    const out = await repo.fetchPeople(['u1']);
    expect(out.get('u1')).toEqual({
      user_id: 'u1',
      display_name: 'Ada',
      handle: null,
      vitana_id: 'v1',
      avatar_url: null,
      bio: null,
      city: null,
      country: null,
      visibility: 'public',
    });
  });

  it('returns an empty map when supabase is unavailable', async () => {
    mockGetSupabase.mockReturnValue(null);
    const out = await repo.fetchPeople(['u1']);
    expect(out.size).toBe(0);
  });

  it('caps the ids sent to Supabase at 200', async () => {
    const log = useSequence([{ data: [] }]);
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    await repo.fetchPeople(ids);
    const inCall = log[0].calls.find((c) => c[0] === 'in');
    expect(inCall![2]).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// fetchExclusions — fail-closed contract
// ---------------------------------------------------------------------------

describe('fetchExclusions', () => {
  it('throws when supabase is unavailable (fail closed)', async () => {
    mockGetSupabase.mockReturnValue(null);
    await expect(repo.fetchExclusions('u1')).rejects.toThrow('exclusions_unavailable');
  });

  it('throws when any of the three underlying reads errors (fail closed)', async () => {
    useSequence([
      { data: [], error: null },
      { data: null, error: { message: 'muted table down' } },
      { data: [], error: null },
    ]);
    await expect(repo.fetchExclusions('u1')).rejects.toThrow('exclusions_read_failed: muted table down');
  });

  it('aggregates blocked/muted/hidden sets from the three tables', async () => {
    useSequence([
      { data: [{ author_id: 'b1' }, { author_id: 'b2' }] },
      { data: [{ author_id: 'm1' }] },
      { data: [{ post_id: 'p1' }] },
    ]);
    const excl = await repo.fetchExclusions('u1');
    expect(excl.blocked).toEqual(new Set(['b1', 'b2']));
    expect(excl.muted).toEqual(new Set(['m1']));
    expect(excl.hidden_posts).toEqual(new Set(['p1']));
  });

  it('scopes every exclusion read to the requesting user_id', async () => {
    const log = useSequence([{ data: [] }, { data: [] }, { data: [] }]);
    await repo.fetchExclusions('user-A');
    for (const q of log) {
      const eqCall = q.calls.find((c) => c[0] === 'eq');
      expect(eqCall).toEqual(['eq', 'user_id', 'user-A']);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchFollowEdges — user scoping + blocked exclusion
// ---------------------------------------------------------------------------

describe('fetchFollowEdges', () => {
  it('scopes the outgoing/incoming queries to the requesting user only', async () => {
    const log = useSequence([{ data: [] }, { data: [] }]);
    await repo.fetchFollowEdges('user-A', new Set());
    const outEq = log[0].calls.find((c) => c[0] === 'eq');
    const inEq = log[1].calls.find((c) => c[0] === 'eq');
    expect(outEq).toEqual(['eq', 'follower_id', 'user-A']);
    expect(inEq).toEqual(['eq', 'following_id', 'user-A']);
  });

  it('excludes blocked people from both following and followers lists', async () => {
    useSequence([
      { data: [{ following_id: 'blocked-1', created_at: 't1' }, { following_id: 'ok-1', created_at: 't2' }] },
      { data: [{ follower_id: 'blocked-2', created_at: 't3' }, { follower_id: 'ok-2', created_at: 't4' }] },
      { data: [{ user_id: 'ok-1', display_name: 'OK1' }, { user_id: 'ok-2', display_name: 'OK2' }] },
    ]);
    const { following, followers } = await repo.fetchFollowEdges('user-A', new Set(['blocked-1', 'blocked-2']));
    expect(following.map((f) => f.person.user_id)).toEqual(['ok-1']);
    expect(followers.map((f) => f.person.user_id)).toEqual(['ok-2']);
  });

  it('drops edges whose person could not be resolved (no profile row)', async () => {
    useSequence([
      { data: [{ following_id: 'ghost', created_at: 't1' }] },
      { data: [] },
      { data: [] }, // profiles lookup finds nothing
    ]);
    const { following } = await repo.fetchFollowEdges('user-A', new Set());
    expect(following).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchMatches — merge, blocked exclusion, dedupe precedence, sort
// ---------------------------------------------------------------------------

describe('fetchMatches', () => {
  it('excludes blocked people from both match sources', async () => {
    useSequence([
      { data: [{ matched_user_id: 'blocked-1', match_score: 90, match_reasons: [], action: null, expires_at: null, created_at: 't1' }] },
      { data: [{ user_id_1: 'viewer', user_id_2: 'blocked-2', compatibility_score: 80, match_reason: null, matched_at: 't2', conversation_started: false, is_active: true }] },
      { data: [] },
    ]);
    const out = await repo.fetchMatches('viewer', new Set(['blocked-1', 'blocked-2']));
    expect(out).toEqual([]);
  });

  it('prefers the daily_match summary over user_match when the same person appears in both', async () => {
    useSequence([
      { data: [{ matched_user_id: 'p1', match_score: 95, match_reasons: ['fresh reason'], action: 'accepted', expires_at: null, created_at: 't1' }] },
      { data: [{ user_id_1: 'viewer', user_id_2: 'p1', compatibility_score: 10, match_reason: 'stale reason', matched_at: 't0', conversation_started: true, is_active: true }] },
      { data: [{ user_id: 'p1', display_name: 'P1' }] },
    ]);
    const out = await repo.fetchMatches('viewer', new Set());
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('daily_match');
    expect(out[0].score).toBe(95);
    expect(out[0].reasons).toEqual(['fresh reason']);
  });

  it('resolves the "other" user_id regardless of which side of user_matches the viewer is on', async () => {
    useSequence([
      { data: [] },
      { data: [{ user_id_1: 'other', user_id_2: 'viewer', compatibility_score: 50, match_reason: 'x', matched_at: 't1', conversation_started: false, is_active: true }] },
      { data: [{ user_id: 'other', display_name: 'Other' }] },
    ]);
    const out = await repo.fetchMatches('viewer', new Set());
    expect(out[0].person.user_id).toBe('other');
  });

  it('sorts by score descending, treating a null score as 0', async () => {
    useSequence([
      { data: [
        { matched_user_id: 'low', match_score: 10, match_reasons: [], action: null, expires_at: null, created_at: 't' },
        { matched_user_id: 'high', match_score: 99, match_reasons: [], action: null, expires_at: null, created_at: 't' },
        { matched_user_id: 'null-score', match_score: null, match_reasons: [], action: null, expires_at: null, created_at: 't' },
      ] },
      { data: [] },
      { data: [
        { user_id: 'low', display_name: 'Low' },
        { user_id: 'high', display_name: 'High' },
        { user_id: 'null-score', display_name: 'Null' },
      ] },
    ]);
    const out = await repo.fetchMatches('viewer', new Set());
    expect(out.map((m) => m.person.user_id)).toEqual(['high', 'low', 'null-score']);
  });

  it('marks is_current true only when expires_at is absent or in the future', async () => {
    useSequence([
      { data: [
        { matched_user_id: 'expired', match_score: 1, match_reasons: [], action: null, expires_at: '2000-01-01T00:00:00Z', created_at: 't' },
        { matched_user_id: 'active', match_score: 2, match_reasons: [], action: null, expires_at: null, created_at: 't' },
      ] },
      { data: [] },
      { data: [
        { user_id: 'expired', display_name: 'Expired' },
        { user_id: 'active', display_name: 'Active' },
      ] },
    ]);
    const out = await repo.fetchMatches('viewer', new Set());
    expect(out.find((m) => m.person.user_id === 'expired')!.is_current).toBe(false);
    expect(out.find((m) => m.person.user_id === 'active')!.is_current).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchRecentMessageContacts — tenant scoping + own-conversations-only
// ---------------------------------------------------------------------------

describe('fetchRecentMessageContacts', () => {
  it('scopes the message read to the requesting tenant', async () => {
    const log = useSequence([{ data: [] }]);
    await repo.fetchRecentMessageContacts('user-A', 'tenant-A', new Set());
    const eqCall = log[0].calls.find((c) => c[0] === 'eq' && c[1] === 'tenant_id');
    expect(eqCall).toEqual(['eq', 'tenant_id', 'tenant-A']);
  });

  it('excludes blocked peers and never returns the viewer as their own contact', async () => {
    useSequence([
      { data: [
        { sender_id: 'user-A', receiver_id: 'blocked-1', content: 'hi', created_at: 't1' },
        { sender_id: 'user-A', receiver_id: 'user-A', content: 'note to self', created_at: 't2' },
        { sender_id: 'ok-peer', receiver_id: 'user-A', content: 'hello', created_at: 't3' },
      ] },
      { data: [{ user_id: 'ok-peer', display_name: 'OK Peer' }] },
    ]);
    const out = await repo.fetchRecentMessageContacts('user-A', 'tenant-A', new Set(['blocked-1']));
    expect(out.map((c) => c.person.user_id)).toEqual(['ok-peer']);
    expect(out[0].last_direction).toBe('received');
    expect(out[0].messages_30d).toBe(1);
  });

  it('truncates the last-message snippet to 120 chars', async () => {
    const long = 'y'.repeat(200);
    useSequence([
      { data: [{ sender_id: 'user-A', receiver_id: 'peer', content: long, created_at: 't1' }] },
      { data: [{ user_id: 'peer', display_name: 'Peer' }] },
    ]);
    const out = await repo.fetchRecentMessageContacts('user-A', 'tenant-A', new Set());
    expect(out[0].last_snippet!.length).toBe(120);
  });

  it('respects the peer limit', async () => {
    useSequence([
      { data: [
        { sender_id: 'user-A', receiver_id: 'p1', content: '', created_at: 't3' },
        { sender_id: 'user-A', receiver_id: 'p2', content: '', created_at: 't2' },
        { sender_id: 'user-A', receiver_id: 'p3', content: '', created_at: 't1' },
      ] },
      { data: [
        { user_id: 'p1', display_name: 'P1' },
        { user_id: 'p2', display_name: 'P2' },
      ] },
    ]);
    const out = await repo.fetchRecentMessageContacts('user-A', 'tenant-A', new Set(), 2);
    expect(out).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// fetchGroupChats — tenant scoping via membership, short-circuit
// ---------------------------------------------------------------------------

describe('fetchGroupChats', () => {
  it('scopes the membership lookup to user + tenant', async () => {
    const log = useSequence([{ data: [] }]);
    await repo.fetchGroupChats('user-A', 'tenant-A');
    const calls = log[0].calls.filter((c) => c[0] === 'eq');
    expect(calls).toContainEqual(['eq', 'user_id', 'user-A']);
    expect(calls).toContainEqual(['eq', 'tenant_id', 'tenant-A']);
  });

  it('short-circuits to [] and issues no further queries when the user has no memberships', async () => {
    const log = useSequence([{ data: [] }]);
    const out = await repo.fetchGroupChats('user-A', 'tenant-A');
    expect(out).toEqual([]);
    expect(log).toHaveLength(1);
  });

  it('assembles group summaries with member counts and last-message timestamps', async () => {
    useSequence([
      { data: [{ group_id: 'g1', joined_at: '2026-01-01T00:00:00Z' }] }, // memberships
      { data: [{ id: 'g1', name: 'Wellness Circle', is_system: false }] }, // chat_groups
      { data: [{ group_id: 'g1' }, { group_id: 'g1' }, { group_id: 'g1' }] }, // member counts
      { data: [{ group_id: 'g1', created_at: '2026-02-01T00:00:00Z' }] }, // last messages
    ]);
    const out = await repo.fetchGroupChats('user-A', 'tenant-A');
    expect(out).toEqual([{
      group_id: 'g1',
      name: 'Wellness Circle',
      member_count: 3,
      is_system: false,
      last_message_at: '2026-02-01T00:00:00Z',
      joined_at: '2026-01-01T00:00:00Z',
    }]);
  });
});

// ---------------------------------------------------------------------------
// fetchCandidatePosts — privacy filtering (blocked/muted/hidden/own/public)
// ---------------------------------------------------------------------------

describe('fetchCandidatePosts', () => {
  const excl = { blocked: new Set(['blocked-u']), muted: new Set(['muted-u']), hidden_posts: new Set(['hidden-p']) };

  it('excludes own posts, blocked/muted authors, and hidden posts', async () => {
    useSequence([
      { data: [
        { id: 'p-own', user_id: 'viewer', content: '', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' },
        { id: 'p-blocked', user_id: 'blocked-u', content: '', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' },
        { id: 'p-muted', user_id: 'muted-u', content: '', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' },
        { id: 'hidden-p', user_id: 'ok-u', content: '', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' },
        { id: 'p-ok', user_id: 'ok-u', content: '', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' },
      ] },
    ]);
    const out = await repo.fetchCandidatePosts('viewer', [], excl);
    expect(out.map((p) => p.id)).toEqual(['p-ok']);
  });

  it('dedupes a post that appears in both the base pool and the followed-authors pool', async () => {
    useSequence([
      { data: [{ id: 'p1', user_id: 'ok-u', content: '', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' }] },
      { data: [{ id: 'p1', user_id: 'ok-u', content: '', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: 't' }] },
    ]);
    const out = await repo.fetchCandidatePosts('viewer', ['ok-u'], excl);
    expect(out).toHaveLength(1);
  });

  it('only queries the followed-authors pool when followedIds is non-empty', async () => {
    const log = useSequence([{ data: [] }]);
    await repo.fetchCandidatePosts('viewer', [], excl);
    expect(log).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fetchPersonPosts — public-only contract
// ---------------------------------------------------------------------------

describe('fetchPersonPosts', () => {
  it('restricts the read to the target person and public, non-rejected posts', async () => {
    const log = useSequence([{ data: [] }]);
    await repo.fetchPersonPosts('person-1');
    const calls = log[0].calls;
    expect(calls).toContainEqual(['eq', 'user_id', 'person-1']);
    expect(calls).toContainEqual(['eq', 'is_public', true]);
    expect(calls).toContainEqual(['neq', 'moderation_status', 'rejected']);
  });
});

// ---------------------------------------------------------------------------
// fetchEventParticipants — status exclusion
// ---------------------------------------------------------------------------

describe('fetchEventParticipants', () => {
  it('returns an empty map and makes no query for an empty event id list', async () => {
    const log = useSequence([]);
    const out = await repo.fetchEventParticipants([]);
    expect(out.size).toBe(0);
    expect(log).toHaveLength(0);
  });

  it('excludes cancelled and declined participants', async () => {
    useSequence([{ data: [
      { event_id: 'e1', user_id: 'u1', status: 'confirmed' },
      { event_id: 'e1', user_id: 'u2', status: 'cancelled' },
      { event_id: 'e1', user_id: 'u3', status: 'declined' },
    ] }]);
    const out = await repo.fetchEventParticipants(['e1']);
    expect(out.get('e1')).toEqual(['u1']);
  });
});

// ---------------------------------------------------------------------------
// fetchEventsForUsers / fetchGroupsForUsers — per-user set isolation
// ---------------------------------------------------------------------------

describe('fetchEventsForUsers', () => {
  it('keeps each user\'s event set separate (no cross-user leakage)', async () => {
    useSequence([{ data: [
      { event_id: 'e1', user_id: 'user-A' },
      { event_id: 'e2', user_id: 'user-B' },
    ] }]);
    const out = await repo.fetchEventsForUsers(['user-A', 'user-B']);
    expect(out.get('user-A')).toEqual(new Set(['e1']));
    expect(out.get('user-B')).toEqual(new Set(['e2']));
    expect(out.get('user-A')!.has('e2')).toBe(false);
  });
});

describe('fetchGroupsForUsers', () => {
  it('keeps each user\'s group set separate (no cross-user leakage)', async () => {
    useSequence([{ data: [
      { group_id: 'g1', user_id: 'user-A' },
      { group_id: 'g2', user_id: 'user-B' },
    ] }]);
    const out = await repo.fetchGroupsForUsers(['user-A', 'user-B']);
    expect(out.get('user-A')).toEqual(new Set(['g1']));
    expect(out.get('user-B')).toEqual(new Set(['g2']));
  });
});

// ---------------------------------------------------------------------------
// fetchInterests — cap at 15, lowercased
// ---------------------------------------------------------------------------

describe('fetchInterests', () => {
  it('lowercases interests and caps at 15 per user', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ user_id: 'u1', interest: `TERM-${i}`, confidence_score: 20 - i }));
    useSequence([{ data: rows }]);
    const out = await repo.fetchInterests(['u1']);
    expect(out.get('u1')).toHaveLength(15);
    expect(out.get('u1')![0]).toBe('term-0');
  });

  it('does not mix interests between different users', async () => {
    useSequence([{ data: [
      { user_id: 'user-A', interest: 'yoga', confidence_score: 1 },
      { user_id: 'user-B', interest: 'chess', confidence_score: 1 },
    ] }]);
    const out = await repo.fetchInterests(['user-A', 'user-B']);
    expect(out.get('user-A')).toEqual(['yoga']);
    expect(out.get('user-B')).toEqual(['chess']);
  });
});

// ---------------------------------------------------------------------------
// fetchLastChatAt — tenant scoping
// ---------------------------------------------------------------------------

describe('fetchLastChatAt', () => {
  it('scopes the read to the requesting tenant', async () => {
    const log = useSequence([{ data: [] }]);
    await repo.fetchLastChatAt('user-A', 'tenant-A', 'person-1');
    const eqCall = log[0].calls.find((c) => c[0] === 'eq' && c[1] === 'tenant_id');
    expect(eqCall).toEqual(['eq', 'tenant_id', 'tenant-A']);
  });

  it('returns null when there is no shared thread', async () => {
    useSequence([{ data: [] }]);
    const out = await repo.fetchLastChatAt('user-A', 'tenant-A', 'person-1');
    expect(out).toBeNull();
  });

  it('returns the latest timestamp when present', async () => {
    useSequence([{ data: [{ created_at: '2026-05-01T00:00:00Z' }] }]);
    const out = await repo.fetchLastChatAt('user-A', 'tenant-A', 'person-1');
    expect(out).toBe('2026-05-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// fetchFollowFlags
// ---------------------------------------------------------------------------

describe('fetchFollowFlags', () => {
  it('reports both flags false when no edges exist', async () => {
    useSequence([{ data: [] }, { data: [] }]);
    const out = await repo.fetchFollowFlags('user-A', 'person-1');
    expect(out).toEqual({ you_follow: false, follows_you: false });
  });

  it('reports you_follow true when an outbound edge exists', async () => {
    useSequence([{ data: [{ id: 'e1' }] }, { data: [] }]);
    const out = await repo.fetchFollowFlags('user-A', 'person-1');
    expect(out).toEqual({ you_follow: true, follows_you: false });
  });

  it('reports follows_you true when an inbound edge exists', async () => {
    useSequence([{ data: [] }, { data: [{ id: 'e1' }] }]);
    const out = await repo.fetchFollowFlags('user-A', 'person-1');
    expect(out).toEqual({ you_follow: false, follows_you: true });
  });
});

// ---------------------------------------------------------------------------
// resolvePersonByName — search gate + privacy (searchable=false)
// ---------------------------------------------------------------------------

describe('resolvePersonByName', () => {
  it('returns null without querying for a hint shorter than 2 chars', async () => {
    const log = useSequence([]);
    const out = await repo.resolvePersonByName('a');
    expect(out).toBeNull();
    expect(log).toHaveLength(0);
  });

  it('returns null when no profile matches', async () => {
    useSequence([{ data: [] }]);
    const out = await repo.resolvePersonByName('Nobody');
    expect(out).toBeNull();
  });

  it('prefers an exact display_name match over a substring match', async () => {
    useSequence([
      { data: [
        { user_id: 'u-substr', display_name: 'Mariia Long', full_name: 'Mariia Long' },
        { user_id: 'u-exact', display_name: 'Mariia', full_name: 'Mariia' },
      ] },
      { single: { searchable: true } },
    ]);
    const out = await repo.resolvePersonByName('Mariia');
    expect(out!.user_id).toBe('u-exact');
  });

  it('returns null when the matched profile is not searchable (privacy gate)', async () => {
    useSequence([
      { data: [{ user_id: 'u1', display_name: 'Mariia', full_name: 'Mariia' }] },
      { single: { searchable: false } },
    ]);
    const out = await repo.resolvePersonByName('Mariia');
    expect(out).toBeNull();
  });

  it('returns the person when no privacy row exists (defaults to searchable)', async () => {
    useSequence([
      { data: [{ user_id: 'u1', display_name: 'Mariia', full_name: 'Mariia' }] },
      { single: null },
    ]);
    const out = await repo.resolvePersonByName('Mariia');
    expect(out!.user_id).toBe('u1');
  });
});

// ---------------------------------------------------------------------------
// fetchPersonById
// ---------------------------------------------------------------------------

describe('fetchPersonById', () => {
  it('returns null when the person does not exist', async () => {
    useSequence([{ data: [] }]);
    const out = await repo.fetchPersonById('ghost');
    expect(out).toBeNull();
  });

  it('returns the resolved person', async () => {
    useSequence([{ data: [{ user_id: 'u1', display_name: 'Ada' }] }]);
    const out = await repo.fetchPersonById('u1');
    expect(out!.display_name).toBe('Ada');
  });
});

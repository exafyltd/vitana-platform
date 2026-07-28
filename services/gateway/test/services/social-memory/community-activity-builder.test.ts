/**
 * Tests for community-activity-builder.ts.
 *
 *   buildPersonActivity(personId) — one person's recent visible activity.
 *   buildNetworkDigest(importantPersonIds, excludeIds) — network-wide
 *     digest of recent visible activity for a set of "important" people.
 *
 * Isolation focus: buildPersonActivity must only ever surface the target
 * person's own rows; buildNetworkDigest must only surface rows for the
 * ids it was given (never people outside importantPersonIds, and never
 * anyone in excludeIds e.g. blocked authors).
 */

import { makeSupabaseSequence, QueryResult } from './_supabase-mock';

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));
jest.mock('../../../src/services/social-memory/social-memory-repository', () => ({
  fetchPersonById: jest.fn(),
  fetchPersonPosts: jest.fn(),
  fetchPeople: jest.fn(),
  fetchEventTitles: jest.fn(),
}));

import { getSupabase } from '../../../src/lib/supabase';
import * as repo from '../../../src/services/social-memory/social-memory-repository';
import {
  buildPersonActivity,
  buildNetworkDigest,
} from '../../../src/services/social-memory/community-activity-builder';
import { SocialPerson } from '../../../src/services/social-memory/social-memory-types';

const mockGetSupabase = getSupabase as jest.Mock;
const m = repo as jest.Mocked<typeof repo>;

function person(id: string): SocialPerson {
  return {
    user_id: id,
    display_name: `Name-${id}`,
    handle: null,
    vitana_id: null,
    avatar_url: null,
    bio: null,
    city: null,
    country: null,
    visibility: 'public',
  };
}

function useSequence(sequence: QueryResult[]) {
  const { client, log } = makeSupabaseSequence(sequence);
  mockGetSupabase.mockReturnValue(client);
  return log;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// buildPersonActivity
// ---------------------------------------------------------------------------

describe('buildPersonActivity', () => {
  it('returns an empty activity context (but keeps the person) when supabase is unavailable', async () => {
    mockGetSupabase.mockReturnValue(null);
    m.fetchPersonById.mockResolvedValue(person('p1'));
    const out = await buildPersonActivity('p1');
    expect(out.person!.user_id).toBe('p1');
    expect(out.items).toEqual([]);
  });

  it('returns an empty activity context when the person does not resolve', async () => {
    useSequence([]);
    m.fetchPersonById.mockResolvedValue(null);
    m.fetchPersonPosts.mockResolvedValue([]);
    const out = await buildPersonActivity('ghost');
    expect(out.person).toBeNull();
    expect(out.items).toEqual([]);
  });

  it('scopes the event/group activity reads to the target person only', async () => {
    const log = useSequence([
      { data: [] }, // global_event_participants
      { data: [] }, // global_community_group_members
    ]);
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchPersonPosts.mockResolvedValue([]);
    await buildPersonActivity('p1');
    const eventsQuery = log.find((q) => q.table === 'global_event_participants');
    const groupsQuery = log.find((q) => q.table === 'global_community_group_members');
    expect(eventsQuery!.calls).toContainEqual(['eq', 'user_id', 'p1']);
    expect(groupsQuery!.calls).toContainEqual(['eq', 'user_id', 'p1']);
  });

  it('assembles posts, event joins, and group joins into a sorted, capped item list', async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
    useSequence([
      { data: [{ event_id: 'e1', registered_at: daysAgo(3) }] }, // participations
      { data: [{ group_id: 'g1', joined_at: daysAgo(1) }] }, // groupJoins
      { data: [{ id: 'g1', name: 'Wellness Circle' }] }, // group name lookup
    ]);
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchPersonPosts.mockResolvedValue([
      { id: 'post1', user_id: 'p1', content: 'hello there', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: daysAgo(2) },
    ]);
    m.fetchEventTitles.mockResolvedValue(new Map([['e1', 'Longevity Summit']]));

    const out = await buildPersonActivity('p1', 30);
    expect(out.items.map((i) => i.kind)).toEqual(['group_joined', 'post', 'event_joined']);
    expect(out.items[0].summary).toContain('Wellness Circle');
    expect(out.items[1].summary).toContain('hello there');
    expect(out.items[2].summary).toContain('Longevity Summit');
  });

  it('excludes posts older than the requested window even if fetchPersonPosts returned them', async () => {
    useSequence([
      { data: [] },
      { data: [] },
    ]);
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchPersonPosts.mockResolvedValue([
      { id: 'old-post', user_id: 'p1', content: 'ancient', image_url: null, video_url: null, likes_count: 0, comments_count: 0, created_at: '2000-01-01T00:00:00Z' },
    ]);
    const out = await buildPersonActivity('p1', 7);
    expect(out.items).toEqual([]);
  });

  it('caps items at 10 even when more are available', async () => {
    const posts = Array.from({ length: 15 }, (_, i) => ({
      id: `post${i}`,
      user_id: 'p1',
      content: `post ${i}`,
      image_url: null,
      video_url: null,
      likes_count: 0,
      comments_count: 0,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
    }));
    useSequence([{ data: [] }, { data: [] }]);
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchPersonPosts.mockResolvedValue(posts);
    const out = await buildPersonActivity('p1', 365);
    expect(out.items.length).toBeLessThanOrEqual(10);
  });

  it('reflects the requested window_days in the output', async () => {
    useSequence([{ data: [] }, { data: [] }]);
    m.fetchPersonById.mockResolvedValue(person('p1'));
    m.fetchPersonPosts.mockResolvedValue([]);
    const out = await buildPersonActivity('p1', 21);
    expect(out.window_days).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// buildNetworkDigest
// ---------------------------------------------------------------------------

describe('buildNetworkDigest', () => {
  it('returns an empty digest without querying when there are no important ids', async () => {
    const log = useSequence([]);
    const out = await buildNetworkDigest([], new Set());
    expect(out.items).toEqual([]);
    expect(out.person).toBeNull();
    expect(log).toHaveLength(0);
  });

  it('excludes ids present in excludeIds (e.g. blocked authors) from the query scope', async () => {
    const log = useSequence([{ data: [] }, { data: [] }]);
    await buildNetworkDigest(['important-1', 'blocked-1'], new Set(['blocked-1']));
    const postsQuery = log.find((q) => q.table === 'profile_posts')!;
    const inCall = postsQuery.calls.find((c) => c[0] === 'in')!;
    expect(inCall[2]).toEqual(['important-1']);
  });

  it('scopes posts to public, non-rejected content only', async () => {
    const log = useSequence([{ data: [] }, { data: [] }]);
    await buildNetworkDigest(['u1'], new Set());
    const postsQuery = log.find((q) => q.table === 'profile_posts')!;
    expect(postsQuery.calls).toContainEqual(['eq', 'is_public', true]);
    expect(postsQuery.calls).toContainEqual(['neq', 'moderation_status', 'rejected']);
  });

  it('names authors from the resolved people map, falling back to a generic label', async () => {
    useSequence([
      { data: [{ id: 'post1', user_id: 'u1', content: 'hi network', created_at: '2026-07-27T00:00:00Z' }] },
      { data: [] },
    ]);
    m.fetchPeople.mockResolvedValue(new Map([['u1', person('u1')]]));
    const out = await buildNetworkDigest(['u1'], new Set());
    expect(out.items[0].summary).toContain('Name-u1');
  });

  it('falls back to a generic label when the author could not be resolved', async () => {
    useSequence([
      { data: [{ id: 'post1', user_id: 'u1', content: 'hi network', created_at: '2026-07-27T00:00:00Z' }] },
      { data: [] },
    ]);
    m.fetchPeople.mockResolvedValue(new Map());
    const out = await buildNetworkDigest(['u1'], new Set());
    expect(out.items[0].summary).toContain('Someone you follow');
  });

  it('sorts items newest-first across posts and event joins', async () => {
    useSequence([
      { data: [{ id: 'post1', user_id: 'u1', content: 'older post', created_at: '2026-07-25T00:00:00Z' }] },
      { data: [{ event_id: 'e1', user_id: 'u2', registered_at: '2026-07-27T00:00:00Z' }] },
    ]);
    m.fetchPeople.mockResolvedValue(new Map([['u1', person('u1')], ['u2', person('u2')]]));
    m.fetchEventTitles.mockResolvedValue(new Map([['e1', 'Meetup']]));
    const out = await buildNetworkDigest(['u1', 'u2'], new Set());
    expect(out.items[0].kind).toBe('event_joined');
    expect(out.items[1].kind).toBe('post');
  });

  it('caps items at 12', async () => {
    const posts = Array.from({ length: 20 }, (_, i) => ({
      id: `post${i}`,
      user_id: 'u1',
      content: `p${i}`,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
    }));
    useSequence([{ data: posts }, { data: [] }]);
    m.fetchPeople.mockResolvedValue(new Map([['u1', person('u1')]]));
    const out = await buildNetworkDigest(['u1'], new Set());
    expect(out.items.length).toBeLessThanOrEqual(12);
  });

  it('caps the ids sent to the query at 40', async () => {
    const log = useSequence([{ data: [] }, { data: [] }]);
    const ids = Array.from({ length: 60 }, (_, i) => `u${i}`);
    await buildNetworkDigest(ids, new Set());
    const postsQuery = log.find((q) => q.table === 'profile_posts')!;
    const inCall = postsQuery.calls.find((c) => c[0] === 'in')!;
    expect(inCall[2]).toHaveLength(40);
  });
});

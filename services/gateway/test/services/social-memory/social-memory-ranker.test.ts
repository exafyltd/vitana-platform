/**
 * Tests for social-memory-ranker.ts — explainable post/event ranking.
 *
 * Focus: the actual scoring/ordering algorithm (relative ordering across
 * signals, capping, topK truncation, default reasons, empty input) rather
 * than "returns an array" tautologies.
 */

import {
  rankInterestingPosts,
  rankInterestingEvents,
  extractTerms,
  buildMatchScoreMap,
  PostRankSignals,
  EventRankSignals,
} from '../../../src/services/social-memory/social-memory-ranker';
import { RawPost, RawEvent } from '../../../src/services/social-memory/social-memory-repository';
import { SocialPerson, MatchSummary } from '../../../src/services/social-memory/social-memory-types';

const NOW = new Date('2026-07-28T12:00:00.000Z').getTime();

function isoMinusHours(hours: number): string {
  return new Date(NOW - hours * 3600000).toISOString();
}

function person(id: string, name = id): SocialPerson {
  return {
    user_id: id,
    display_name: name,
    handle: null,
    vitana_id: null,
    avatar_url: null,
    bio: null,
    city: null,
    country: null,
    visibility: 'public',
  };
}

function post(overrides: Partial<RawPost> & { id: string; user_id: string }): RawPost {
  return {
    content: 'hello world',
    image_url: null,
    video_url: null,
    likes_count: 0,
    comments_count: 0,
    created_at: isoMinusHours(1),
    ...overrides,
  };
}

function baseSignals(overrides: Partial<PostRankSignals> = {}): PostRankSignals {
  return {
    viewer_id: 'viewer-1',
    followed_ids: new Set(),
    match_scores: new Map(),
    interests: [],
    goal_terms: [],
    shared_group_counts: new Map(),
    people: new Map(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('rankInterestingPosts', () => {
  it('returns [] for empty candidates', () => {
    expect(rankInterestingPosts([], baseSignals())).toEqual([]);
  });

  it('ranks a followed author above a stranger, all else equal', () => {
    const candidates = [
      post({ id: 'p-stranger', user_id: 'u-stranger', created_at: isoMinusHours(1) }),
      post({ id: 'p-followed', user_id: 'u-followed', created_at: isoMinusHours(1) }),
    ];
    const signals = baseSignals({ followed_ids: new Set(['u-followed']) });
    const ranked = rankInterestingPosts(candidates, signals);
    expect(ranked.map((r) => r.post_id)).toEqual(['p-followed', 'p-stranger']);
    expect(ranked[0].reason).toContain('You follow this person');
  });

  it('ranks a high-quality match above a plain match', () => {
    const candidates = [
      post({ id: 'p-plain', user_id: 'u-plain', created_at: isoMinusHours(1) }),
      post({ id: 'p-hq', user_id: 'u-hq', created_at: isoMinusHours(1) }),
    ];
    const signals = baseSignals({
      match_scores: new Map([
        ['u-plain', 50],
        ['u-hq', 90],
      ]),
    });
    const ranked = rankInterestingPosts(candidates, signals);
    expect(ranked.map((r) => r.post_id)).toEqual(['p-hq', 'p-plain']);
    expect(ranked[0].reason.some((r) => r.includes('high-quality'))).toBe(true);
    expect(ranked[1].reason.some((r) => r === 'This author is one of your matches')).toBe(true);
  });

  it('ranks posts matching more interest terms above fewer matches', () => {
    const candidates = [
      post({ id: 'p-one', user_id: 'u-1', content: 'I love yoga today', created_at: isoMinusHours(1) }),
      post({
        id: 'p-three',
        user_id: 'u-2',
        content: 'yoga and meditation help my sleep',
        created_at: isoMinusHours(1),
      }),
    ];
    const signals = baseSignals({ interests: ['yoga', 'meditation', 'sleep'] });
    const ranked = rankInterestingPosts(candidates, signals);
    expect(ranked[0].post_id).toBe('p-three');
    expect(ranked[0].reason.some((r) => r.startsWith('Matches your interests'))).toBe(true);
  });

  it('caps the interest-match boost at 20 regardless of how many terms hit', () => {
    const candidates = [
      post({
        id: 'p-many',
        user_id: 'u-1',
        content: 'alpha beta gamma delta epsilon zeta',
        created_at: isoMinusHours(1000), // push freshness/engagement near zero
      }),
    ];
    const signals = baseSignals({
      interests: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
    });
    const ranked = rankInterestingPosts(candidates, signals);
    // 6 hits * 8 = 48, capped to 20 -> score should not exceed 20 + tiny freshness/engagement (~0)
    expect(ranked[0].score).toBeLessThanOrEqual(21);
  });

  it('boosts posts that reference the viewer goal terms', () => {
    const candidates = [
      post({ id: 'p-goal', user_id: 'u-1', content: 'working on longevity', created_at: isoMinusHours(1) }),
      post({ id: 'p-nogoal', user_id: 'u-2', content: 'random chatter', created_at: isoMinusHours(1) }),
    ];
    const signals = baseSignals({ goal_terms: ['longevity'] });
    const ranked = rankInterestingPosts(candidates, signals);
    expect(ranked[0].post_id).toBe('p-goal');
    expect(ranked[0].reason).toContain('This topic connects to your current goal');
  });

  it('boosts posts by authors who share community groups with the viewer, capped at 10', () => {
    const candidates = [
      post({ id: 'p-shared', user_id: 'u-shared', created_at: isoMinusHours(1) }),
      post({ id: 'p-none', user_id: 'u-none', created_at: isoMinusHours(1) }),
    ];
    const signals = baseSignals({
      shared_group_counts: new Map([['u-shared', 5]]), // 5*5=25, capped to 10
    });
    const ranked = rankInterestingPosts(candidates, signals);
    const shared = ranked.find((r) => r.post_id === 'p-shared')!;
    expect(shared.reason.some((r) => r.includes('You share 5 groups'))).toBe(true);
    expect(ranked[0].post_id).toBe('p-shared');
  });

  it('uses singular "group" when exactly one shared group', () => {
    const candidates = [post({ id: 'p1', user_id: 'u1', created_at: isoMinusHours(1) })];
    const signals = baseSignals({ shared_group_counts: new Map([['u1', 1]]) });
    const ranked = rankInterestingPosts(candidates, signals);
    expect(ranked[0].reason.some((r) => r === 'You share 1 group with the author')).toBe(true);
  });

  it('ranks a fresher post above an older post with identical other signals', () => {
    const candidates = [
      post({ id: 'p-old', user_id: 'u-1', created_at: isoMinusHours(24 * 30) }),
      post({ id: 'p-fresh', user_id: 'u-2', created_at: isoMinusHours(1) }),
    ];
    const ranked = rankInterestingPosts(candidates, baseSignals());
    expect(ranked.map((r) => r.post_id)).toEqual(['p-fresh', 'p-old']);
  });

  it('ranks a more-engaged post above a less-engaged post at identical age', () => {
    const candidates = [
      post({ id: 'p-quiet', user_id: 'u-1', likes_count: 0, comments_count: 0, created_at: isoMinusHours(1) }),
      post({ id: 'p-popular', user_id: 'u-2', likes_count: 500, comments_count: 100, created_at: isoMinusHours(1) }),
    ];
    const ranked = rankInterestingPosts(candidates, baseSignals());
    expect(ranked[0].post_id).toBe('p-popular');
  });

  it('adds a small media bonus for image/video posts', () => {
    const withMedia = post({ id: 'p-media', user_id: 'u-1', image_url: 'http://x/i.png', created_at: isoMinusHours(1) });
    const withoutMedia = post({ id: 'p-plain', user_id: 'u-2', created_at: isoMinusHours(1) });
    const [rMedia] = rankInterestingPosts([withMedia], baseSignals());
    const [rPlain] = rankInterestingPosts([withoutMedia], baseSignals());
    expect(rMedia.score).toBeGreaterThan(rPlain.score);
    expect(rMedia.media_type).toBe('image');
    expect(rPlain.media_type).toBe('text');
  });

  it('classifies media_type as video when a video_url is present, even alongside an image', () => {
    const candidates = [
      post({ id: 'p1', user_id: 'u1', image_url: 'http://x/i.png', video_url: 'http://x/v.mp4', created_at: isoMinusHours(1) }),
    ];
    const [ranked] = rankInterestingPosts(candidates, baseSignals());
    expect(ranked.media_type).toBe('video');
  });

  it('falls back to a default reason when no ranking signal fires', () => {
    const candidates = [post({ id: 'p1', user_id: 'u1', created_at: isoMinusHours(2000) })];
    const [ranked] = rankInterestingPosts(candidates, baseSignals());
    expect(ranked.reason).toEqual(['Recent public post from the community']);
  });

  it('fills in an unknown-author card when the author is missing from the people map', () => {
    const candidates = [post({ id: 'p1', user_id: 'ghost-user', created_at: isoMinusHours(1) })];
    const [ranked] = rankInterestingPosts(candidates, baseSignals());
    expect(ranked.author.user_id).toBe('ghost-user');
    expect(ranked.author.display_name).toBeNull();
  });

  it('uses the resolved person card when the author is present in the people map', () => {
    const candidates = [post({ id: 'p1', user_id: 'u1', created_at: isoMinusHours(1) })];
    const signals = baseSignals({ people: new Map([['u1', person('u1', 'Mariia')]]) });
    const [ranked] = rankInterestingPosts(candidates, signals);
    expect(ranked.author.display_name).toBe('Mariia');
  });

  it('caps the total score at 100 even when every boost stacks', () => {
    const candidates = [
      post({
        id: 'p-max',
        user_id: 'u-max',
        content: 'alpha beta gamma longevity',
        likes_count: 100000,
        comments_count: 100000,
        image_url: 'http://x/i.png',
        created_at: isoMinusHours(0),
      }),
    ];
    const signals = baseSignals({
      followed_ids: new Set(['u-max']),
      match_scores: new Map([['u-max', 99]]),
      interests: ['alpha', 'beta', 'gamma'],
      goal_terms: ['longevity'],
      shared_group_counts: new Map([['u-max', 10]]),
    });
    const [ranked] = rankInterestingPosts(candidates, signals);
    expect(ranked.score).toBe(100);
  });

  it('truncates results to topK, keeping the highest scores', () => {
    // Spaced-out engagement counts so the rounded log10 engagement bonus
    // is strictly increasing (avoids a scoring tie that would make the
    // truncation ambiguous under a stable sort).
    const likeCounts = [0, 3, 10, 31, 100];
    const candidates = likeCounts.map((likes, i) =>
      post({ id: `p${i}`, user_id: `u${i}`, likes_count: likes, created_at: isoMinusHours(1) }),
    );
    const ranked = rankInterestingPosts(candidates, baseSignals(), 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.post_id)).toEqual(['p4', 'p3']);
  });

  it('truncates the snippet to 160 chars', () => {
    const longContent = 'x'.repeat(300);
    const candidates = [post({ id: 'p1', user_id: 'u1', content: longContent, created_at: isoMinusHours(1) })];
    const [ranked] = rankInterestingPosts(candidates, baseSignals());
    expect(ranked.snippet.length).toBe(160);
  });
});

describe('rankInterestingEvents', () => {
  function ev(overrides: Partial<RawEvent> & { id: string }): RawEvent {
    return {
      title: 'Community Meetup',
      description: null,
      event_type: null,
      start_time: new Date(NOW + 5 * 86400000).toISOString(),
      location: null,
      slug: 'meetup',
      participant_count: 0,
      ...overrides,
    };
  }

  function baseEventSignals(overrides: Partial<EventRankSignals> = {}): EventRankSignals {
    return {
      viewer_id: 'viewer-1',
      followed_ids: new Set(),
      match_scores: new Map(),
      interests: [],
      goal_terms: [],
      location_terms: [],
      participants: new Map(),
      people: new Map(),
      ...overrides,
    };
  }

  it('returns [] for empty candidates', () => {
    expect(rankInterestingEvents([], baseEventSignals())).toEqual([]);
  });

  it('ranks an event with followed attendees above one with none', () => {
    const candidates = [ev({ id: 'e-plain' }), ev({ id: 'e-followed' })];
    const signals = baseEventSignals({
      followed_ids: new Set(['u-friend']),
      participants: new Map([['e-followed', ['u-friend']]]),
    });
    const ranked = rankInterestingEvents(candidates, signals);
    expect(ranked[0].event_id).toBe('e-followed');
    expect(ranked[0].reason.some((r) => r.includes('person you follow is attending'))).toBe(true);
  });

  it('pluralizes the followed-attendee reason for 2+ people', () => {
    const candidates = [ev({ id: 'e1' })];
    const signals = baseEventSignals({
      followed_ids: new Set(['a', 'b']),
      participants: new Map([['e1', ['a', 'b']]]),
    });
    const [ranked] = rankInterestingEvents(candidates, signals);
    expect(ranked.reason.some((r) => r.includes('people you follow are attending'))).toBe(true);
  });

  it('flags high-quality-match attendees', () => {
    const candidates = [ev({ id: 'e1' })];
    const signals = baseEventSignals({
      match_scores: new Map([['u-hq', 80]]),
      participants: new Map([['e1', ['u-hq']]]),
    });
    const [ranked] = rankInterestingEvents(candidates, signals);
    expect(ranked.reason).toContain('One of your high-quality matches is attending');
  });

  it('boosts events matching interests and goal terms', () => {
    const candidates = [
      ev({ id: 'e-match', title: 'Yoga retreat', description: 'longevity focused' }),
      ev({ id: 'e-nomatch', title: 'Book club' }),
    ];
    const signals = baseEventSignals({ interests: ['yoga'], goal_terms: ['longevity'] });
    const ranked = rankInterestingEvents(candidates, signals);
    expect(ranked[0].event_id).toBe('e-match');
  });

  it('boosts events near the viewer location', () => {
    const candidates = [
      ev({ id: 'e-near', location: 'Berlin, Germany' }),
      ev({ id: 'e-far', location: 'Tokyo, Japan' }),
    ];
    const signals = baseEventSignals({ location_terms: ['berlin'] });
    const ranked = rankInterestingEvents(candidates, signals);
    expect(ranked[0].event_id).toBe('e-near');
    expect(ranked[0].reason).toContain('It is near you');
  });

  it('ranks sooner events above later ones, all else equal', () => {
    const candidates = [
      ev({ id: 'e-later', start_time: new Date(NOW + 30 * 86400000).toISOString() }),
      ev({ id: 'e-soon', start_time: new Date(NOW + 1 * 86400000).toISOString() }),
    ];
    const ranked = rankInterestingEvents(candidates, baseEventSignals());
    expect(ranked.map((r) => r.event_id)).toEqual(['e-soon', 'e-later']);
  });

  it('gives a small popularity boost at 5+ participants', () => {
    const small = ev({ id: 'e-small', participant_count: 2 });
    const big = ev({ id: 'e-big', participant_count: 5 });
    const [rSmall] = rankInterestingEvents([small], baseEventSignals());
    const [rBig] = rankInterestingEvents([big], baseEventSignals());
    expect(rBig.score).toBeGreaterThan(rSmall.score);
  });

  it('falls back to a default reason when nothing else fires', () => {
    const candidates = [ev({ id: 'e1', start_time: new Date(NOW + 365 * 86400000).toISOString() })];
    const [ranked] = rankInterestingEvents(candidates, baseEventSignals());
    expect(ranked.reason).toEqual(['Upcoming community event']);
  });

  it('builds the deep-link url from the slug, or null when absent', () => {
    const withSlug = ev({ id: 'e1', slug: 'my-event' });
    const withoutSlug = ev({ id: 'e2', slug: null });
    const ranked = rankInterestingEvents([withSlug, withoutSlug], baseEventSignals());
    expect(ranked.find((r) => r.event_id === 'e1')!.url).toBe('https://vitanaland.com/e/my-event');
    expect(ranked.find((r) => r.event_id === 'e2')!.url).toBeNull();
  });

  it('lists followed/matched attendee display names, capped at 3', () => {
    const candidates = [ev({ id: 'e1' })];
    const people = new Map([
      ['a', person('a', 'Ada')],
      ['b', person('b', 'Bob')],
      ['c', person('c', 'Cid')],
      ['d', person('d', 'Dee')],
    ]);
    const signals = baseEventSignals({
      followed_ids: new Set(['a', 'b', 'c', 'd']),
      participants: new Map([['e1', ['a', 'b', 'c', 'd']]]),
      people,
    });
    const [ranked] = rankInterestingEvents(candidates, signals);
    expect(ranked.followed_attendees).toEqual(['Ada', 'Bob', 'Cid']);
  });

  it('caps score at 100 and truncates to topK', () => {
    const candidates = Array.from({ length: 4 }, (_, i) =>
      ev({ id: `e${i}`, start_time: new Date(NOW + (i + 1) * 86400000).toISOString(), participant_count: 100 }),
    );
    const ranked = rankInterestingEvents(candidates, baseEventSignals(), 2);
    expect(ranked).toHaveLength(2);
    ranked.forEach((r) => expect(r.score).toBeLessThanOrEqual(100));
  });
});

describe('extractTerms', () => {
  it('returns [] for null/undefined/empty text', () => {
    expect(extractTerms(null)).toEqual([]);
    expect(extractTerms(undefined)).toEqual([]);
    expect(extractTerms('')).toEqual([]);
  });

  it('lowercases and splits on non-alphanumeric boundaries', () => {
    expect(extractTerms('Longevity, Sleep! And-Focus')).toEqual(['longevity', 'sleep', 'focus']);
  });

  it('drops words shorter than 4 characters', () => {
    expect(extractTerms('I am on a big yoga journey')).not.toContain('big');
    expect(extractTerms('I am on a big yoga journey')).toEqual(expect.arrayContaining(['journey']));
  });

  it('de-duplicates repeated terms', () => {
    expect(extractTerms('sleep sleep sleep')).toEqual(['sleep']);
  });

  it('caps at 12 terms', () => {
    const words = Array.from({ length: 20 }, (_, i) => `term${i}`).join(' ');
    expect(extractTerms(words).length).toBe(12);
  });
});

describe('buildMatchScoreMap', () => {
  function match(personId: string, score: number | null): MatchSummary {
    return {
      person: person(personId),
      score,
      reasons: [],
      source: 'daily_match',
      matched_at: null,
      action: null,
      conversation_started: false,
      is_current: true,
    };
  }

  it('maps person_id -> score for scored matches', () => {
    const map = buildMatchScoreMap([match('u1', 80), match('u2', 40)]);
    expect(map.get('u1')).toBe(80);
    expect(map.get('u2')).toBe(40);
  });

  it('skips matches with a null score', () => {
    const map = buildMatchScoreMap([match('u1', null)]);
    expect(map.has('u1')).toBe(false);
  });

  it('returns an empty map for an empty list', () => {
    expect(buildMatchScoreMap([]).size).toBe(0);
  });
});

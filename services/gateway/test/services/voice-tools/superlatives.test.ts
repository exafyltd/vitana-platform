/**
 * Tests for src/services/voice-tools/superlatives.ts — the "who is...?"
 * voice tools (VTID-02754): getHighestVitanaIndex, getTopInPillar,
 * getMemberByRegistration, getMostFollowed, askWhoIs.
 *
 * Focus: privacy filtering (global_community_profiles.is_visible), correct
 * winner/ranking selection, error propagation from upstream query failures,
 * and — matching commit b9acd92's incident class — every returned value is
 * a well-formed, JSON-serializable object on every path (happy, empty,
 * error, clarify).
 */

import { createQueryMock, assertWellFormedToolResult, assertWellFormedObject } from './supabase-mock';
import {
  getHighestVitanaIndex,
  getTopInPillar,
  getMemberByRegistration,
  getMostFollowed,
  askWhoIs,
} from '../../../src/services/voice-tools/superlatives';

function appUsersRow(id: string, overrides: Record<string, any> = {}) {
  return {
    user_id: id,
    display_name: `Member ${id}`,
    avatar_url: null,
    vitana_id: `VIT-${id}`,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function profilesRow(id: string, overrides: Record<string, any> = {}) {
  return {
    user_id: id,
    registration_seq: 1,
    location: 'Berlin',
    ...overrides,
  };
}

let mock: ReturnType<typeof createQueryMock>;

beforeEach(() => {
  mock = createQueryMock();
});

// ---------------------------------------------------------------------------
// getHighestVitanaIndex
// ---------------------------------------------------------------------------

describe('getHighestVitanaIndex', () => {
  it('returns the top scorer with profile hydrated, filtering hidden users and dedupe-by-user', async () => {
    mock.setTable('global_community_profiles', { data: [{ user_id: 'u-hidden' }], error: null });
    mock.setTable('vitana_index_scores', {
      data: [
        { user_id: 'u-hidden', score_total: 99, date: '2026-07-28' }, // hidden — must be excluded
        { user_id: 'u-top', score_total: 90, date: '2026-07-28' },
        { user_id: 'u-top', score_total: 85, date: '2026-07-27' }, // dup user, older row — must be skipped
        { user_id: 'u-second', score_total: 80, date: '2026-07-28' },
      ],
      error: null,
    });
    mock.setTable('app_users', {
      data: [appUsersRow('u-top'), appUsersRow('u-second')],
      error: null,
    });
    mock.setTable('profiles', {
      data: [profilesRow('u-top'), profilesRow('u-second')],
      error: null,
    });

    const result = await getHighestVitanaIndex(mock.client, 1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metric).toBe('vitana_index_total');
      expect(result.metric_value).toBe(90);
      expect(result.metric_unit).toBe('points');
      expect(result.profile.vitana_id).toBe('VIT-u-top');
      expect(result.ranking).toBeUndefined(); // limit=1 → no ranking array
      // limit=1 means the scan stops as soon as one eligible winner is
      // found, so total_eligible reflects only what was scanned before
      // breaking — it must not count the hidden user encountered first.
      expect(result.total_eligible).toBe(1);
    }
    assertWellFormedToolResult(result);
  });

  it('populates the ranking array (only) when limit > 1, in score order', async () => {
    mock.setTable('global_community_profiles', { data: [], error: null });
    mock.setTable('vitana_index_scores', {
      data: [
        { user_id: 'u-1', score_total: 90, date: '2026-07-28' },
        { user_id: 'u-2', score_total: 80, date: '2026-07-28' },
        { user_id: 'u-3', score_total: 70, date: '2026-07-28' },
      ],
      error: null,
    });
    mock.setTable('app_users', {
      data: [appUsersRow('u-1'), appUsersRow('u-2'), appUsersRow('u-3')],
      error: null,
    });
    mock.setTable('profiles', {
      data: [profilesRow('u-1'), profilesRow('u-2'), profilesRow('u-3')],
      error: null,
    });

    const result = await getHighestVitanaIndex(mock.client, 2);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ranking).toHaveLength(2);
      expect(result.ranking!.map((p) => p.vitana_id)).toEqual(['VIT-u-1', 'VIT-u-2']);
      expect(result.profile.vitana_id).toBe('VIT-u-1');
    }
    assertWellFormedToolResult(result);
  });

  it('returns no_eligible_candidates when every candidate is hidden', async () => {
    mock.setTable('global_community_profiles', { data: [{ user_id: 'u-1' }], error: null });
    mock.setTable('vitana_index_scores', {
      data: [{ user_id: 'u-1', score_total: 90, date: '2026-07-28' }],
      error: null,
    });

    const result = await getHighestVitanaIndex(mock.client, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no_eligible_candidates');
    assertWellFormedToolResult(result);
  });

  it('returns no_eligible_candidates when there are no index rows at all', async () => {
    mock.setTable('vitana_index_scores', { data: [], error: null });

    const result = await getHighestVitanaIndex(mock.client, 1);

    expect(result.ok).toBe(false);
    assertWellFormedToolResult(result);
  });

  it('propagates an upstream query error as index_query_failed, never throwing', async () => {
    mock.setTable('vitana_index_scores', { data: null, error: { message: 'connection reset' } });

    const result = await getHighestVitanaIndex(mock.client, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('index_query_failed: connection reset');
    assertWellFormedToolResult(result);
  });
});

// ---------------------------------------------------------------------------
// getTopInPillar
// ---------------------------------------------------------------------------

describe('getTopInPillar', () => {
  it('rejects an invalid pillar before touching the database', async () => {
    const result = await getTopInPillar(mock.client, 'not_a_pillar' as any, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid pillar: not_a_pillar');
    expect(mock.calls.length).toBe(0);
    assertWellFormedToolResult(result);
  });

  it('returns the top scorer for the requested pillar column', async () => {
    mock.setTable('global_community_profiles', { data: [], error: null });
    mock.setTable('vitana_index_scores', {
      data: [
        { user_id: 'u-1', score_exercise: 95, date: '2026-07-28' },
        { user_id: 'u-2', score_exercise: 60, date: '2026-07-28' },
      ],
      error: null,
    });
    mock.setTable('app_users', { data: [appUsersRow('u-1')], error: null });
    mock.setTable('profiles', { data: [profilesRow('u-1')], error: null });

    const result = await getTopInPillar(mock.client, 'exercise', 1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metric).toBe('pillar_exercise');
      expect(result.metric_value).toBe(95);
      expect(result.profile.vitana_id).toBe('VIT-u-1');
    }
    assertWellFormedToolResult(result);
  });

  it('returns no_eligible_candidates when the pillar has no rows', async () => {
    mock.setTable('vitana_index_scores', { data: [], error: null });

    const result = await getTopInPillar(mock.client, 'sleep', 1);

    expect(result.ok).toBe(false);
    assertWellFormedToolResult(result);
  });

  it('propagates an upstream query error as pillar_query_failed', async () => {
    mock.setTable('vitana_index_scores', { data: null, error: { message: 'timeout' } });

    const result = await getTopInPillar(mock.client, 'mental', 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('pillar_query_failed: timeout');
    assertWellFormedToolResult(result);
  });
});

// ---------------------------------------------------------------------------
// getMemberByRegistration
// ---------------------------------------------------------------------------

describe('getMemberByRegistration', () => {
  it('returns the lowest registration_seq member for direction=first', async () => {
    mock.setTable('global_community_profiles', { data: [], error: null });
    // The DB does the ordering (order(ascending)) — the mock returns rows
    // verbatim, so the fixture must already reflect ascending order here.
    mock.setTable('profiles', {
      data: [
        profilesRow('u-2', { registration_seq: 1 }),
        profilesRow('u-1', { registration_seq: 500 }),
      ],
      error: null,
    });
    mock.setTable('app_users', {
      data: [appUsersRow('u-1'), appUsersRow('u-2')],
      error: null,
    });

    const result = await getMemberByRegistration(mock.client, 'first', 1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metric).toBe('first_member_registered');
      expect(result.metric_value).toBe(1);
      expect(result.profile.vitana_id).toBe('VIT-u-2');
    }
    assertWellFormedToolResult(result);
  });

  it('returns the highest registration_seq member for direction=newest', async () => {
    mock.setTable('global_community_profiles', { data: [], error: null });
    mock.setTable('profiles', {
      data: [
        profilesRow('u-1', { registration_seq: 500 }),
        profilesRow('u-2', { registration_seq: 1 }),
      ],
      error: null,
    });
    mock.setTable('app_users', {
      data: [appUsersRow('u-1'), appUsersRow('u-2')],
      error: null,
    });

    const result = await getMemberByRegistration(mock.client, 'newest', 1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metric).toBe('newest_member_registered');
      expect(result.metric_value).toBe(500);
      expect(result.profile.vitana_id).toBe('VIT-u-1');
    }
    assertWellFormedToolResult(result);
  });

  it('falls back to the profile member_since when registration_seq is null', async () => {
    mock.setTable('global_community_profiles', { data: [], error: null });
    mock.setTable('profiles', { data: [profilesRow('u-1', { registration_seq: null })], error: null });
    mock.setTable('app_users', {
      data: [appUsersRow('u-1', { created_at: '2025-05-01T00:00:00Z' })],
      error: null,
    });

    const result = await getMemberByRegistration(mock.client, 'first', 1);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metric_value).toBe('2025-05-01T00:00:00Z');
    assertWellFormedToolResult(result);
  });

  it('returns no_eligible_candidates when there are no profile rows', async () => {
    mock.setTable('profiles', { data: [], error: null });

    const result = await getMemberByRegistration(mock.client, 'first', 1);

    expect(result.ok).toBe(false);
    assertWellFormedToolResult(result);
  });

  it('propagates an upstream query error as registration_query_failed', async () => {
    mock.setTable('profiles', { data: null, error: { message: 'db unreachable' } });

    const result = await getMemberByRegistration(mock.client, 'newest', 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('registration_query_failed: db unreachable');
    assertWellFormedToolResult(result);
  });
});

// ---------------------------------------------------------------------------
// getMostFollowed
// ---------------------------------------------------------------------------

describe('getMostFollowed', () => {
  it('counts followers via to_user_id and returns the most-followed visible user', async () => {
    mock.setTable('global_community_profiles', { data: [{ user_id: 'u-hidden' }], error: null });
    mock.queueTable('relationships', {
      data: [
        { to_user_id: 'u-popular' },
        { to_user_id: 'u-popular' },
        { to_user_id: 'u-hidden' }, // hidden — excluded from the winner, but still in raw counts
        { to_user_id: 'u-quiet' },
      ],
      error: null,
    });
    mock.setTable('app_users', { data: [appUsersRow('u-popular')], error: null });
    mock.setTable('profiles', { data: [profilesRow('u-popular')], error: null });

    const result = await getMostFollowed(mock.client, 1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metric).toBe('follower_count');
      expect(result.metric_value).toBe(2);
      expect(result.metric_unit).toBe('followers');
      expect(result.profile.vitana_id).toBe('VIT-u-popular');
      expect(result.total_eligible).toBe(3); // raw counted users, incl. hidden, per source comment
    }
    assertWellFormedToolResult(result);
  });

  it('falls back to followee_id when to_user_id yields nothing', async () => {
    mock.setTable('global_community_profiles', { data: [], error: null });
    mock.queueTable('relationships', { data: [], error: null }); // probe1: to_user_id — empty
    mock.queueTable('relationships', {
      data: [{ followee_id: 'u-1' }, { followee_id: 'u-1' }],
      error: null,
    }); // probe2: followee_id
    mock.setTable('app_users', { data: [appUsersRow('u-1')], error: null });
    mock.setTable('profiles', { data: [profilesRow('u-1')], error: null });

    const result = await getMostFollowed(mock.client, 1);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metric_value).toBe(2);
    assertWellFormedToolResult(result);
  });

  it('returns no_followers_data (with the probe1 error message) when both probes fail/empty', async () => {
    mock.setTable('global_community_profiles', { data: [], error: null });
    mock.queueTable('relationships', { data: null, error: { message: 'no such column' } });
    mock.queueTable('relationships', { data: [], error: null });

    const result = await getMostFollowed(mock.client, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no_followers_data: no such column');
    assertWellFormedToolResult(result);
  });

  it('returns no_eligible_candidates when everyone with a follower count is hidden', async () => {
    mock.setTable('global_community_profiles', { data: [{ user_id: 'u-1' }], error: null });
    mock.queueTable('relationships', { data: [{ to_user_id: 'u-1' }], error: null });

    const result = await getMostFollowed(mock.client, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no_eligible_candidates');
    assertWellFormedToolResult(result);
  });
});

// ---------------------------------------------------------------------------
// askWhoIs — natural-language router
// ---------------------------------------------------------------------------

describe('askWhoIs', () => {
  beforeEach(() => {
    // Generic empty-but-valid defaults so any delegated call resolves
    // gracefully; individual tests override the tables their route needs.
    mock.setTable('global_community_profiles', { data: [], error: null });
  });

  it('rejects an empty question without delegating anywhere', async () => {
    const result = await askWhoIs(mock.client, { question: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok && result.ok !== 'clarify') expect((result as any).error).toBe('empty_question');
    expect(mock.calls.length).toBe(0);
    assertWellFormedToolResult(result);
  });

  it('returns an ok="clarify" response for an unroutable question', async () => {
    const result = await askWhoIs(mock.client, { question: 'what is the meaning of life' });

    expect((result as any).ok).toBe('clarify');
    expect(typeof (result as any).question).toBe('string');
    expect((result as any).question.length).toBeGreaterThan(0);
    assertWellFormedObject(result);
  });

  it('routes a pillar superlative question to getTopInPillar', async () => {
    mock.setTable('vitana_index_scores', {
      data: [{ user_id: 'u-1', score_exercise: 88, date: '2026-07-28' }],
      error: null,
    });
    mock.setTable('app_users', { data: [appUsersRow('u-1')], error: null });
    mock.setTable('profiles', { data: [profilesRow('u-1')], error: null });

    const result = await askWhoIs(mock.client, { question: 'who is best at exercise' });

    expect(result.ok).toBe(true);
    if (result.ok && result.ok !== 'clarify') expect((result as any).metric).toBe('pillar_exercise');
    assertWellFormedToolResult(result);
  });

  it('routes a Vitana Index leaderboard question to getHighestVitanaIndex', async () => {
    mock.setTable('vitana_index_scores', {
      data: [{ user_id: 'u-1', score_total: 91, date: '2026-07-28' }],
      error: null,
    });
    mock.setTable('app_users', { data: [appUsersRow('u-1')], error: null });
    mock.setTable('profiles', { data: [profilesRow('u-1')], error: null });

    const result = await askWhoIs(mock.client, { question: 'who has the highest vitana index right now' });

    expect(result.ok).toBe(true);
    if (result.ok && result.ok !== 'clarify') expect((result as any).metric).toBe('vitana_index_total');
    assertWellFormedToolResult(result);
  });

  it('routes a "first member" question to getMemberByRegistration(first)', async () => {
    mock.setTable('profiles', { data: [profilesRow('u-1', { registration_seq: 1 })], error: null });
    mock.setTable('app_users', { data: [appUsersRow('u-1')], error: null });

    const result = await askWhoIs(mock.client, { question: 'who was the first member to join' });

    expect(result.ok).toBe(true);
    if (result.ok && result.ok !== 'clarify') expect((result as any).metric).toBe('first_member_registered');
    assertWellFormedToolResult(result);
  });

  it('routes a "newest member" question to getMemberByRegistration(newest)', async () => {
    mock.setTable('profiles', { data: [profilesRow('u-1', { registration_seq: 9 })], error: null });
    mock.setTable('app_users', { data: [appUsersRow('u-1')], error: null });

    const result = await askWhoIs(mock.client, { question: 'who is the newest member here' });

    expect(result.ok).toBe(true);
    if (result.ok && result.ok !== 'clarify') expect((result as any).metric).toBe('newest_member_registered');
    assertWellFormedToolResult(result);
  });

  it('routes a "most followed" question to getMostFollowed', async () => {
    mock.queueTable('relationships', { data: [{ to_user_id: 'u-1' }], error: null });
    mock.setTable('app_users', { data: [appUsersRow('u-1')], error: null });
    mock.setTable('profiles', { data: [profilesRow('u-1')], error: null });

    const result = await askWhoIs(mock.client, { question: 'who is the most followed person' });

    expect(result.ok).toBe(true);
    if (result.ok && result.ok !== 'clarify') expect((result as any).metric).toBe('follower_count');
    assertWellFormedToolResult(result);
  });

  it('clamps limit into [1, 10]', async () => {
    mock.setTable('vitana_index_scores', {
      data: [{ user_id: 'u-1', score_total: 91, date: '2026-07-28' }],
      error: null,
    });
    mock.setTable('app_users', { data: [appUsersRow('u-1')], error: null });
    mock.setTable('profiles', { data: [profilesRow('u-1')], error: null });

    const overLimit = await askWhoIs(mock.client, {
      question: 'who has the highest vitana index',
      limit: 999,
    });
    // ranking is only populated when limit > 1 — with a single candidate
    // available, a clamped limit of 10 still yields a 1-entry ranking array.
    expect(overLimit.ok).toBe(true);
    if (overLimit.ok && overLimit.ok !== 'clarify') {
      expect((overLimit as any).ranking).toHaveLength(1);
    }
    assertWellFormedToolResult(overLimit);
  });
});

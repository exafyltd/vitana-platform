// Proactive Guide — Awareness Context (VTID-01927, Phase A) — unit tests
//
// Scope: getAwarenessContext() is the single assembly point that fans out
// to ~11 parallel sources and composes them into one UserAwareness object.
// Per the coverage plan, every sibling "D-engine" source is mocked wholesale
// at the module boundary (they have — or will have — their own suites);
// this file verifies awareness-context.ts's OWN logic:
//   1. no-supabase -> skeletal awareness (no sub-source touched)
//   2. full happy-path assembly (tenure/journey/community/goal/recent
//      activity/sessions/routines/adaptation/journey_v2 wiring)
//   3. fetchActiveGoal() and fetchRecentActivitySummary() — these run
//      directly against supabase (not mocked away) since they are this
//      file's own logic, not a sibling engine
//   4. per-source fail-open handling (every `.catch()` fallback + the
//      internal safeGatherUserContext try/catch)
//   5. buildTenure / buildJourney pure-assembly edge cases
//   6. the 30s per-(tenant,user,tz) cache + clearAwarenessCache()
//
// `wave-defaults.ts` is NOT mocked — it's static manifest data (like
// awareness-registry's own manifest), and buildJourney()'s wave-matching
// logic is exactly the kind of "assembly logic" this suite exists to cover.

const mockGetSupabase = jest.fn();
jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: (...args: any[]) => mockGetSupabase(...args),
}));

const mockGatherUserContext = jest.fn();
jest.mock('../../../src/services/recommendation-engine/analyzers/community-user-analyzer', () => ({
  gatherUserContext: (...args: any[]) => mockGatherUserContext(...args),
}));

const mockDescribeTimeSince = jest.fn();
const mockFetchLastSessionInfo = jest.fn();
jest.mock('../../../src/services/guide/temporal-bucket', () => ({
  describeTimeSince: (...args: any[]) => mockDescribeTimeSince(...args),
  fetchLastSessionInfo: (...args: any[]) => mockFetchLastSessionInfo(...args),
}));

const mockGetFeatureIntroductions = jest.fn();
jest.mock('../../../src/services/guide/feature-introductions', () => ({
  getFeatureIntroductions: (...args: any[]) => mockGetFeatureIntroductions(...args),
}));

const mockGetRecentSessionSummaries = jest.fn();
const mockGetSessionsTodayAndYesterday = jest.fn();
jest.mock('../../../src/services/guide/session-summaries', () => ({
  getRecentSessionSummaries: (...args: any[]) => mockGetRecentSessionSummaries(...args),
  getSessionsTodayAndYesterday: (...args: any[]) => mockGetSessionsTodayAndYesterday(...args),
}));

const mockResolveUserTimezone = jest.fn();
jest.mock('../../../src/services/guide/user-timezone', () => ({
  resolveUserTimezone: (...args: any[]) => mockResolveUserTimezone(...args),
}));

const mockGetAdaptationStatus = jest.fn();
jest.mock('../../../src/services/guide/adaptation-applier', () => ({
  getAdaptationStatus: (...args: any[]) => mockGetAdaptationStatus(...args),
}));

const mockGetUserRoutines = jest.fn();
jest.mock('../../../src/services/guide/pattern-extractor', () => ({
  getUserRoutines: (...args: any[]) => mockGetUserRoutines(...args),
}));

const mockCountActiveUsageDays = jest.fn();
jest.mock('../../../src/services/guide/active-usage', () => ({
  countActiveUsageDays: (...args: any[]) => mockCountActiveUsageDays(...args),
}));

const mockBuildJourneyV2Awareness = jest.fn();
jest.mock('../../../src/services/guide/awareness-extensions', () => ({
  buildJourneyV2Awareness: (...args: any[]) => mockBuildJourneyV2Awareness(...args),
}));

const mockGetJourneyState = jest.fn();
jest.mock('../../../src/services/journey/user-journey-service', () => ({
  getJourneyState: (...args: any[]) => mockGetJourneyState(...args),
}));

import { getAwarenessContext, clearAwarenessCache } from '../../../src/services/guide/awareness-context';

const TENANT = 'tenant-1';
const USER = 'user-1';

type QueryResult = { data?: unknown; count?: unknown; error?: unknown };

/** Fake supabase client for the two queries awareness-context.ts issues
 *  directly (fetchActiveGoal: life_compass; fetchRecentActivitySummary:
 *  autopilot_recommendations x3, calendar_events x2) — 6 calls total, in
 *  that fixed synchronous construction order. */
function createSupabaseMock(queue: QueryResult[]) {
  let i = 0;
  const fromCalls: string[] = [];
  const client = {
    from: jest.fn((table: string) => {
      fromCalls.push(table);
      const chain: any = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        gte: jest.fn(() => chain),
        gt: jest.fn(() => chain),
        lt: jest.fn(() => chain),
        order: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        then: (resolve: any, reject: any) => {
          const next = i < queue.length ? queue[i] : { data: [], count: 0, error: null };
          i += 1;
          return Promise.resolve(next).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
  return { client, fromCalls };
}

/** Default queue: no life_compass row, all recent-activity counts 0. */
function quietQueue(): QueryResult[] {
  return [
    { data: [], error: null }, // life_compass
    { count: 0, error: null }, // autopilot_recommendations (open)
    { count: 0, error: null }, // autopilot_recommendations (activated)
    { count: 0, error: null }, // autopilot_recommendations (dismissed)
    { count: 0, error: null }, // calendar_events (overdue)
    { count: 0, error: null }, // calendar_events (upcoming)
  ];
}

function baseUserContext(overrides: Record<string, any> = {}) {
  return {
    userId: USER,
    tenantId: TENANT,
    userName: 'Dana',
    language: 'en',
    createdAt: new Date(Date.now() - 5 * 86400000), // 5 days ago
    onboardingStage: 'day7',
    healthScores: null,
    previousHealthScores: null,
    weaknesses: [],
    diaryMood: null,
    diaryEnergy: null,
    diaryStreak: 0,
    connectionCount: 0,
    groupCount: 0,
    pendingMatchCount: 0,
    memoryGoals: [],
    memoryInterests: [],
    ...overrides,
  };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  clearAwarenessCache();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  mockResolveUserTimezone.mockImplementation((tz: string | null | undefined) => tz || 'Europe/Berlin');
  mockDescribeTimeSince.mockImplementation((info: any) =>
    info
      ? { bucket: 'known', time_ago: 'mocked-ago', last_session_at: info.time, diff_ms: 0, was_failure: !!info.wasFailure, motivation_signal: 'fresh', days_since_last: 0 }
      : { bucket: 'first', time_ago: 'never before', last_session_at: null, diff_ms: Infinity, was_failure: false, motivation_signal: 'fresh', days_since_last: Infinity },
  );
  mockFetchLastSessionInfo.mockResolvedValue(null);
  mockGatherUserContext.mockResolvedValue(baseUserContext());
  mockGetFeatureIntroductions.mockResolvedValue([]);
  mockGetRecentSessionSummaries.mockResolvedValue([]);
  mockGetSessionsTodayAndYesterday.mockResolvedValue({ today: [], yesterday_last: null });
  mockGetAdaptationStatus.mockResolvedValue(null);
  mockGetUserRoutines.mockResolvedValue([]);
  mockCountActiveUsageDays.mockResolvedValue(0);
  mockBuildJourneyV2Awareness.mockResolvedValue(undefined);
  mockGetJourneyState.mockResolvedValue(null);
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// 1. No supabase -> skeletal awareness
// ---------------------------------------------------------------------------

describe('getAwarenessContext — no supabase', () => {
  it('returns a skeletal awareness object and never touches any sub-source', async () => {
    mockGetSupabase.mockReturnValue(null);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.tenure.stage).toBe('day30plus');
    expect(awareness.tenure.days_since_signup).toBe(0);
    expect(awareness.journey.is_past_90_day).toBe(true);
    expect(awareness.goal).toBeNull();
    expect(awareness.sessions_today).toEqual({ count: 0, entries: [] });
    expect(mockGatherUserContext).not.toHaveBeenCalled();
    expect(mockGetJourneyState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path assembly
// ---------------------------------------------------------------------------

describe('getAwarenessContext — happy path assembly', () => {
  it('computes tenure from gatherUserContext + countActiveUsageDays', async () => {
    const createdAt = new Date(Date.now() - 12 * 86400000);
    mockGatherUserContext.mockResolvedValue(baseUserContext({ createdAt, onboardingStage: 'day14' }));
    mockCountActiveUsageDays.mockResolvedValue(9);
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.tenure.stage).toBe('day14');
    expect(awareness.tenure.days_since_signup).toBe(12);
    expect(awareness.tenure.active_usage_days).toBe(9);
    expect(awareness.tenure.registered_at).toBe(createdAt.toISOString());
  });

  it('prefers journeyState.day_in_journey over tenure.days_since_signup when present', async () => {
    mockGatherUserContext.mockResolvedValue(baseUserContext({ createdAt: new Date(Date.now() - 40 * 86400000) }));
    mockGetJourneyState.mockResolvedValue({ day_in_journey: 3 });
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    // day 3 falls in wave-1 ("Getting Started", days 0-7) — proves the
    // journeyState day, not the 40-day tenure figure, drove the wave pick.
    expect(awareness.journey.day_in_journey).toBe(3);
    expect(awareness.journey.current_wave?.id).toBe('wave-1');
    expect(awareness.journey.is_past_90_day).toBe(false);
  });

  it('maps community_signals straight from the UserContext', async () => {
    mockGatherUserContext.mockResolvedValue(
      baseUserContext({ diaryStreak: 7, connectionCount: 4, groupCount: 2, pendingMatchCount: 1, memoryGoals: ['g1'], memoryInterests: ['i1'] }),
    );
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.community_signals).toEqual({
      diary_streak_days: 7,
      connection_count: 4,
      group_count: 2,
      pending_match_count: 1,
      memory_goals: ['g1'],
      memory_interests: ['i1'],
    });
  });

  it('maps feature_introductions, prior_session_themes, routines, and adaptation_plans from their sources', async () => {
    mockGetFeatureIntroductions.mockResolvedValue([{ feature_key: 'feat_a' }, { feature_key: 'feat_b' }]);
    mockGetRecentSessionSummaries.mockResolvedValue([
      { session_id: 's1', channel: 'voice', summary: 'talked', themes: ['sleep'], turn_count: 5, duration_ms: 1000, ended_at: '2026-07-01T00:00:00Z' },
    ]);
    mockGetUserRoutines.mockResolvedValue([{ routine_kind: 'time_of_day_preference', title: 'Morning person', summary: 'x', confidence: 0.8, extra_field: 'dropped' }]);
    mockGetAdaptationStatus.mockResolvedValue({ pending_plans: 2, applied_plans: 1, last_applied_at: '2026-07-01T00:00:00Z' });
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.feature_introductions).toEqual(['feat_a', 'feat_b']);
    expect(awareness.prior_session_themes).toEqual([{ session_id: 's1', summary: 'talked', themes: ['sleep'], ended_at: '2026-07-01T00:00:00Z' }]);
    expect(awareness.routines).toEqual([{ routine_kind: 'time_of_day_preference', title: 'Morning person', summary: 'x', confidence: 0.8 }]);
    expect(awareness.adaptation_plans).toEqual({ pending_plans: 2, applied_plans: 1, last_applied_at: '2026-07-01T00:00:00Z' });
  });

  it('maps sessions_today and last_session_yesterday with the full field shape', async () => {
    mockGetSessionsTodayAndYesterday.mockResolvedValue({
      today: [{ session_id: 't1', channel: 'text', summary: 'today summary', themes: ['x'], ended_at: '2026-07-20T09:00:00Z' }],
      yesterday_last: { session_id: 'y1', channel: 'voice', summary: 'yday summary', themes: ['y'], ended_at: '2026-07-19T20:00:00Z' },
    });
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.sessions_today).toEqual({
      count: 1,
      entries: [{ session_id: 't1', channel: 'text', summary: 'today summary', themes: ['x'], ended_at: '2026-07-20T09:00:00Z' }],
    });
    expect(awareness.last_session_yesterday).toEqual({ session_id: 'y1', channel: 'voice', summary: 'yday summary', themes: ['y'], ended_at: '2026-07-19T20:00:00Z' });
  });

  it('passes tenure/community/goal derived fields into buildJourneyV2Awareness and stores its result on journey_v2', async () => {
    mockGatherUserContext.mockResolvedValue(baseUserContext({ diaryStreak: 3, connectionCount: 5, groupCount: 1 }));
    const v2result = { extended_tenure_stage: 'x' } as any;
    mockBuildJourneyV2Awareness.mockResolvedValue(v2result);
    const sb = createSupabaseMock([
      { data: [{ id: 'g1', primary_goal: 'Custom goal', category: 'fitness', created_at: '2026-01-01' }], error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
    ]);
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(mockBuildJourneyV2Awareness).toHaveBeenCalledWith(
      USER,
      sb.client,
      expect.objectContaining({
        diary_streak_days: 3,
        connection_count: 5,
        group_count: 1,
        goal: { is_system_seeded: false },
      }),
    );
    expect(awareness.journey_v2).toBe(v2result);
  });

  it('resolvedTz is threaded into user_timezone and getSessionsTodayAndYesterday', async () => {
    mockResolveUserTimezone.mockImplementation((tz: string | null | undefined) => tz || 'Europe/Berlin');
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT, 'America/New_York');

    expect(awareness.user_timezone).toBe('America/New_York');
    expect(mockGetSessionsTodayAndYesterday).toHaveBeenCalledWith(USER, 'America/New_York');
  });
});

// ---------------------------------------------------------------------------
// 3. fetchActiveGoal() / fetchRecentActivitySummary() — real supabase logic
// ---------------------------------------------------------------------------

describe('getAwarenessContext — fetchActiveGoal (own logic, not mocked)', () => {
  it('marks the canonical auto-seeded longevity goal as is_system_seeded', async () => {
    const sb = createSupabaseMock([
      { data: [{ id: 'g1', primary_goal: 'Improve quality of life and extend lifespan', category: 'longevity', created_at: '2026-01-01' }], error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
    ]);
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.goal).toEqual({ primary_goal: 'Improve quality of life and extend lifespan', category: 'longevity', is_system_seeded: true });
  });

  it('does not mark a user-chosen goal in a non-longevity category as system-seeded', async () => {
    const sb = createSupabaseMock([
      { data: [{ id: 'g1', primary_goal: 'Run a marathon', category: 'fitness', created_at: '2026-01-01' }], error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
    ]);
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.goal).toEqual({ primary_goal: 'Run a marathon', category: 'fitness', is_system_seeded: false });
  });

  it('returns null goal when life_compass has no active row', async () => {
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.goal).toBeNull();
  });

  it('scopes the life_compass query to this exact user_id', async () => {
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    await getAwarenessContext(USER, TENANT);

    const lifeCompassChain = sb.client.from.mock.calls.find((c: any[]) => c[0] === 'life_compass');
    expect(lifeCompassChain).toBeDefined();
  });
});

describe('getAwarenessContext — fetchRecentActivitySummary (own logic, not mocked)', () => {
  it('maps all five counts, defaulting null/undefined counts to 0', async () => {
    const sb = createSupabaseMock([
      { data: [], error: null }, // life_compass
      { count: 3, error: null }, // open
      { count: null, error: null }, // activated -> defaults to 0
      { count: 2, error: null }, // dismissed
      { count: undefined, error: null }, // overdue -> defaults to 0
      { count: 1, error: null }, // upcoming
    ]);
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.recent_activity).toEqual({
      open_autopilot_recs: 3,
      activated_recs_last_7d: 0,
      dismissed_recs_last_7d: 2,
      overdue_calendar_count: 0,
      upcoming_calendar_24h_count: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Per-source fail-open handling
// ---------------------------------------------------------------------------

describe('getAwarenessContext — per-source fail-open handling', () => {
  it('gatherUserContext rejecting is caught internally and falls back to defaults, without crashing the whole assembly', async () => {
    mockGatherUserContext.mockRejectedValue(new Error('user-ctx boom'));
    mockCountActiveUsageDays.mockResolvedValue(2);
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.tenure.stage).toBe('day30plus');
    expect(awareness.tenure.days_since_signup).toBe(0);
    expect(awareness.tenure.active_usage_days).toBe(2);
    expect(awareness.community_signals).toEqual({
      diary_streak_days: 0,
      connection_count: 0,
      group_count: 0,
      pending_match_count: 0,
      memory_goals: [],
      memory_interests: [],
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gatherUserContext failed'), 'user-ctx boom');
  });

  it('fetchLastSessionInfo rejecting falls back to describeTimeSince(null) (the "first" bucket)', async () => {
    mockFetchLastSessionInfo.mockRejectedValue(new Error('boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(mockDescribeTimeSince).toHaveBeenCalledWith(null);
    expect(awareness.last_interaction?.bucket).toBe('first');
  });

  it('fetchLastSessionInfo resolving is passed straight through to describeTimeSince', async () => {
    mockFetchLastSessionInfo.mockResolvedValue({ time: '2026-07-01T00:00:00Z', wasFailure: false });
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(mockDescribeTimeSince).toHaveBeenCalledWith({ time: '2026-07-01T00:00:00Z', wasFailure: false });
    expect(awareness.last_interaction?.bucket).toBe('known');
  });

  it('getFeatureIntroductions rejecting falls back to an empty array', async () => {
    mockGetFeatureIntroductions.mockRejectedValue(new Error('boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.feature_introductions).toEqual([]);
  });

  it('getRecentSessionSummaries rejecting falls back to an empty prior_session_themes array', async () => {
    mockGetRecentSessionSummaries.mockRejectedValue(new Error('boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.prior_session_themes).toEqual([]);
  });

  it('getAdaptationStatus rejecting falls back to null', async () => {
    mockGetAdaptationStatus.mockRejectedValue(new Error('boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.adaptation_plans).toBeNull();
  });

  it('getUserRoutines rejecting falls back to an empty array', async () => {
    mockGetUserRoutines.mockRejectedValue(new Error('boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.routines).toEqual([]);
  });

  it('countActiveUsageDays rejecting falls back to 0 active usage days', async () => {
    mockCountActiveUsageDays.mockRejectedValue(new Error('boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.tenure.active_usage_days).toBe(0);
  });

  it('getSessionsTodayAndYesterday rejecting falls back to an empty sessions block', async () => {
    mockGetSessionsTodayAndYesterday.mockRejectedValue(new Error('boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.sessions_today).toEqual({ count: 0, entries: [] });
    expect(awareness.last_session_yesterday).toBeNull();
  });

  it('getJourneyState rejecting falls back to null (journey computed from tenure days-since-signup)', async () => {
    mockGatherUserContext.mockResolvedValue(baseUserContext({ createdAt: new Date(Date.now() - 3 * 86400000) }));
    mockGetJourneyState.mockRejectedValue(new Error('boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.journey.day_in_journey).toBe(3);
  });

  it('buildJourneyV2Awareness rejecting leaves journey_v2 undefined and logs a warning, without crashing', async () => {
    mockBuildJourneyV2Awareness.mockRejectedValue(new Error('v2 boom'));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);

    expect(awareness.journey_v2).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('journey_v2 extension failed'), 'v2 boom');
  });
});

// ---------------------------------------------------------------------------
// 5. buildTenure / buildJourney pure-assembly edge cases
// ---------------------------------------------------------------------------

describe('getAwarenessContext — buildTenure / buildJourney edge cases', () => {
  it('clamps a future createdAt (negative day count) to 0 rather than a negative number', async () => {
    mockGatherUserContext.mockResolvedValue(baseUserContext({ createdAt: new Date(Date.now() + 5 * 86400000) }));
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.tenure.days_since_signup).toBe(0);
  });

  it('is_past_90_day is true at exactly day 90', async () => {
    mockGetJourneyState.mockResolvedValue({ day_in_journey: 90 });
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.journey.is_past_90_day).toBe(true);
    expect(awareness.journey.current_wave).toBeNull();
  });

  it('is_past_90_day is false at day 89, with a matching wave selected', async () => {
    mockGetJourneyState.mockResolvedValue({ day_in_journey: 89 });
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    const awareness = await getAwarenessContext(USER, TENANT);
    expect(awareness.journey.is_past_90_day).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Caching + clearAwarenessCache()
// ---------------------------------------------------------------------------

describe('getAwarenessContext — caching', () => {
  it('a second call with the same (tenant, user, tz) within 30s hits the cache — no re-fetch', async () => {
    const sb = createSupabaseMock(quietQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    await getAwarenessContext(USER, TENANT, 'Europe/Berlin');
    await getAwarenessContext(USER, TENANT, 'Europe/Berlin');

    expect(mockGatherUserContext).toHaveBeenCalledTimes(1);
  });

  it('a different timezone produces a distinct cache entry (re-fetches)', async () => {
    mockResolveUserTimezone.mockImplementation((tz: string | null | undefined) => tz || 'Europe/Berlin');
    const sb = createSupabaseMock([...quietQueue(), ...quietQueue()]);
    mockGetSupabase.mockReturnValue(sb.client);

    await getAwarenessContext(USER, TENANT, 'Europe/Berlin');
    await getAwarenessContext(USER, TENANT, 'America/New_York');

    expect(mockGatherUserContext).toHaveBeenCalledTimes(2);
  });

  it('clearAwarenessCache(userId, tenantId) forces a re-fetch only for that user', async () => {
    const sb = createSupabaseMock([...quietQueue(), ...quietQueue()]);
    mockGetSupabase.mockReturnValue(sb.client);

    await getAwarenessContext(USER, TENANT);
    clearAwarenessCache(USER, TENANT);
    await getAwarenessContext(USER, TENANT);

    expect(mockGatherUserContext).toHaveBeenCalledTimes(2);
  });

  it('clearAwarenessCache() with no args clears every cached entry', async () => {
    const sb = createSupabaseMock([...quietQueue(), ...quietQueue()]);
    mockGetSupabase.mockReturnValue(sb.client);

    await getAwarenessContext(USER, TENANT);
    clearAwarenessCache();
    await getAwarenessContext(USER, TENANT);

    expect(mockGatherUserContext).toHaveBeenCalledTimes(2);
  });
});

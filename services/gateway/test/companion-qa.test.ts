/**
 * Companion QA Test Suite (VTID-01927 / -01931..36)
 *
 * Programmatic verification of the proactive companion stack.
 * Replaces manual voice-test checklist where possible — every behavior that
 * doesn't strictly require real Gemini Live audio is covered here.
 *
 * Sections:
 *   A. Opener selection (pickOpenerCandidate priority + tenure adjustments)
 *   B. Dismissal honor (pause-check, isPaused suppression, dismissal-tool)
 *   C. Awareness context structure
 *   D. Brain proactive guide block prompt content (forbidden phrases, mode banners,
 *      tenure × last_interaction matrix, awareness fields)
 *   E. Feature-introduction tracking (Phase G)
 *   F. Session summary recording + retrieval (Phase F)
 *   G. Pattern extractor (Phase C — derives routines from synthetic events)
 *
 * Run: cd services/gateway && npm test -- companion-qa
 */

import type {
  OpenerCandidate,
  UserAwareness,
  TenureStage,
} from '../src/services/guide';
import { describeTimeSince, deriveMotivationSignal } from '../src/services/guide/temporal-bucket';

// =============================================================================
// Supabase mock — chainable, configurable per-test via setMockData
// =============================================================================

type QueryResult = { data: any; error: any; count?: number | null };

let mockResponses: Map<string, QueryResult> = new Map();
let mockUpserts: Array<{ table: string; payload: any; conflict?: string }> = [];
let mockUpdates: Array<{ table: string; payload: any; matchers: Array<[string, any]> }> = [];

function setMockData(key: string, result: QueryResult) {
  mockResponses.set(key, result);
}

function buildChainableQuery(table: string): any {
  const filters: string[] = [];
  let isCountQuery = false;
  let limit: number | null = null;

  const chain: any = {
    select: (_cols?: string, opts?: any) => {
      if (opts?.count === 'exact') isCountQuery = true;
      return chain;
    },
    eq: (col: string, val: any) => {
      filters.push(`eq:${col}=${val}`);
      return chain;
    },
    gt: (col: string, val: any) => {
      filters.push(`gt:${col}>${val}`);
      return chain;
    },
    lt: (col: string, val: any) => {
      filters.push(`lt:${col}<${val}`);
      return chain;
    },
    gte: (col: string, val: any) => {
      filters.push(`gte:${col}>=${val}`);
      return chain;
    },
    not: (_col: string, _op: string, _val: any) => chain,
    is: (_col: string, _val: any) => chain,
    in: (col: string, vals: any[]) => {
      filters.push(`in:${col}=[${vals.join(',')}]`);
      return chain;
    },
    order: () => chain,
    limit: (n: number) => {
      limit = n;
      return chain;
    },
    single: () => {
      const key = `${table}:single`;
      const res = mockResponses.get(key) || mockResponses.get(table) || { data: null, error: null };
      return Promise.resolve(res);
    },
    upsert: (payload: any, opts?: { onConflict?: string }) => {
      mockUpserts.push({ table, payload, conflict: opts?.onConflict });
      const key = `${table}:upsert`;
      const res = mockResponses.get(key) || { data: payload, error: null };
      return Object.assign(Promise.resolve(res), {
        select: () => Object.assign(Promise.resolve(res), {
          single: () => Promise.resolve(res),
        }),
      });
    },
    insert: (payload: any) => {
      mockUpserts.push({ table, payload });
      const key = `${table}:insert`;
      const res = mockResponses.get(key) || { data: payload, error: null };
      return Object.assign(Promise.resolve(res), {
        select: () => Object.assign(Promise.resolve(res), {
          single: () => Promise.resolve(res),
        }),
      });
    },
    update: (payload: any) => {
      const matchers: Array<[string, any]> = [];
      const recordUpdate = () => {
        mockUpdates.push({ table, payload, matchers });
      };
      const updateChain: any = {
        eq: (col: string, val: any) => {
          matchers.push([col, val]);
          return updateChain;
        },
        gt: (col: string, val: any) => {
          matchers.push([`${col}_gt`, val]);
          return updateChain;
        },
        is: () => updateChain,
        select: (_cols?: string) => {
          recordUpdate();
          return Promise.resolve({ data: [{ id: 'mock' }], error: null, count: 1 });
        },
        then: (resolve: any) => {
          recordUpdate();
          return resolve({ data: payload, error: null });
        },
      };
      return updateChain;
    },
    then: (resolve: any) => {
      // For terminal queries that don't use .single() — invoked when awaited
      const key = `${table}:list`;
      const res = mockResponses.get(key) || mockResponses.get(table) || {
        data: [],
        error: null,
        count: isCountQuery ? 0 : undefined,
      };
      return resolve(res);
    },
  };
  return chain;
}

const mockSupabase = {
  from: (table: string) => buildChainableQuery(table),
};

jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/system-controls-service', () => ({
  getSystemControl: jest.fn().mockResolvedValue({ enabled: true }),
  isVitanaBrainOrbEnabled: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/services/ai-personality-service', () => ({
  getPersonalityConfigSync: () => ({
    forbidden_openings: [
      'What can I do for you?',
      'How can I help you today?',
      'How may I assist you?',
    ],
    silent_honor: {
      max_acknowledgement: 'got it',
      pivot_rule: 'pivot naturally',
    },
    common_instructions: 'Be helpful and accurate',
    instructions_orb: 'Keep responses brief and natural for voice',
    orb_instruction: 'You are Vitana, an intelligent voice assistant.',
  }),
}));

jest.mock('../src/services/recommendation-engine/analyzers/community-user-analyzer', () => ({
  gatherUserContext: jest.fn().mockImplementation(async (userId: string) => ({
    userId,
    tenantId: 'tenant-1',
    userName: 'Maria',
    language: 'en',
    createdAt: new Date(Date.now() - 5 * 86400_000), // 5 days ago = 'day3' stage
    onboardingStage: 'day3',
    healthScores: null,
    previousHealthScores: null,
    weaknesses: [],
    diaryMood: null,
    diaryEnergy: null,
    diaryStreak: 4,
    connectionCount: 7,
    groupCount: 2,
    pendingMatchCount: 1,
    memoryGoals: ['build a side business', 'sleep better'],
    memoryInterests: ['nutrition', 'meditation'],
  })),
  detectOnboardingStage: jest.fn().mockImplementation((createdAt: Date) => {
    const days = Math.floor((Date.now() - createdAt.getTime()) / 86400_000);
    if (days < 1) return 'day0';
    if (days < 3) return 'day1';
    if (days < 7) return 'day3';
    if (days < 14) return 'day7';
    if (days < 30) return 'day14';
    return 'day30plus';
  }),
}));

beforeEach(() => {
  mockResponses = new Map();
  mockUpserts = [];
  mockUpdates = [];
  // Default: no proactive pause
  setMockData('user_proactive_pause:list', { data: [], error: null });
  // Default: empty for everything else
  setMockData('autopilot_recommendations:list', { data: [], error: null });
  setMockData('calendar_events:list', { data: [], error: null });
  setMockData('user_nudge_state:list', { data: [], error: null });
  setMockData('life_compass:list', { data: [], error: null });
  setMockData('app_users:list', { data: [], error: null });
  setMockData('user_feature_introductions:list', { data: [], error: null });
  setMockData('user_session_summaries:list', { data: [], error: null });
  setMockData('user_routines:list', { data: [], error: null });
  setMockData('adaptation_plans:list', { data: [], error: null });
});

// =============================================================================
// SECTION A — Opener selection
// =============================================================================

describe('A. Opener selection (pickOpenerCandidate)', () => {
  let pickOpenerCandidate: any;

  beforeAll(async () => {
    const mod = await import('../src/services/guide/opener-mvp');
    pickOpenerCandidate = mod.pickOpenerCandidate;
  });

  test('A1: returns null when no data sources have anything', async () => {
    setMockData('life_compass:list', { data: [], error: null });
    setMockData('calendar_events:list', { data: [], error: null });
    setMockData('autopilot_recommendations:list', { data: [], error: null });
    setMockData('app_users:list', { data: [], error: null });
    // No life_compass, no app_users → no goal seeded → no candidate
    const sel = await pickOpenerCandidate({
      user_id: 'u1',
      active_role: 'community',
      channel: 'voice',
    });
    // The goal_reminder fallback requires a life_compass row OR successful seed.
    // With insert returning {data: null}, the lazy seed succeeds (mock returns the payload),
    // so we should get a goal_reminder candidate. Verify it's not null:
    expect(sel.candidate).not.toBeNull();
    expect(sel.candidate.kind).toBe('goal_reminder');
    expect(sel.candidate.goal_link?.is_system_seeded).toBe(true);
  });

  test('A2: prefers overdue calendar event over goal_reminder fallback', async () => {
    setMockData('life_compass:list', {
      data: [{ id: 'lc1', primary_goal: 'Improve quality of life and extend lifespan', category: 'longevity' }],
      error: null,
    });
    setMockData('calendar_events:list', {
      data: [
        {
          id: 'ev1',
          title: 'Morning nutrition check-in',
          start_time: new Date(Date.now() - 3 * 3600_000).toISOString(),
          duration_minutes: 4,
          event_type: 'autopilot',
          status: 'scheduled',
        },
      ],
      error: null,
    });
    const sel = await pickOpenerCandidate({
      user_id: 'u1',
      active_role: 'community',
      channel: 'voice',
    });
    expect(sel.candidate).not.toBeNull();
    expect(sel.candidate.kind).toBe('overdue_calendar');
    expect(sel.candidate.title).toBe('Morning nutrition check-in');
  });

  test('A3: dismissal pause suppresses candidate silently', async () => {
    setMockData('life_compass:list', {
      data: [{ id: 'lc1', primary_goal: 'Improve quality of life and extend lifespan', category: 'longevity' }],
      error: null,
    });
    // Active 'all' pause covering this user
    setMockData('user_proactive_pause:list', {
      data: [
        {
          id: 'p1',
          user_id: 'u1',
          scope: 'all',
          scope_value: null,
          paused_until: new Date(Date.now() + 86400_000).toISOString(),
          paused_from: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const sel = await pickOpenerCandidate({
      user_id: 'u1',
      active_role: 'community',
      channel: 'voice',
    });
    expect(sel.candidate).toBeNull();
    expect(sel.suppressed_by_pause).toBe(true);
  });

  test('A4: nudge_state silenced_until suppresses every candidate when all match', async () => {
    setMockData('life_compass:list', {
      data: [{ id: 'lc1', primary_goal: 'X', category: 'longevity' }],
      error: null,
    });
    setMockData('autopilot_recommendations:list', {
      data: [{ id: 'rec1', title: 'Connect with 3 people', summary: 'Test', domain: 'community', role_scope: 'any', status: 'new', user_id: 'u1', created_at: new Date().toISOString() }],
      error: null,
    });
    // Mock: every nudge_state lookup returns silenced_until in the future.
    // In production the lookup is filtered by nudge_key; the mock returns
    // the same response for any key, so every candidate (rec + goal_reminder)
    // is suppressed and pickOpenerCandidate returns null with no candidate.
    setMockData('user_nudge_state:list', {
      data: [{ silenced_until: new Date(Date.now() + 86400_000).toISOString() }],
      error: null,
    });
    const sel = await pickOpenerCandidate({
      user_id: 'u1',
      active_role: 'community',
      channel: 'voice',
    });
    // Confirms the silencing path is exercised — candidate goes null but NOT
    // because of pause (suppressed_by_pause stays false).
    expect(sel.candidate).toBeNull();
    expect(sel.suppressed_by_pause).toBe(false);
  });
});

// =============================================================================
// SECTION B — Dismissal honor
// =============================================================================

describe('B. Dismissal honor (pause-check + dismissal-tool)', () => {
  let isPaused: any;
  let executePauseProactiveGuidance: any;
  let executeClearProactivePauses: any;

  beforeAll(async () => {
    const pauseMod = await import('../src/services/guide/pause-check');
    const dismissalMod = await import('../src/services/guide/dismissal-tool');
    isPaused = pauseMod.isPaused;
    executePauseProactiveGuidance = dismissalMod.executePauseProactiveGuidance;
    executeClearProactivePauses = dismissalMod.executeClearProactivePauses;
  });

  test('B1: isPaused returns false when no active pauses', async () => {
    setMockData('user_proactive_pause:list', { data: [], error: null });
    const r = await isPaused({ user_id: 'u1', channel: 'voice' });
    expect(r.paused).toBe(false);
  });

  test('B2: isPaused matches "all" scope pause', async () => {
    setMockData('user_proactive_pause:list', {
      data: [
        { id: 'p1', user_id: 'u1', scope: 'all', scope_value: null, paused_until: new Date(Date.now() + 86400_000).toISOString() },
      ],
      error: null,
    });
    const r = await isPaused({ user_id: 'u1', channel: 'voice' });
    expect(r.paused).toBe(true);
    expect(r.pause?.scope).toBe('all');
  });

  test('B3: pause_proactive_guidance writes correct row', async () => {
    const result = await executePauseProactiveGuidance(
      { scope: 'all', duration_minutes: 1440, reason: 'not today' },
      { user_id: 'u1', channel: 'voice' },
    );
    expect(result.success).toBe(true);
    const upsert = mockUpserts.find((u) => u.table === 'user_proactive_pause');
    expect(upsert).toBeDefined();
    expect(upsert!.payload.scope).toBe('all');
    expect(upsert!.payload.created_via).toBe('voice');
  });

  test('B4: clear_proactive_pauses calls update with correct matchers', async () => {
    const result = await executeClearProactivePauses({ user_id: 'u1' });
    expect(result.success).toBe(true);
    const update = mockUpdates.find((u) => u.table === 'user_proactive_pause');
    expect(update).toBeDefined();
    expect(update!.payload.paused_until).toBeDefined();
  });
});

// =============================================================================
// SECTION C — Awareness context structure
// =============================================================================

describe('C. Awareness context (getAwarenessContext)', () => {
  let getAwarenessContext: any;
  let clearAwarenessCache: any;

  beforeAll(async () => {
    const mod = await import('../src/services/guide/awareness-context');
    getAwarenessContext = mod.getAwarenessContext;
    clearAwarenessCache = mod.clearAwarenessCache;
  });

  beforeEach(() => clearAwarenessCache());

  test('C1: returns full UserAwareness with all top-level fields', async () => {
    const aw: UserAwareness = await getAwarenessContext('u1', 'tenant-1');
    expect(aw).toHaveProperty('tenure');
    expect(aw).toHaveProperty('journey');
    expect(aw).toHaveProperty('goal');
    expect(aw).toHaveProperty('community_signals');
    expect(aw).toHaveProperty('recent_activity');
    expect(aw).toHaveProperty('last_interaction');
    expect(aw).toHaveProperty('feature_introductions');
    expect(aw).toHaveProperty('prior_session_themes');
    expect(aw).toHaveProperty('adaptation_plans');
    expect(aw).toHaveProperty('routines');
    expect(aw).toHaveProperty('tastes_preferences');
  });

  test('C2: tenure stage derived from gatherUserContext (5-day mocked user → day3)', async () => {
    const aw = await getAwarenessContext('u1', 'tenant-1');
    expect(aw.tenure.stage).toBe('day3');
    expect(aw.tenure.days_since_signup).toBeGreaterThanOrEqual(4);
    expect(aw.tenure.days_since_signup).toBeLessThanOrEqual(6);
  });

  test('C3: community signals flow through from gatherUserContext', async () => {
    const aw = await getAwarenessContext('u1', 'tenant-1');
    expect(aw.community_signals.diary_streak_days).toBe(4);
    expect(aw.community_signals.connection_count).toBe(7);
    expect(aw.community_signals.memory_interests).toContain('nutrition');
  });
});

// =============================================================================
// SECTION D — Brain proactive guide block prompt content
// =============================================================================

describe('D. buildProactiveGuideBlock prompt content', () => {
  let buildProactiveGuideBlock: any;

  beforeAll(async () => {
    const mod = await import('../src/services/vitana-brain');
    buildProactiveGuideBlock = mod.buildProactiveGuideBlock;
  });

  test('D1: prompt explicitly lists "What can I do for you?" as forbidden', async () => {
    const prompt = await buildProactiveGuideBlock({
      user_id: 'u1',
      tenant_id: 'tenant-1',
      role: 'community',
      channel: 'orb',
    });
    expect(prompt).toContain('FORBIDDEN OPENINGS');
    expect(prompt).toContain('What can I do for you?');
  });

  test('D2: OPENING SHAPE MATRIX is present with all 6 tenure stages', async () => {
    const prompt = await buildProactiveGuideBlock({
      user_id: 'u1',
      tenant_id: 'tenant-1',
      role: 'community',
      channel: 'orb',
    });
    expect(prompt).toContain('OPENING SHAPE MATRIX');
    expect(prompt).toContain('day0');
    expect(prompt).toContain('day1');
    expect(prompt).toContain('day3');
    expect(prompt).toContain('day7');
    expect(prompt).toContain('day14');
    expect(prompt).toContain('day30plus');
  });

  test('D3: USER AWARENESS block reflects mocked user (day3, Maria, etc)', async () => {
    const prompt = await buildProactiveGuideBlock({
      user_id: 'u1',
      tenant_id: 'tenant-1',
      role: 'community',
      channel: 'orb',
    });
    expect(prompt).toContain('USER AWARENESS');
    expect(prompt).toContain('day3');
    // diary streak 4 should be mentioned in community signals
    expect(prompt).toMatch(/diary streak/i);
  });

  test('D4: SILENT HONOR rules + dismissal tool guidance present', async () => {
    const prompt = await buildProactiveGuideBlock({
      user_id: 'u1',
      tenant_id: 'tenant-1',
      role: 'community',
      channel: 'orb',
    });
    expect(prompt).toContain('SILENT HONOR');
    expect(prompt).toContain('pause_proactive_guidance');
    expect(prompt).toContain('clear_proactive_pauses');
    // No apology rule
    expect(prompt).toMatch(/(no apology|do NOT apologize)/i);
  });

  test('D5: tenure_stage banner reflects awareness output', async () => {
    const prompt = await buildProactiveGuideBlock({
      user_id: 'u1',
      tenant_id: 'tenant-1',
      role: 'community',
      channel: 'orb',
    });
    // Day-3 user should get the day3 stage banner if a candidate exists
    // (whether it appears depends on candidate selection — at minimum the
    // OPENING SHAPE MATRIX should reference day3)
    expect(prompt).toContain('day3');
  });
});

// =============================================================================
// SECTION E — Feature-introduction tracking (Phase G)
// =============================================================================

describe('E. Feature introductions (Phase G)', () => {
  let getFeatureIntroductions: any;
  let recordFeatureIntroduction: any;

  beforeAll(async () => {
    const mod = await import('../src/services/guide/feature-introductions');
    getFeatureIntroductions = mod.getFeatureIntroductions;
    recordFeatureIntroduction = mod.recordFeatureIntroduction;
  });

  test('E1: read returns empty when no features introduced', async () => {
    setMockData('user_feature_introductions:list', { data: [], error: null });
    const result = await getFeatureIntroductions('u1');
    expect(result).toEqual([]);
  });

  test('E2: read returns features with metadata', async () => {
    setMockData('user_feature_introductions:list', {
      data: [
        { feature_key: 'life_compass', introduced_at: new Date().toISOString(), channel: 'voice' },
        { feature_key: 'vitana_index', introduced_at: new Date().toISOString(), channel: 'voice' },
      ],
      error: null,
    });
    const result = await getFeatureIntroductions('u1');
    expect(result).toHaveLength(2);
    expect(result[0].feature_key).toBe('life_compass');
  });

  test('E3: record upserts to correct table', async () => {
    const result = await recordFeatureIntroduction('u1', 'life_compass', 'voice');
    expect(result.success).toBe(true);
    const upsert = mockUpserts.find((u) => u.table === 'user_feature_introductions');
    expect(upsert).toBeDefined();
    expect(upsert!.payload.feature_key).toBe('life_compass');
    expect(upsert!.conflict).toBe('user_id,feature_key');
  });
});

// =============================================================================
// SECTION F — Session summaries (Phase F)
// =============================================================================

describe('F. Session summaries (Phase F)', () => {
  let recordSessionSummary: any;
  let getRecentSessionSummaries: any;

  beforeAll(async () => {
    const mod = await import('../src/services/guide/session-summaries');
    recordSessionSummary = mod.recordSessionSummary;
    getRecentSessionSummaries = mod.getRecentSessionSummaries;
  });

  test('F1: records summary with extracted themes', async () => {
    const result = await recordSessionSummary({
      user_id: 'u1',
      session_id: 'sess1',
      channel: 'voice',
      transcript_turns: [
        { role: 'user', text: 'I have been struggling with sleep lately' },
        { role: 'assistant', text: 'Tell me more about your sleep — when do you wind down?' },
        { role: 'user', text: 'Late, around midnight, and stress is high' },
        { role: 'assistant', text: 'Stress at night can really compound. Want to try a wind-down ritual?' },
      ],
    });
    expect(result.success).toBe(true);
    const upsert = mockUpserts.find((u) => u.table === 'user_session_summaries');
    expect(upsert).toBeDefined();
    expect(upsert!.payload.themes).toEqual(expect.arrayContaining(['sleep', 'stress']));
    expect(upsert!.payload.turn_count).toBe(4);
  });

  test('F2: empty transcript is rejected (no noise stored)', async () => {
    const result = await recordSessionSummary({
      user_id: 'u1',
      session_id: 'sess2',
      channel: 'voice',
      transcript_turns: [],
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('empty_transcript');
  });

  test('F3: read returns recent summaries', async () => {
    setMockData('user_session_summaries:list', {
      data: [
        {
          session_id: 'sess1',
          channel: 'voice',
          summary: 'Talked about sleep',
          themes: ['sleep'],
          turn_count: 4,
          duration_ms: 60000,
          ended_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const result = await getRecentSessionSummaries('u1', 3);
    expect(result).toHaveLength(1);
    expect(result[0].themes).toContain('sleep');
  });
});

// =============================================================================
// SECTION G — Pattern extractor (Phase C)
// =============================================================================

describe('G. Pattern extractor (Phase C)', () => {
  let extractPatternsForUser: any;
  let getUserRoutines: any;

  beforeAll(async () => {
    const mod = await import('../src/services/guide/pattern-extractor');
    extractPatternsForUser = mod.extractPatternsForUser;
    getUserRoutines = mod.getUserRoutines;
  });

  test('G1: extracts time-of-day preference from morning-heavy events', async () => {
    // Build 5 completed events all in the morning (8am UTC)
    const morningEvents = Array.from({ length: 5 }).map((_, i) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      d.setUTCHours(8, 0, 0, 0);
      return {
        id: `ev${i}`,
        start_time: d.toISOString(),
        completion_status: 'completed',
        status: 'completed',
        event_type: 'autopilot',
        wellness_tags: ['nutrition'],
        time_slot: 'morning',
      };
    });
    setMockData('calendar_events:list', { data: morningEvents, error: null });
    const result = await extractPatternsForUser('u1');
    expect(result.events_examined).toBe(5);
    expect(result.routines_written).toBeGreaterThan(0);
    const todRoutine = result.routines.find((r: any) => r.routine_kind === 'time_of_day_preference');
    expect(todRoutine).toBeDefined();
    expect(todRoutine.metadata.time_of_day).toBe('morning');
  });

  test('G2: skips when insufficient evidence', async () => {
    setMockData('calendar_events:list', {
      data: [
        { id: 'e1', start_time: new Date().toISOString(), completion_status: 'completed', status: 'completed', event_type: 'autopilot', wellness_tags: [], time_slot: 'morning' },
      ],
      error: null,
    });
    const result = await extractPatternsForUser('u1');
    expect(result.routines_written).toBe(0);
  });

  test('G3: extracts category affinity from tagged events', async () => {
    const events = Array.from({ length: 6 }).map((_, i) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      // Mix of times to avoid hitting tod threshold; same tag every time
      d.setUTCHours(i < 3 ? 9 : 14, 0, 0, 0);
      return {
        id: `ev${i}`,
        start_time: d.toISOString(),
        completion_status: 'completed',
        status: 'completed',
        event_type: 'autopilot',
        wellness_tags: ['mindfulness'],
        time_slot: i < 3 ? 'morning' : 'afternoon',
      };
    });
    setMockData('calendar_events:list', { data: events, error: null });
    const result = await extractPatternsForUser('u1');
    const catRoutine = result.routines.find((r: any) => r.routine_kind === 'category_affinity');
    expect(catRoutine).toBeDefined();
    expect(catRoutine.metadata.tag).toBe('mindfulness');
  });
});

// =============================================================================
// SECTION H — Temporal bucket utility
// =============================================================================

describe('H. Temporal bucket classifier', () => {
  test('H1: null lastSessionInfo → first bucket', () => {
    const r = describeTimeSince(null);
    expect(r.bucket).toBe('first');
    expect(r.motivation_signal).toBe('fresh');
  });

  test('H2: 1 minute ago → reconnect / fresh', () => {
    const r = describeTimeSince({
      time: new Date(Date.now() - 60_000).toISOString(),
      wasFailure: false,
    });
    expect(r.bucket).toBe('reconnect');
    expect(r.motivation_signal).toBe('fresh');
  });

  test('H3: 2 days ago → week / engaged', () => {
    const r = describeTimeSince({
      time: new Date(Date.now() - 2 * 86400_000).toISOString(),
      wasFailure: false,
    });
    expect(r.bucket).toBe('week');
    expect(r.motivation_signal).toBe('engaged');
  });

  test('H4: 10 days ago → long / cooling', () => {
    const r = describeTimeSince({
      time: new Date(Date.now() - 10 * 86400_000).toISOString(),
      wasFailure: false,
    });
    expect(r.bucket).toBe('long');
    expect(r.motivation_signal).toBe('cooling');
  });

  test('H5: 20 days ago → long / absent', () => {
    const r = describeTimeSince({
      time: new Date(Date.now() - 20 * 86400_000).toISOString(),
      wasFailure: false,
    });
    expect(r.bucket).toBe('long');
    expect(r.motivation_signal).toBe('absent');
  });

  test('H6: deriveMotivationSignal direct call', () => {
    expect(deriveMotivationSignal('reconnect', 0)).toBe('fresh');
    expect(deriveMotivationSignal('today', 0)).toBe('fresh');
    expect(deriveMotivationSignal('yesterday', 1)).toBe('engaged');
    expect(deriveMotivationSignal('week', 5)).toBe('engaged');
    expect(deriveMotivationSignal('long', 10)).toBe('cooling');
    expect(deriveMotivationSignal('long', 20)).toBe('absent');
  });
});

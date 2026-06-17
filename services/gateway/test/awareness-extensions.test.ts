/**
 * Journey Conversation V2 — awareness extension builder tests (spec §3, §18).
 *
 * Verifies the extension builds correctly from the canonical tables, that
 * the system-seeded Life Compass does NOT count as user-defined, that a
 * mature user with no V2 data is classified returning_low_data (not
 * first_time), and that every fetcher fails open.
 */

jest.mock('../src/services/user-context-profiler', () => ({
  fetchVitanaIndexForProfiler: jest.fn(async () => ({ total: 42, tier: 'bronze' })),
}));

import { buildJourneyV2Awareness } from '../src/services/guide/awareness-extensions';
import { fetchVitanaIndexForProfiler } from '../src/services/user-context-profiler';

type TableConfig = {
  rows?: any[];
  count?: number;
  error?: { message: string } | null;
};

let tables: Record<string, TableConfig>;

function tableMock(cfg: TableConfig) {
  const res = {
    data: cfg.error ? null : cfg.rows ?? [],
    error: cfg.error ?? null,
    count: cfg.error ? null : cfg.count ?? (cfg.rows ?? []).length,
  };
  const b: any = {};
  for (const m of ['select', 'eq', 'gt', 'lt', 'gte', 'in', 'order']) {
    b[m] = jest.fn(() => b);
  }
  b.limit = jest.fn(() => Promise.resolve(res));
  b.maybeSingle = jest.fn(() =>
    Promise.resolve({ data: (cfg.rows ?? [])[0] ?? null, error: cfg.error ?? null }),
  );
  b.then = (onF: any, onR: any) => Promise.resolve(res).then(onF, onR);
  return b;
}

const supabase: any = {
  from: (table: string) => tableMock(tables[table] ?? { rows: [] }),
};

const baseSignals = {
  days_since_signup: 14,
  active_usage_days: 10,
  diary_streak_days: 3,
  connection_count: 2,
  group_count: 1,
  goal: { is_system_seeded: false },
};

beforeEach(() => {
  jest.clearAllMocks();
  tables = {
    user_guided_journey_state: {
      rows: [
        {
          mode: 'guided',
          onboarding_status: 'in_progress',
          current_session: 4,
          completed_topic_ids: ['t-001', 't-002', 't-003'],
          last_opened_topic_id: 't-003',
        },
      ],
    },
    journey_checklist_topics: {
      rows: [
        { topic_id: 't-003', session: 4, position: 1 },
        { topic_id: 't-004', session: 4, position: 2 },
        { topic_id: 't-005', session: 5, position: 1 },
      ],
    },
    user_journey: {
      rows: [{ recent_greeting_openings: ['Guten Morgen, Anna!'] }],
    },
    app_users: {
      rows: [
        {
          first_name: 'Anna',
          last_name: 'Muster',
          date_of_birth: '1969-09-09',
          gender: 'female',
          city: 'Berlin',
          country: 'DE',
          avatar_url: null,
        },
      ],
    },
    autopilot_recommendations: { rows: [], count: 2 },
    user_proactive_pause: {
      rows: [
        { scope: 'category', scope_value: 'autopilot', paused_until: '2099-01-01T00:00:00Z' },
        { scope: 'nudge_key', scope_value: 'diary_today:2026-06-12', paused_until: '2099-01-01T00:00:00Z' },
      ],
    },
    memory_diary_entries: { rows: [], count: 1 },
  };
});

describe('buildJourneyV2Awareness', () => {
  it('builds the full extension from the canonical tables', async () => {
    const v2 = await buildJourneyV2Awareness('user-1', supabase, baseSignals);

    expect(v2.extended_tenure_stage).toBe('day14');
    expect(v2.journey_progress).toEqual({
      mode: 'guided',
      onboarding_status: 'in_progress',
      current_session: 4,
      completed_topic_count: 3,
      last_opened_topic_id: 't-003',
      // t-003 is completed → next is t-004 (session 4, position 2)
      next_recommended_topic_id: 't-004',
      next_recommended_session: 4,
    });
    expect(v2.profile_completion_status).toEqual({
      first_name: true,
      last_name: true,
      birthday: true,
      profile_picture: false,
      gender: true,
      location: true,
      completion_percent: 83,
    });
    expect(v2.completed_priority_tasks).toEqual({
      life_compass_defined: true,
      profile_completed: false,
      diary_started: true,
      autopilot_used: true,
    });
    expect(v2.diary_entry_today).toBe(true);
    expect(v2.proactive_pause_state).toEqual({
      paused_all: false,
      paused_categories: ['autopilot'],
      paused_nudge_keys: ['diary_today:2026-06-12'],
    });
    expect(v2.recent_greeting_openings).toEqual(['Guten Morgen, Anna!']);
    expect(v2.autopilot_activations_lifetime).toBe(2);
    expect(v2.vitana_index_maturity).not.toBe('none');
  });

  it('system-seeded Life Compass does NOT count as user-defined', async () => {
    const v2 = await buildJourneyV2Awareness('user-1', supabase, {
      ...baseSignals,
      goal: { is_system_seeded: true },
    });
    expect(v2.completed_priority_tasks.life_compass_defined).toBe(false);
  });

  it('mature user with NO v2 data → returning_low_data, never first_time', async () => {
    tables = {}; // every table empty / missing
    (fetchVitanaIndexForProfiler as jest.Mock).mockResolvedValue(null);
    const v2 = await buildJourneyV2Awareness('user-old', supabase, {
      days_since_signup: 200,
      active_usage_days: 0,
      diary_streak_days: 0,
      connection_count: 0,
      group_count: 0,
      goal: null,
    });
    expect(v2.experience_level).toBe('returning_low_data');
    expect(v2.experience_level).not.toBe('first_time');
    expect(v2.extended_tenure_stage).toBe('day180plus');
    expect(v2.journey_progress).toBeNull();
    expect(v2.vitana_index_maturity).toBe('none');
  });

  it('fails open on table errors — safe defaults, no throw', async () => {
    for (const t of Object.keys(tables)) {
      tables[t] = { error: { message: 'boom' } };
    }
    (fetchVitanaIndexForProfiler as jest.Mock).mockRejectedValue(new Error('boom'));
    const v2 = await buildJourneyV2Awareness('user-1', supabase, baseSignals);
    expect(v2.journey_progress).toBeNull();
    expect(v2.profile_completion_status.completion_percent).toBe(0);
    expect(v2.proactive_pause_state.paused_all).toBe(false);
    expect(v2.autopilot_activations_lifetime).toBe(0);
    expect(v2.diary_entry_today).toBe(false);
  });

  it('a true first-time user is classified first_time', async () => {
    tables = {};
    (fetchVitanaIndexForProfiler as jest.Mock).mockResolvedValue(null);
    const v2 = await buildJourneyV2Awareness('user-new', supabase, {
      days_since_signup: 0,
      active_usage_days: 0,
      diary_streak_days: 0,
      connection_count: 0,
      group_count: 0,
      goal: null,
    });
    expect(v2.experience_level).toBe('first_time');
  });
});

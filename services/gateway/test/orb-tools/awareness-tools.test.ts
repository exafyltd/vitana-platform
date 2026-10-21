/**
 * Awareness-signal voice tools (VTID-02778) — unit tests.
 *
 * The three deterministic dimension engines (D32/D33/D34) are mocked — their
 * logic is owned and tested by their own modules; here we assert the handlers
 * feed them real inputs (calendar hints, time context, residence seed) and
 * turn their bundles into speakable text. Table-backed reads (D28 signals,
 * diary fallback, D40 assessment/compass/tenure/birthday, calendar_events,
 * reminders) run against a chainable mocked SupabaseClient.
 *
 * Covered per tool: happy path (ok:true + speakable text with the actual
 * content), unauthenticated gate, and the honest empty-state paths.
 */

jest.mock('../../src/services/d32-situational-awareness-engine', () => ({
  computeSituationalAwareness: jest.fn(),
  toOrbSituationContext: jest.fn(),
}));
jest.mock('../../src/services/d33-availability-readiness-engine', () => ({
  computeAvailabilityReadiness: jest.fn(),
  getCurrentAvailability: jest.fn(),
}));
jest.mock('../../src/services/d34-environmental-mobility-engine', () => ({
  computeContext: jest.fn(),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeSituationalAwareness,
  toOrbSituationContext,
} from '../../src/services/d32-situational-awareness-engine';
import {
  computeAvailabilityReadiness,
  getCurrentAvailability,
} from '../../src/services/d33-availability-readiness-engine';
import { computeContext } from '../../src/services/d34-environmental-mobility-engine';
import {
  AWARENESS_TOOL_HANDLERS,
  AWARENESS_TOOL_DECLARATIONS,
  tool_get_emotional_state,
  tool_get_situational_awareness,
  tool_get_availability,
  tool_get_environmental_context,
  tool_get_life_stage_context,
} from '../../src/services/orb-tools/awareness-tools';

const IDENT = {
  user_id: 'u-1',
  tenant_id: 't-1',
  role: 'community',
  session_id: 's-1',
};
const ANON = { user_id: '', tenant_id: null, role: null };

type TableSpec = unknown[] | { error: string };

/** Chainable SupabaseClient mock: every table resolves its configured rows. */
function makeSb(tables: Record<string, TableSpec> = {}): SupabaseClient {
  const from = (table: string) => {
    const spec = tables[table];
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'is', 'not', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'limit']) {
      builder[m] = jest.fn(() => builder);
    }
    const resolve = () =>
      spec && !Array.isArray(spec)
        ? Promise.resolve({ data: null, error: { message: spec.error } })
        : Promise.resolve({ data: spec ?? [], error: null });
    builder.maybeSingle = jest.fn(async () => {
      const r = await resolve();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    });
    (builder as { then?: unknown }).then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
      resolve().then(onF, onR);
    return builder;
  };
  return { from: jest.fn(from) } as unknown as SupabaseClient;
}

const futureIso = (mins: number) => new Date(Date.now() + mins * 60000).toISOString();
const pastIso = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  (getCurrentAvailability as jest.Mock).mockResolvedValue({ ok: true, cached: false });
});

// ---------------------------------------------------------------------------
// Exports / declarations shape
// ---------------------------------------------------------------------------

const NAMES = [
  'get_emotional_state',
  'get_situational_awareness',
  'get_availability',
  'get_environmental_context',
  'get_life_stage_context',
];

describe('awareness tools — exports', () => {
  it.each(NAMES)('%s is in AWARENESS_TOOL_HANDLERS', (name) => {
    expect(typeof AWARENESS_TOOL_HANDLERS[name]).toBe('function');
  });

  it.each(NAMES)('%s is declared in AWARENESS_TOOL_DECLARATIONS', (name) => {
    expect(AWARENESS_TOOL_DECLARATIONS.find((d) => d.name === name)).toBeDefined();
  });

  it('declarations use only the Vertex-safe OpenAPI subset (no default/minimum/maximum/format/examples)', () => {
    const raw = JSON.stringify(AWARENESS_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
      expect(raw).not.toContain(banned);
    }
  });

  it.each(NAMES)('%s rejects unauthenticated identities', async (name) => {
    const res = await AWARENESS_TOOL_HANDLERS[name]({}, ANON as never, makeSb());
    expect(res).toEqual({ ok: false, error: `${name} requires an authenticated user.` });
  });
});

// ---------------------------------------------------------------------------
// get_emotional_state (D28)
// ---------------------------------------------------------------------------

describe('get_emotional_state', () => {
  it('speaks the latest fresh D28 signal bundle', async () => {
    const sb = makeSb({
      emotional_cognitive_signals: [
        {
          emotional_states: [
            { state: 'calm', score: 70, confidence: 80 },
            { state: 'neutral', score: 40, confidence: 50 },
          ],
          cognitive_states: [{ state: 'focused', score: 65, confidence: 75 }],
          engagement_level: 'high',
          engagement_confidence: 80,
          urgency_detected: false,
          hesitation_detected: true,
          created_at: pastIso(20),
          decay_at: futureIso(40),
        },
      ],
    });
    const res = await tool_get_emotional_state({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('calm');
    expect(res.text).toContain('focused');
    expect(res.text).toContain('high engagement');
    expect(res.text).toContain('hesitation');
    expect(res.text).toContain('not a clinical assessment');
    expect((res.result as { source: string }).source).toBe('conversation_signals');
  });

  it('falls back to recent diary moods when no live signal exists', async () => {
    const sb = makeSb({
      emotional_cognitive_signals: [],
      memory_diary_entries: [
        { mood: 'optimistic', energy_level: 7, entry_date: '2026-07-05' },
        { mood: 'tired', energy_level: 5, entry_date: '2026-07-03' },
      ],
    });
    const res = await tool_get_emotional_state({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('optimistic');
    expect(res.text).toContain('diary');
    expect(res.text).toContain('6 out of 10');
    expect((res.result as { source: string }).source).toBe('diary');
  });

  it('returns an honest ok:true empty state when neither source has data', async () => {
    const sb = makeSb({ emotional_cognitive_signals: [], memory_diary_entries: [] });
    const res = await tool_get_emotional_state({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no data yet');
    expect((res.result as { source: string }).source).toBe('none');
  });

  it('returns ok:false when the signals query errors', async () => {
    const sb = makeSb({ emotional_cognitive_signals: { error: 'boom' } });
    const res = await tool_get_emotional_state({}, IDENT as never, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_situational_awareness (D32)
// ---------------------------------------------------------------------------

describe('get_situational_awareness', () => {
  it('computes the D32 bundle with calendar hints and speaks the situation', async () => {
    (computeSituationalAwareness as jest.Mock).mockResolvedValue({
      ok: true,
      bundle: { bundle_id: 'sa_1' },
    });
    (toOrbSituationContext as jest.Mock).mockReturnValue({
      time_window: 'evening',
      is_late_night: false,
      availability: 'medium',
      energy: 'moderate',
      active_tags: [],
      active_constraints: ['time_limited'],
      suggested_depth: 'light',
      confidence: 72,
      disclaimer: 'd',
    });
    const sb = makeSb({
      reminders: [{ user_tz: 'Europe/Berlin' }],
      calendar_events: [
        { id: 'e1', title: 'Yoga class', start_time: futureIso(45), end_time: futureIso(105), event_type: 'wellness' },
      ],
    });

    const res = await tool_get_situational_awareness({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('evening');
    expect(res.text).toContain('medium');
    expect(res.text).toContain('Yoga class');
    expect(res.text).toContain('time limited');
    expect(res.text).toContain('72% confidence');

    const input = (computeSituationalAwareness as jest.Mock).mock.calls[0][0];
    expect(input.user_id).toBe('u-1');
    expect(input.tenant_id).toBe('t-1');
    expect(input.timezone).toBe('Europe/Berlin');
    expect(input.calendar_hints.next_event_in_minutes).toBeGreaterThanOrEqual(44);
    expect(input.calendar_hints.is_free_now).toBe(true);
  });

  it('propagates engine failure as ok:false', async () => {
    (computeSituationalAwareness as jest.Mock).mockResolvedValue({ ok: false, error: 'engine down' });
    const res = await tool_get_situational_awareness({}, IDENT as never, makeSb());
    expect(res).toEqual({ ok: false, error: 'engine down' });
  });
});

// ---------------------------------------------------------------------------
// get_availability (D33)
// ---------------------------------------------------------------------------

const d33Bundle = {
  availability: { level: 'medium', confidence: 70, factors: [] },
  time_window: { window: 'short', confidence: 80, estimated_minutes: 8, factors: [] },
  readiness: { score: 0.62, confidence: 70, factors: [], risk_flags: [] },
  action_depth: { max_steps: 2, max_questions: 1, max_recommendations: 1, allow_booking: false, allow_payment: false },
  availability_tag: 'light_flow_ok',
  computed_at: new Date().toISOString(),
  was_user_override: false,
  disclaimer: 'd',
};

describe('get_availability', () => {
  it('computes fresh availability with calendar density and reminders due', async () => {
    (computeAvailabilityReadiness as jest.Mock).mockResolvedValue({ ok: true, bundle: d33Bundle });
    const sb = makeSb({
      calendar_events: [
        { id: 'e1', title: 'Team standup', start_time: futureIso(25), end_time: futureIso(55), event_type: 'meeting' },
      ],
      reminders: [{ action_text: 'Drink water', next_fire_at: futureIso(30), user_tz: 'Europe/Berlin' }],
    });

    const res = await tool_get_availability({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('medium');
    expect(res.text).toContain('62%');
    expect(res.text).toContain('Team standup');
    expect(res.text).toContain('Drink water');
    expect(res.text).toContain('Based on');

    const input = (computeAvailabilityReadiness as jest.Mock).mock.calls[0][0];
    expect(input.calendar.has_upcoming_event).toBe(true);
    expect(input.calendar.is_in_meeting).toBe(false);
    expect(typeof input.time_context.current_hour).toBe('number');
  });

  it('prefers the cached in-session D33 bundle when present', async () => {
    (getCurrentAvailability as jest.Mock).mockResolvedValue({ ok: true, cached: true, bundle: d33Bundle });
    const sb = makeSb({ calendar_events: [], reminders: [] });
    const res = await tool_get_availability({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(computeAvailabilityReadiness).not.toHaveBeenCalled();
    expect(res.text).toContain('this session');
    expect(res.text).toContain('clear for the next 12 hours');
  });

  it('detects an in-progress calendar event', async () => {
    (computeAvailabilityReadiness as jest.Mock).mockResolvedValue({ ok: true, bundle: d33Bundle });
    const sb = makeSb({
      calendar_events: [
        { id: 'e0', title: 'Deep work block', start_time: pastIso(30), end_time: futureIso(30), event_type: 'focus' },
      ],
      reminders: [],
    });
    const res = await tool_get_availability({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Deep work block');
    const input = (computeAvailabilityReadiness as jest.Mock).mock.calls[0][0];
    expect(input.calendar.is_in_meeting).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get_environmental_context (D34)
// ---------------------------------------------------------------------------

const d34Bundle = (overrides: Record<string, unknown> = {}) => ({
  bundle_id: 'b-1',
  bundle_hash: 'h',
  computed_at: new Date().toISOString(),
  location_context: {
    city: 'Cologne',
    region: null,
    country: 'Germany',
    timezone: 'Europe/Berlin',
    travel_state: 'home',
    urban_density: 'urban',
    precision: 'city',
    confidence: 90,
    resolved_at: new Date().toISOString(),
    source: 'explicit',
  },
  mobility_profile: {
    mode_preference: 'walking',
    distance_tolerance: 'local',
    access_level: 'unknown',
    confidence: 50,
    inferred_from: [],
  },
  environmental_constraints: {
    flags: [],
    time_of_day_safety: 'safe',
    weather_suitability: 'unknown',
    indoor_outdoor_preference: 'either',
    is_late_night: false,
    is_early_morning: false,
    cultural_considerations: [],
    confidence: 60,
  },
  environment_tags: ['walkable'],
  overall_confidence: 66,
  data_freshness: 'fresh',
  sources_used: ['explicit_location'],
  fallback_applied: false,
  fallback_reason: null,
  disclaimer: 'd',
  ...overrides,
});

describe('get_environmental_context', () => {
  it('seeds the D34 engine with the stored residence fact and speaks the location', async () => {
    (computeContext as jest.Mock).mockResolvedValue({ ok: true, bundle: d34Bundle() });
    const sb = makeSb({ memory_facts: [{ fact_value: 'Cologne' }] });

    const res = await tool_get_environmental_context({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Cologne');
    expect(res.text).toContain('location you shared');
    expect(res.text).toContain('walking');
    expect(res.text).toContain('walkable');
    expect(res.text).toContain('66%');

    const req = (computeContext as jest.Mock).mock.calls[0][0];
    expect(req.explicit_location).toEqual({ city: 'Cologne' });
    expect(req.user_id).toBe('u-1');
  });

  it('says honestly when the bundle is a neutral default', async () => {
    (computeContext as jest.Mock).mockResolvedValue({
      ok: true,
      bundle: d34Bundle({
        location_context: {
          city: null,
          region: null,
          country: null,
          timezone: null,
          travel_state: 'unknown',
          urban_density: 'unknown',
          precision: 'unknown',
          confidence: 10,
          resolved_at: new Date().toISOString(),
          source: 'default',
        },
        mobility_profile: {
          mode_preference: 'unknown',
          distance_tolerance: 'local',
          access_level: 'unknown',
          confidence: 20,
          inferred_from: [],
        },
        environment_tags: [],
        fallback_applied: true,
        fallback_reason: 'No location or mobility data available',
      }),
    });
    const sb = makeSb({ memory_facts: [] });
    const res = await tool_get_environmental_context({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("don't have a location");
    expect(res.text).toContain('neutral default');
    const req = (computeContext as jest.Mock).mock.calls[0][0];
    expect(req.explicit_location).toBeUndefined();
  });

  it('propagates engine failure as ok:false', async () => {
    (computeContext as jest.Mock).mockResolvedValue({ ok: false, error: 'INTERNAL_ERROR', message: 'nope' });
    const res = await tool_get_environmental_context({}, IDENT as never, makeSb({ memory_facts: [] }));
    expect(res).toEqual({ ok: false, error: 'nope' });
  });
});

// ---------------------------------------------------------------------------
// get_life_stage_context (D40)
// ---------------------------------------------------------------------------

describe('get_life_stage_context', () => {
  it('speaks phase, compass goal, age band and tenure from the real tables', async () => {
    const sb = makeSb({
      life_stage_assessments: [
        {
          phase: 'optimizing',
          phase_confidence: 74,
          stability_level: 'high',
          transition_flag: false,
          transition_type: null,
        },
      ],
      life_stage_goals: [
        { category: 'health_longevity', description: 'Sleep 8 hours', priority: 8 },
      ],
      life_compass: [{ primary_goal: 'Run a marathon', category: 'longevity' }],
      app_users: [{ created_at: pastIso(60 * 24 * 240) }], // ~8 months
      memory_facts: [{ fact_value: '1969-09-09' }],
    });

    const res = await tool_get_life_stage_context({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('optimizing');
    expect(res.text).toContain('high stability');
    expect(res.text).toContain('Run a marathon');
    expect(res.text).toContain('fifties');
    expect(res.text).toContain('8 months');
    expect(res.text).toContain('you know your life best');
    const r = res.result as Record<string, unknown>;
    expect(r.phase).toBe('optimizing');
    expect(r.life_compass_goal).toBe('Run a marathon');
  });

  it('mentions an active transition when flagged', async () => {
    const sb = makeSb({
      life_stage_assessments: [
        {
          phase: 'transitioning',
          phase_confidence: 60,
          stability_level: 'medium',
          transition_flag: true,
          transition_type: 'new_city',
        },
      ],
      life_stage_goals: [],
      life_compass: [],
      app_users: [],
      memory_facts: [],
    });
    const res = await tool_get_life_stage_context({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('transition');
    expect(res.text).toContain('new city');
  });

  it('returns an honest ok:true empty state and offers Life Compass setup', async () => {
    const sb = makeSb({
      life_stage_assessments: [],
      life_stage_goals: [],
      life_compass: [],
      app_users: [],
      memory_facts: [],
    });
    const res = await tool_get_life_stage_context({}, IDENT as never, sb);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Life Compass');
    expect((res.result as { available: boolean }).available).toBe(false);
  });
});

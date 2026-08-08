// VTID-01126 — unit tests for the D32 Situational Awareness Engine
// (d32-situational-awareness-engine.ts). Pure/deterministic computation
// engine: no DB reads (getSupabaseClient()/DEV_IDENTITY are dead code in
// this file — grepped and confirmed unused outside their own definitions),
// one external side effect (OASIS event emission) and one external policy
// source (PolicyResolver, used only for the 5 time-of-day boundary hours).
//
// Scope:
//   1. Time context assembly — classifyTimeWindow boundaries (via the real
//      PolicyResolver cold-cache fallback AND a resolver-seeded override),
//      timezone confidence (70 UTC-default / 90 explicit-tz / 60 on an
//      Intl-throwing invalid timezone), is_late_night/is_early_morning/
//      is_likely_work_hours derivation.
//   2. Location context — no hints / is_home / is_traveling precedence.
//   3. Availability context — explicit_availability vs. calendar_hints,
//      the next_event_in_minutes tiering, and the no-data default.
//   4. Energy & readiness context — health_context thresholds, emotional/
//      cognitive signal adjustments, time-of-day fallback defaults.
//   5. Constraint flags — explicit, late-night, low-energy, health,
//      urgency, and scheduled-quiet-hours sources.
//   6. Overall confidence weighting + rounding.
//   7. Situation tag generation and action envelope construction — full
//      "everything allowed" and "everything blocked" golden scenarios,
//      independently hand-derived and cross-checked against the real
//      module before being hard-coded as expectations.
//   8. Bundle metadata: hash/determinism-key/input-hash generation,
//      `sources` flags, OASIS event emission (success/failure/low-energy
//      side event), graceful (never-throw) error handling.
//   9. scoreActions — per action-type scoring branches, late-night and
//      depleted-energy confidence degradation (and information's
//      exemption from it), reason defaulting.
//  10. overrideSituation — including a documented gap: `energy_level` is
//      accepted in the request type but never applied to the recomputed
//      vector.
//  11. ORB integration (getOrbSituationContext / processTurnForOrb) and
//      the verification helpers (verifyBundleIntegrity / verifyDeterminism).
//  12. Tenant/user isolation — bundle identity fields never cross between
//      concurrent calls for different tenants/users (CLAUDE.md ALWAYS #28 /
//      NEVER #7).
//
// A genuine bug was found and minimally fixed in the source: `computeSituat
// ionalAwareness` logged `input.user_id.substring(...)` BEFORE its own
// try/catch, so a malformed/missing user_id (a very plausible caller
// mistake) crashed the "never throws" function with an uncaught exception
// instead of returning `{ ok: false, error }` as documented and as its
// route-handler callers rely on. Fixed by guarding with `(input.user_id ||
// '')`. See the "never throws on malformed input" tests below, which would
// fail (reject instead of resolve) without the fix.

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import {
  computeSituationalAwareness,
  scoreActions,
  overrideSituation,
  getOrbSituationContext,
  processTurnForOrb,
  verifyBundleIntegrity,
  verifyDeterminism,
  VTID,
  ENGINE_VERSION,
  DEFAULT_SITUATIONAL_CONFIG,
} from '../../src/services/d32-situational-awareness-engine';
import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
} from '../../src/services/decision-contract/policy-resolver';
import { POLICY_KEYS } from '../../src/services/decision-contract/policy-keys';
import type { SituationalAwarenessInput } from '../../src/types/situational-awareness';

// Fixed, always-in-the-past ISO stamp for seeded policy rows — every test
// in this file freezes the clock to dates in 2026-07, so `effective_from`
// here must predate all of them or PolicyResolver's `isEffective()` check
// will reject the seeded row as "not yet effective".
const NOW_ISO = '2020-01-01T00:00:00.000Z';

function seedPolicy(key: string, value: unknown) {
  configurePolicyResolverForTests({
    decisionPolicy: [
      {
        policy_key: key,
        tenant_id: null,
        version: 1,
        value_json: value,
        effective_from: NOW_ISO,
        effective_until: null,
      },
    ],
  });
}

function setTime(iso: string) {
  jest.setSystemTime(new Date(iso));
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetPolicyResolverForTests();
  mockEmitOasisEvent.mockClear();
  mockEmitOasisEvent.mockResolvedValue({ ok: true });
});

afterEach(() => {
  jest.useRealTimers();
  __resetPolicyResolverForTests();
});

function eventTypes() {
  return mockEmitOasisEvent.mock.calls.map((c) => c[0].type);
}

const BASE: SituationalAwarenessInput = {
  user_id: 'user-base-0000',
  tenant_id: 'tenant-base',
};

// ---------------------------------------------------------------------------
// 1. Time context
// ---------------------------------------------------------------------------

describe('time context — classifyTimeWindow boundaries', () => {
  it.each([
    [4, 'night', true, false],
    [5, 'early_morning', true, true],
    [7, 'early_morning', false, true],
    [8, 'morning', false, false],
    [11, 'morning', false, false],
    [12, 'afternoon', false, false],
    [16, 'afternoon', false, false],
    [17, 'evening', false, false],
    [20, 'evening', false, false],
    [21, 'late_evening', false, false],
    [23, 'late_evening', true, false],
    [0, 'night', true, false],
  ])('hour=%i -> window=%s (is_late_night=%s, is_early_morning=%s)', async (hour, window, lateNight, earlyMorning) => {
    setTime(`2026-07-27T${String(hour).padStart(2, '0')}:00:00.000Z`); // Monday
    const res = await computeSituationalAwareness({ ...BASE, timezone: 'UTC' });
    expect(res.ok).toBe(true);
    const tc = res.bundle!.situation_vector.time_context;
    expect(tc.time_window).toBe(window);
    expect(tc.is_late_night).toBe(lateNight);
    expect(tc.is_early_morning).toBe(earlyMorning);
    expect(tc.hour).toBe(hour);
  });

  it('resolver-seeded override wins over the literal fallback for the morning boundary', async () => {
    seedPolicy(POLICY_KEYS.SITUATIONAL_TIME_OF_DAY_MORNING_START_HOUR, 9);
    setTime('2026-07-27T08:30:00.000Z'); // hour 8: early_morning under override (fallback would say morning)
    const res = await computeSituationalAwareness({ ...BASE, timezone: 'UTC' });
    expect(res.bundle!.situation_vector.time_context.time_window).toBe('early_morning');
  });

  it('weekday vs weekend day_type derivation', async () => {
    setTime('2026-07-25T12:00:00.000Z'); // Saturday
    const sat = await computeSituationalAwareness({ ...BASE, timezone: 'UTC' });
    expect(sat.bundle!.situation_vector.time_context.day_type).toBe('weekend');
    expect(sat.bundle!.situation_vector.time_context.day_of_week).toBe(6);

    setTime('2026-07-27T12:00:00.000Z'); // Monday
    const mon = await computeSituationalAwareness({ ...BASE, timezone: 'UTC' });
    expect(mon.bundle!.situation_vector.time_context.day_type).toBe('weekday');
    expect(mon.bundle!.situation_vector.time_context.day_of_week).toBe(1);
  });

  it('is_likely_work_hours only true on a weekday between 9-17', async () => {
    setTime('2026-07-27T10:00:00.000Z'); // Monday 10:00
    const weekdayWork = await computeSituationalAwareness({ ...BASE, timezone: 'UTC' });
    expect(weekdayWork.bundle!.situation_vector.time_context.is_likely_work_hours).toBe(true);

    setTime('2026-07-25T10:00:00.000Z'); // Saturday 10:00
    const weekendSameHour = await computeSituationalAwareness({ ...BASE, timezone: 'UTC' });
    expect(weekendSameHour.bundle!.situation_vector.time_context.is_likely_work_hours).toBe(false);

    setTime('2026-07-27T08:00:00.000Z'); // Monday 08:00, before the 9-17 window
    const beforeWork = await computeSituationalAwareness({ ...BASE, timezone: 'UTC' });
    expect(beforeWork.bundle!.situation_vector.time_context.is_likely_work_hours).toBe(false);
  });

  it('timezone confidence: 70 when defaulting to UTC, 90 for an explicit non-UTC timezone', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const utcDefault = await computeSituationalAwareness({ ...BASE });
    expect(utcDefault.bundle!.situation_vector.time_context.timezone).toBe('UTC');
    expect(utcDefault.bundle!.situation_vector.time_context.confidence).toBe(70);

    const explicitTz = await computeSituationalAwareness({ ...BASE, timezone: 'America/New_York' });
    const tc = explicitTz.bundle!.situation_vector.time_context;
    expect(tc.timezone).toBe('America/New_York');
    expect(tc.confidence).toBe(90);
    // 10:00 UTC in July (EDT, UTC-4) is 06:00 local.
    expect(tc.hour).toBe(6);
    expect(tc.time_window).toBe('early_morning');
  });

  it('falls back to UTC with confidence 60 when Intl.DateTimeFormat throws on an invalid timezone', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await computeSituationalAwareness({ ...BASE, timezone: 'Not/AZone' });
    const tc = res.bundle!.situation_vector.time_context;
    expect(tc.timezone).toBe('UTC');
    expect(tc.confidence).toBe(60);
    expect(tc.hour).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 2. Location context
// ---------------------------------------------------------------------------

describe('location context', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('no location_hints -> unknown/unknown, confidence 0', async () => {
    const res = await computeSituationalAwareness({ ...BASE });
    expect(res.bundle!.situation_vector.location_context).toMatchObject({
      location_type: 'unknown',
      environment_type: 'unknown',
      is_traveling: false,
      confidence: 0,
    });
  });

  it('is_home=true -> home, confidence 80', async () => {
    const res = await computeSituationalAwareness({ ...BASE, location_hints: { is_home: true } });
    expect(res.bundle!.situation_vector.location_context).toMatchObject({
      location_type: 'home',
      confidence: 80,
    });
  });

  it('is_home=false -> stays unknown, confidence 40', async () => {
    const res = await computeSituationalAwareness({ ...BASE, location_hints: { is_home: false } });
    expect(res.bundle!.situation_vector.location_context).toMatchObject({
      location_type: 'unknown',
      confidence: 40,
    });
  });

  it('is_traveling=true overrides is_home=true -> travel, confidence 75, city/country pass through', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      location_hints: { is_home: true, is_traveling: true, city: 'Berlin', country: 'DE' },
    });
    expect(res.bundle!.situation_vector.location_context).toMatchObject({
      location_type: 'travel',
      is_traveling: true,
      confidence: 75,
      city: 'Berlin',
      country: 'DE',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Availability context
// ---------------------------------------------------------------------------

describe('availability context', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('no calendar/explicit data -> unknown, confidence 0', async () => {
    const res = await computeSituationalAwareness({ ...BASE });
    expect(res.bundle!.situation_vector.availability_context).toMatchObject({
      availability_level: 'unknown',
      interaction_mode: 'unknown',
      has_calendar_data: false,
      has_free_blocks_today: false,
      confidence: 0,
    });
  });

  it('explicit_availability=free -> free/long, confidence 95, has_free_blocks_today true', async () => {
    const res = await computeSituationalAwareness({ ...BASE, explicit_availability: 'free' });
    expect(res.bundle!.situation_vector.availability_context).toMatchObject({
      availability_level: 'free',
      interaction_mode: 'long',
      has_calendar_data: false,
      has_free_blocks_today: true,
      confidence: 95,
    });
  });

  it('explicit_availability=busy -> busy/quick, confidence 95, has_free_blocks_today false', async () => {
    const res = await computeSituationalAwareness({ ...BASE, explicit_availability: 'busy' });
    expect(res.bundle!.situation_vector.availability_context).toMatchObject({
      availability_level: 'busy',
      interaction_mode: 'quick',
      has_free_blocks_today: false,
      confidence: 95,
    });
  });

  it('explicit_availability takes priority over calendar_hints entirely', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      explicit_availability: 'free',
      calendar_hints: { is_free_now: false, next_event_in_minutes: 5 },
    });
    expect(res.bundle!.situation_vector.availability_context.availability_level).toBe('free');
    expect(res.bundle!.situation_vector.availability_context.confidence).toBe(95);
  });

  it('calendar_hints.is_free_now=true -> free/long, confidence 80, has_calendar_data true', async () => {
    const res = await computeSituationalAwareness({ ...BASE, calendar_hints: { is_free_now: true } });
    expect(res.bundle!.situation_vector.availability_context).toMatchObject({
      availability_level: 'free',
      interaction_mode: 'long',
      has_calendar_data: true,
      has_free_blocks_today: true,
      confidence: 80,
    });
  });

  it('calendar_hints.is_free_now=false -> busy/quick, confidence 80', async () => {
    const res = await computeSituationalAwareness({ ...BASE, calendar_hints: { is_free_now: false } });
    expect(res.bundle!.situation_vector.availability_context).toMatchObject({
      availability_level: 'busy',
      interaction_mode: 'quick',
      confidence: 80,
    });
  });

  it.each([
    [10, 'very_busy', 'quick', 85],
    [20, 'busy', 'quick', 80],
    [45, 'lightly_busy', 'normal', 75],
  ])('next_event_in_minutes=%i -> %s/%s, confidence %i', async (minutes, level, mode, confidence) => {
    const res = await computeSituationalAwareness({
      ...BASE,
      calendar_hints: { next_event_in_minutes: minutes },
    });
    expect(res.bundle!.situation_vector.availability_context).toMatchObject({
      availability_level: level,
      interaction_mode: mode,
      confidence,
      minutes_until_next_commitment: minutes,
      estimated_available_minutes: minutes,
    });
  });

  it('next_event_in_minutes=60 (boundary, not < 60) leaves the is_free_now-derived level untouched', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      calendar_hints: { is_free_now: true, next_event_in_minutes: 60 },
    });
    // 60 fails every "< N" branch, so the is_free_now branch's free/long/80 stands.
    expect(res.bundle!.situation_vector.availability_context).toMatchObject({
      availability_level: 'free',
      interaction_mode: 'long',
      confidence: 80,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Energy & readiness context
// ---------------------------------------------------------------------------

describe('energy & readiness context', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z')); // morning: default energy=high, readiness=ready_for_action

  it.each([
    [95, 'high'],
    [80, 'high'],
    [70, 'moderate'],
    [60, 'moderate'],
    [50, 'low'],
    [40, 'low'],
    [20, 'depleted'],
  ])('health_context.energy_level=%i -> energy_level=%s', async (score, expected) => {
    const res = await computeSituationalAwareness({ ...BASE, health_context: { energy_level: score } });
    const rc = res.bundle!.situation_vector.readiness_context;
    expect(rc.energy_level).toBe(expected);
    expect(rc.inferred_from_health).toBe(true);
  });

  it('health energy confidence is capped at 85 even for a 100-score input', async () => {
    const res = await computeSituationalAwareness({ ...BASE, health_context: { energy_level: 100 } });
    expect(res.bundle!.situation_vector.readiness_context.confidence).toBe(85);
  });

  it('cognitive_state=fatigued downgrades an otherwise-high energy to moderate', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      health_context: { energy_level: 90 }, // -> high
      emotional_cognitive_signals: { cognitive_state: 'fatigued' },
    });
    const rc = res.bundle!.situation_vector.readiness_context;
    expect(rc.energy_level).toBe('moderate');
    expect(rc.inferred_from_signals).toBe(true);
  });

  it('cognitive_state=fatigued sets energy to low when otherwise unknown (no time fallback triggered)', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      emotional_cognitive_signals: { cognitive_state: 'fatigued' },
    });
    expect(res.bundle!.situation_vector.readiness_context.energy_level).toBe('low');
  });

  it.each(['focused', 'engaged'])('cognitive_state=%s sets energy to moderate when otherwise unknown', async (state) => {
    const res = await computeSituationalAwareness({
      ...BASE,
      emotional_cognitive_signals: { cognitive_state: state },
    });
    expect(res.bundle!.situation_vector.readiness_context.energy_level).toBe('moderate');
  });

  it.each([
    ['high', 'ready_for_action', 70],
    ['medium', 'ready_for_exploration', 60],
    ['low', 'passive_only', 50],
  ])('engagement_level=%s -> readiness_level=%s (confidence >= %i)', async (engagement, readiness, minConfidence) => {
    const res = await computeSituationalAwareness({
      ...BASE,
      emotional_cognitive_signals: { engagement_level: engagement },
    });
    const rc = res.bundle!.situation_vector.readiness_context;
    expect(rc.readiness_level).toBe(readiness);
    expect(rc.confidence).toBeGreaterThanOrEqual(minConfidence);
  });

  it('falls back to DEFAULT_ENERGY_BY_TIME / DEFAULT_READINESS_BY_TIME when nothing else is provided', async () => {
    setTime('2026-07-27T02:00:00.000Z'); // night window
    const res = await computeSituationalAwareness({ ...BASE });
    const rc = res.bundle!.situation_vector.readiness_context;
    expect(rc.energy_level).toBe('depleted'); // DEFAULT_ENERGY_BY_TIME.night
    expect(rc.readiness_level).toBe('resting'); // DEFAULT_READINESS_BY_TIME.night
    expect(rc.inferred_from_time).toBe(true);
    expect(rc.inferred_from_health).toBe(false);
    expect(rc.inferred_from_signals).toBe(false);
    expect(rc.confidence).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 5. Constraint flags
// ---------------------------------------------------------------------------

describe('constraint flags', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('explicit_constraints are carried through as active, confidence 100, source=explicit', async () => {
    const res = await computeSituationalAwareness({ ...BASE, explicit_constraints: ['privacy_sensitive'] });
    expect(res.bundle!.situation_vector.constraint_flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'privacy_sensitive',
          active: true,
          confidence: 100,
          source: 'explicit',
        }),
      ])
    );
  });

  it('late night adds an active quiet_mode flag (confidence 70, inferred)', async () => {
    setTime('2026-07-27T02:00:00.000Z');
    const res = await computeSituationalAwareness({ ...BASE });
    expect(res.bundle!.situation_vector.constraint_flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'quiet_mode', active: true, confidence: 70, source: 'inferred' }),
      ])
    );
  });

  it('low/depleted energy adds an INACTIVE focus_mode flag (noted, not enforced)', async () => {
    const res = await computeSituationalAwareness({ ...BASE, health_context: { energy_level: 10 } }); // depleted
    expect(res.bundle!.situation_vector.constraint_flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'focus_mode', active: false, confidence: 50 }),
      ])
    );
  });

  it('stress_level > 70 adds an active health_constraint flag (confidence 60, source=health)', async () => {
    const res = await computeSituationalAwareness({ ...BASE, health_context: { stress_level: 71 } });
    expect(res.bundle!.situation_vector.constraint_flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'health_constraint', active: true, confidence: 60, source: 'health' }),
      ])
    );
  });

  it('stress_level of exactly 70 does NOT trigger health_constraint (strict >)', async () => {
    const res = await computeSituationalAwareness({ ...BASE, health_context: { stress_level: 70 } });
    expect(res.bundle!.situation_vector.constraint_flags.some((f) => f.type === 'health_constraint')).toBe(false);
  });

  it('is_urgent adds an active time_pressure flag (confidence 80)', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      emotional_cognitive_signals: { is_urgent: true },
    });
    expect(res.bundle!.situation_vector.constraint_flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'time_pressure', active: true, confidence: 80 }),
      ])
    );
  });

  it('preferences.timing_constraints with type=quiet_hours adds active quiet_mode, source=scheduled, confidence 90', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      preferences: { timing_constraints: [{ type: 'quiet_hours', value: true }] },
    });
    expect(res.bundle!.situation_vector.constraint_flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'quiet_mode', active: true, confidence: 90, source: 'scheduled' }),
      ])
    );
  });

  it('a non-quiet_hours timing_constraint type produces no flag', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      preferences: { timing_constraints: [{ type: 'reminder_window', value: true }] },
    });
    expect(res.bundle!.situation_vector.constraint_flags).toHaveLength(0);
  });

  it('combines multiple simultaneous constraint sources without dropping any', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      explicit_availability: 'busy',
      health_context: { stress_level: 80 },
      emotional_cognitive_signals: { is_urgent: true },
      preferences: { timing_constraints: [{ type: 'quiet_hours', value: true }] },
    });
    const types = res.bundle!.situation_vector.constraint_flags.map((f) => f.type);
    expect(types).toEqual(
      expect.arrayContaining(['health_constraint', 'time_pressure', 'quiet_mode'])
    );
    expect(res.bundle!.situation_vector.constraint_flags).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 6. Overall confidence weighting
// ---------------------------------------------------------------------------

describe('overall confidence weighting', () => {
  it('minimal input (no explicit signals, UTC default) -> round(70*.25 + 0*.15 + 0*.30 + 40*.30) = 30', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await computeSituationalAwareness({ ...BASE });
    expect(res.bundle!.situation_vector.overall_confidence).toBe(30);
  });

  it('explicit non-UTC timezone raises the weighted average to 35 (round(90*.25 + 40*.30) = 35)', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await computeSituationalAwareness({ ...BASE, timezone: 'Europe/Berlin' });
    expect(res.bundle!.situation_vector.overall_confidence).toBe(35);
  });

  it('a fully-signaled favorable situation reaches 72 (cross-checked against the real module)', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await computeSituationalAwareness({
      ...BASE,
      timezone: 'UTC',
      explicit_availability: 'free',
      health_context: { energy_level: 90 },
      emotional_cognitive_signals: { engagement_level: 'high' },
    });
    expect(res.bundle!.situation_vector.overall_confidence).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// 7. Situation tags + action envelope — golden scenarios
// ---------------------------------------------------------------------------

const POSITIVE_INPUT: SituationalAwarenessInput = {
  user_id: 'user-positive-1',
  tenant_id: 'tenant-pos',
  timezone: 'UTC',
  explicit_availability: 'free',
  health_context: { energy_level: 90 },
  emotional_cognitive_signals: { engagement_level: 'high' },
};

const NEGATIVE_INPUT: SituationalAwarenessInput = {
  user_id: 'user-negative-1',
  tenant_id: 'tenant-neg',
  timezone: 'UTC',
};

describe('situation tags + action envelope — everything-allowed scenario', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z')); // Monday morning, daytime

  it('produces exactly [now_ok, high_engagement_ok, commerce_ok, booking_ok] with zero blocked actions', async () => {
    const res = await computeSituationalAwareness(POSITIVE_INPUT);
    const env = res.bundle!.action_envelope;
    expect(env.active_tags).toEqual(['now_ok', 'high_engagement_ok', 'commerce_ok', 'booking_ok']);
    expect(env.blocked_actions).toEqual([]);
    expect(env.envelope_confidence).toBe(72);
  });

  it('allows all 6 action categories, sorted by priority, with the expected max_depth/time_limit', async () => {
    const res = await computeSituationalAwareness(POSITIVE_INPUT);
    const actions = res.bundle!.action_envelope.allowed_actions;
    expect(actions.map((a) => a.action)).toEqual([
      'provide_information',
      'make_suggestion',
      'take_action',
      'initiate_booking',
      'commerce_recommendation',
      'send_notification',
    ]);
    expect(actions.map((a) => a.priority)).toEqual([1, 2, 3, 4, 5, 6]);
    // suggest_short is absent -> medium depth for information, not light.
    expect(actions.find((a) => a.action === 'provide_information')?.max_depth).toBe('medium');
    expect(actions.find((a) => a.action === 'make_suggestion')?.time_limit_minutes).toBeUndefined();
    expect(actions.find((a) => a.action === 'take_action')?.max_depth).toBe('deep');
    // provide_information always reports a fixed 95% confidence; the other
    // 5 actions carry the situation's overall_confidence (72 here).
    expect(actions.find((a) => a.action === 'provide_information')?.confidence).toBe(95);
    expect(actions.filter((a) => a.action !== 'provide_information').every((a) => a.confidence === 72)).toBe(true);
  });

  it('sets envelope expiry to now + envelope_ttl_minutes (15)', async () => {
    const res = await computeSituationalAwareness(POSITIVE_INPUT);
    expect(res.bundle!.action_envelope.expires_at).toBe('2026-07-27T10:15:00.000Z');
    expect(DEFAULT_SITUATIONAL_CONFIG.envelope_ttl_minutes).toBe(15);
  });
});

describe('situation tags + action envelope — everything-blocked scenario', () => {
  beforeEach(() => setTime('2026-07-27T02:00:00.000Z')); // Monday night, no signals

  it('produces exactly [suggest_short, defer_recommendation, avoid_heavy_decisions, quiet_hours, commerce_deferred, booking_deferred]', async () => {
    const res = await computeSituationalAwareness(NEGATIVE_INPUT);
    const env = res.bundle!.action_envelope;
    expect(env.active_tags).toEqual([
      'suggest_short',
      'defer_recommendation',
      'avoid_heavy_decisions',
      'quiet_hours',
      'commerce_deferred',
      'booking_deferred',
    ]);
    expect(env.envelope_confidence).toBe(30);
  });

  it('allows only provide_information (light depth) and blocks the other 5 actions with reasons', async () => {
    const res = await computeSituationalAwareness(NEGATIVE_INPUT);
    const env = res.bundle!.action_envelope;
    expect(env.allowed_actions).toHaveLength(1);
    expect(env.allowed_actions[0]).toMatchObject({ action: 'provide_information', max_depth: 'light' });

    expect(env.blocked_actions.map((b) => b.action)).toEqual([
      'make_suggestion',
      'take_action',
      'initiate_booking',
      'commerce_recommendation',
      'send_notification',
    ]);
    expect(env.blocked_actions.every((b) => typeof b.reason === 'string' && b.reason.length > 0)).toBe(true);
  });
});

describe('situation tags — additional branch coverage', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('explore_light fires for passive_only readiness (low engagement) without high_engagement_ok', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      timezone: 'UTC',
      emotional_cognitive_signals: { engagement_level: 'low' },
    });
    const tags = res.bundle!.action_envelope.active_tags;
    expect(tags).toContain('explore_light');
    expect(tags).not.toContain('high_engagement_ok');
    expect(tags).not.toContain('now_ok'); // confidence stays at 50 (readiness bump only) — below/at threshold check
  });

  it('focus_mode constraint flag being INACTIVE means the focus_mode TAG is never set', async () => {
    // Low/depleted energy sets an inactive focus_mode constraint flag (see
    // constraint-flags describe block) — the situation TAG only fires for
    // an ACTIVE focus_mode flag, which nothing in this engine ever sets.
    const res = await computeSituationalAwareness({ ...BASE, health_context: { energy_level: 10 } });
    expect(res.bundle!.action_envelope.active_tags).not.toContain('focus_mode');
  });

  it('suggest_short fires purely from interaction_mode=quick even at high confidence/daytime', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      timezone: 'UTC',
      explicit_availability: 'busy', // interaction_mode: quick
    });
    expect(res.bundle!.action_envelope.active_tags).toContain('suggest_short');
  });
});

// ---------------------------------------------------------------------------
// 8. Bundle metadata, sources flags, OASIS events, graceful failure
// ---------------------------------------------------------------------------

describe('bundle metadata + sources flags', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('sets each `sources` flag independently based on which optional inputs were supplied', async () => {
    const res = await computeSituationalAwareness({
      ...BASE,
      context_bundle_id: 'ctx-1',
      intent: { primary_intent: 'x' },
      emotional_cognitive_signals: { is_urgent: true },
      preferences: { communication_style: 'direct' },
      calendar_hints: { is_free_now: true },
      location_hints: { is_home: true },
    });
    expect(res.bundle!.sources).toEqual({
      context_bundle_used: true,
      intent_bundle_used: true,
      signal_bundle_used: true,
      preference_bundle_used: true,
      calendar_used: true,
      location_used: true,
    });
  });

  it('all `sources` flags are false when no optional inputs are given', async () => {
    const res = await computeSituationalAwareness({ ...BASE });
    expect(res.bundle!.sources).toEqual({
      context_bundle_used: false,
      intent_bundle_used: false,
      signal_bundle_used: false,
      preference_bundle_used: false,
      calendar_used: false,
      location_used: false,
    });
  });

  it('stamps engine_version, a deterministic determinism_key, and an input_hash', async () => {
    const res = await computeSituationalAwareness({ ...BASE, timezone: 'UTC' });
    expect(res.bundle!.metadata.engine_version).toBe(ENGINE_VERSION);
    expect(res.bundle!.metadata.determinism_key).toMatch(/^[0-9a-f]{12}$/);
    expect(res.bundle!.metadata.input_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('determinism_key depends only on user_id/tenant_id/timezone/explicit_availability/explicit_constraints (order-insensitive)', async () => {
    const a = await computeSituationalAwareness({
      ...BASE,
      timezone: 'UTC',
      explicit_constraints: ['safety', 'quiet_mode'],
      current_message: 'irrelevant to the key',
    });
    const b = await computeSituationalAwareness({
      ...BASE,
      timezone: 'UTC',
      explicit_constraints: ['quiet_mode', 'safety'], // different order
      current_message: 'a totally different message',
    });
    expect(a.bundle!.metadata.determinism_key).toBe(b.bundle!.metadata.determinism_key);

    const differentTenant = await computeSituationalAwareness({
      ...BASE,
      tenant_id: 'a-different-tenant',
      timezone: 'UTC',
    });
    expect(differentTenant.bundle!.metadata.determinism_key).not.toBe(
      (await computeSituationalAwareness({ ...BASE, timezone: 'UTC' })).bundle!.metadata.determinism_key
    );
  });

  it('always carries the non-negotiable situation disclaimer', async () => {
    const res = await computeSituationalAwareness({ ...BASE });
    expect(res.bundle!.disclaimer).toMatch(/inferred from available signals/i);
    expect(res.bundle!.disclaimer).toMatch(/User corrections override/i);
  });

  it('bundle_id/vector_id embed the user_id prefix and computed_at reflects the frozen clock', async () => {
    const res = await computeSituationalAwareness({ ...BASE, user_id: 'user-embed-check' });
    expect(res.bundle!.bundle_id).toMatch(/^sa_\d+_user-emb$/);
    expect(res.bundle!.situation_vector.vector_id).toMatch(/^sv_\d+_user-emb$/);
    expect(res.bundle!.computed_at).toBe('2026-07-27T10:00:00.000Z');
  });
});

describe('OASIS event emission', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('emits d32.situational.awareness.computed with the confidence/tags/energy summary on success', async () => {
    await computeSituationalAwareness(POSITIVE_INPUT);
    expect(eventTypes()).toEqual(['d32.situational.awareness.computed']);
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      vtid: VTID,
      source: 'gateway-d32',
      status: 'success',
    });
    expect(call.payload).toMatchObject({
      user_id: POSITIVE_INPUT.user_id,
      tenant_id: POSITIVE_INPUT.tenant_id,
      overall_confidence: 72,
      time_window: 'morning',
      availability: 'free',
      energy: 'high',
    });
    expect(call.payload.active_tags).toEqual(['now_ok', 'high_engagement_ok', 'commerce_ok', 'booking_ok']);
  });

  it('emits d32.situational.awareness.failed (status=error) and never throws when computation errors, even when OASIS emission itself is rejected', async () => {
    mockEmitOasisEvent.mockRejectedValueOnce(new Error('oasis down'));
    const res = await computeSituationalAwareness({ user_id: undefined as any, tenant_id: 'tenant-x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/substring/);
    // The failed-computation OASIS emission was still attempted, and its
    // own rejection is swallowed (`.catch(() => {})`) rather than crashing.
    expect(eventTypes()).toEqual(['d32.situational.awareness.failed']);
  });

  it('never throws on malformed input (regression test for the fixed pre-try log-line bug)', async () => {
    await expect(computeSituationalAwareness({ user_id: undefined as any, tenant_id: 't' })).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
    await expect(
      computeSituationalAwareness({ user_id: 'u1', tenant_id: 't1', session_id: 10n as any })
    ).resolves.toEqual({ ok: false, error: 'Do not know how to serialize a BigInt' });
  });
});

// ---------------------------------------------------------------------------
// 9. scoreActions
// ---------------------------------------------------------------------------

describe('scoreActions', () => {
  it('returns an empty scored_actions array for an empty actions list', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await scoreActions([], BASE);
    expect(res.ok).toBe(true);
    expect(res.scored_actions).toEqual([]);
    expect(res.situation_vector).toBeDefined();
  });

  it('booking: appropriate_now with a positive availability factor when booking_ok, better_later with a negative one otherwise', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const good = await scoreActions([{ action: 'book-a-call', action_type: 'booking' }], POSITIVE_INPUT);
    expect(good.scored_actions![0]).toMatchObject({
      appropriateness: 'appropriate_now',
      confidence: 72,
      reason: 'Situation is favorable for this action',
    });
    expect(good.scored_actions![0].factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ factor: 'availability', impact: 'positive', weight: 0.4 })])
    );

    setTime('2026-07-27T02:00:00.000Z');
    const bad = await scoreActions([{ action: 'book-a-call', action_type: 'booking' }], NEGATIVE_INPUT);
    expect(bad.scored_actions![0]).toMatchObject({
      appropriateness: 'better_later',
      confidence: 30, // floor(30-20=10, but late-night floor of 30 wins) -- see next test for the exact chain
      reason: 'User availability or readiness is insufficient for booking',
      lighter_alternative: 'Consider a lighter version of "book-a-call"',
    });
  });

  it('purchase: commerce factor + the late-night degradation floor can raise a lower pre-floor confidence back up to 30', async () => {
    setTime('2026-07-27T02:00:00.000Z');
    const res = await scoreActions([{ action: 'buy-thing', action_type: 'purchase' }], NEGATIVE_INPUT);
    // Pre-degrade: max(30-25,25)=25. Late-night degrade: max(25-10,30)=30 (floor wins).
    expect(res.scored_actions![0]).toMatchObject({
      appropriateness: 'better_later',
      confidence: 30,
      reason: 'Commerce deferred due to situation constraints',
    });
  });

  it('recommendation: defer_recommendation drives better_later with a negative timing factor', async () => {
    setTime('2026-07-27T02:00:00.000Z');
    const res = await scoreActions([{ action: 'try-this', action_type: 'recommendation' }], NEGATIVE_INPUT);
    expect(res.scored_actions![0]).toMatchObject({
      appropriateness: 'better_later',
      reason: 'Recommendations should be deferred',
    });
    expect(res.scored_actions![0].factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ factor: 'timing', impact: 'negative' })])
    );
  });

  it('recommendation: appropriate_now with a positive timing factor when not deferred', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await scoreActions([{ action: 'try-this', action_type: 'recommendation' }], POSITIVE_INPUT);
    expect(res.scored_actions![0].appropriateness).toBe('appropriate_now');
    expect(res.scored_actions![0].factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ factor: 'timing', impact: 'positive' })])
    );
  });

  it('notification: not_appropriate with confidence forced to 85 (then degraded by late-night) during quiet_hours', async () => {
    setTime('2026-07-27T02:00:00.000Z');
    const res = await scoreActions([{ action: 'ping', action_type: 'notification' }], NEGATIVE_INPUT);
    expect(res.scored_actions![0]).toMatchObject({
      appropriateness: 'not_appropriate',
      confidence: 75, // 85 - 10 late-night degrade (not information type)
      reason: 'Quiet hours active - notifications blocked',
    });
  });

  it('notification: no quiet-hours penalty at all when not in quiet hours', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await scoreActions([{ action: 'ping', action_type: 'notification' }], POSITIVE_INPUT);
    expect(res.scored_actions![0].appropriateness).toBe('appropriate_now');
    expect(res.scored_actions![0].factors.some((f) => f.factor === 'quiet_mode')).toBe(false);
  });

  it('unknown action_type falls through to the default branch (only scored via now_ok/time/energy factors)', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await scoreActions([{ action: 'mystery', action_type: 'some_unhandled_type' }], POSITIVE_INPUT);
    expect(res.scored_actions![0].factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ factor: 'general_availability', impact: 'positive' })])
    );
  });

  it('information action_type is EXEMPT from the late-night and depleted-energy confidence/appropriateness degradation', async () => {
    setTime('2026-07-27T02:00:00.000Z'); // late night + depleted energy (NEGATIVE_INPUT default fallback)
    const res = await scoreActions([{ action: 'tell-me', action_type: 'information' }], NEGATIVE_INPUT);
    expect(res.scored_actions![0]).toMatchObject({
      appropriateness: 'appropriate_now',
      confidence: 30, // untouched — same as situationVector.overall_confidence
      reason: 'Situation is favorable for this action',
    });
    // The negative (late-night/energy) factors are still recorded for
    // explainability, even though they didn't change the score.
    expect(res.scored_actions![0].factors.map((f) => f.factor)).toEqual(
      expect.arrayContaining(['time_of_day', 'energy_level'])
    );
  });

  it('a non-information action_type in the same late-night/depleted situation IS degraded', async () => {
    setTime('2026-07-27T02:00:00.000Z');
    const res = await scoreActions([{ action: 'mystery', action_type: 'some_unhandled_type' }], NEGATIVE_INPUT);
    expect(res.scored_actions![0].appropriateness).toBe('better_later');
    expect(res.scored_actions![0].confidence).toBe(30); // max(30-10,30)
  });

  it('high energy adds a positive energy_level factor; depleted energy adds a negative one', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const highEnergy = await scoreActions([{ action: 'a', action_type: 'notification' }], POSITIVE_INPUT);
    expect(highEnergy.scored_actions![0].factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ factor: 'energy_level', impact: 'positive' })])
    );

    setTime('2026-07-27T02:00:00.000Z');
    const depleted = await scoreActions([{ action: 'a', action_type: 'notification' }], NEGATIVE_INPUT);
    expect(depleted.scored_actions![0].factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ factor: 'energy_level', impact: 'negative' })])
    );
  });

  it('never throws on malformed input — returns {ok:false, error} instead', async () => {
    const res = await scoreActions([{ action: 'a', action_type: 'booking' }], { user_id: undefined as any, tenant_id: 't' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/substring/);
    expect(res.scored_actions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. overrideSituation
// ---------------------------------------------------------------------------

describe('overrideSituation', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('applies availability_level as explicit_availability on the recomputed vector', async () => {
    const res = await overrideSituation('u-override', 't-override', { availability_level: 'busy' });
    expect(res.ok).toBe(true);
    expect(res.updated_vector!.availability_context).toMatchObject({
      availability_level: 'busy',
      interaction_mode: 'quick',
      confidence: 95,
    });
  });

  it('DOCUMENTED GAP: energy_level is accepted by the override request but never applied — the recomputed readiness is still time-inferred', async () => {
    const res = await overrideSituation('u-override2', 't-override2', {
      availability_level: 'busy',
      energy_level: 'high',
    });
    // If energy_level were honored, this would be 'high' with inferred_from_health/signals
    // true; instead it silently falls back to the morning time-of-day default.
    expect(res.updated_vector!.readiness_context.energy_level).toBe('high'); // morning default happens to also be 'high'
    expect(res.updated_vector!.readiness_context.inferred_from_time).toBe(true);
    expect(res.updated_vector!.readiness_context.inferred_from_health).toBe(false);
    expect(res.updated_vector!.readiness_context.inferred_from_signals).toBe(false);
  });

  it('applies constraints when clear_constraints is not set', async () => {
    const res = await overrideSituation('u-override3', 't-override3', { constraints: ['safety'] });
    expect(res.updated_vector!.constraint_flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'safety', source: 'explicit', active: true })])
    );
  });

  it('clear_constraints=true forces an empty constraint list even if constraints was also provided', async () => {
    const res = await overrideSituation('u-override4', 't-override4', {
      constraints: ['safety'],
      clear_constraints: true,
    });
    expect(res.updated_vector!.constraint_flags).toEqual([]);
  });

  it('emits d32.situation.overridden with the full override payload', async () => {
    await overrideSituation('u-override5', 't-override5', { availability_level: 'free', constraints: ['safety'] });
    expect(eventTypes()).toEqual(['d32.situational.awareness.computed', 'd32.situation.overridden']);
    const overrideCall = mockEmitOasisEvent.mock.calls[1][0];
    expect(overrideCall).toMatchObject({
      vtid: VTID,
      status: 'info',
      payload: {
        user_id: 'u-override5',
        tenant_id: 't-override5',
        overrides: { availability_level: 'free', constraints: ['safety'] },
      },
    });
  });

  it('returns ok:false without throwing when the underlying recomputation fails', async () => {
    const res = await overrideSituation(undefined as any, 't-fail', { availability_level: 'busy' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.updated_vector).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. ORB integration + verification helpers
// ---------------------------------------------------------------------------

describe('getOrbSituationContext / processTurnForOrb', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('returns a formatted context string + orbContext + bundleId on success', async () => {
    const res = await getOrbSituationContext(POSITIVE_INPUT);
    expect(res).not.toBeNull();
    expect(res!.orbContext.time_window).toBe('morning');
    expect(res!.orbContext.availability).toBe('free');
    expect(res!.orbContext.energy).toBe('high');
    expect(res!.orbContext.suggested_depth).toBe('deep'); // high_engagement_ok tag
    expect(res!.context).toContain('## Current Situation (D32 Situational Awareness)');
    expect(res!.context).toContain('Availability: free');
    expect(res!.bundleId).toMatch(/^sa_/);
  });

  it('suggested_depth is "light" when suggest_short is active, "medium" otherwise', async () => {
    setTime('2026-07-27T02:00:00.000Z');
    const res = await getOrbSituationContext(NEGATIVE_INPUT);
    expect(res!.orbContext.suggested_depth).toBe('light');
  });

  it('returns null (never throws) when the underlying computation fails', async () => {
    const res = await getOrbSituationContext({ user_id: undefined as any, tenant_id: 't' });
    expect(res).toBeNull();
  });

  it('processTurnForOrb forwards message/emotionalSignals/timezone into the computation', async () => {
    const res = await processTurnForOrb(
      'user-turn-1',
      'tenant-turn-1',
      'session-1',
      'I need to book something quickly',
      { engagement_level: 'high', is_urgent: true },
      'UTC'
    );
    expect(res).not.toBeNull();
    // is_urgent -> time_pressure constraint should show up as an active constraint.
    expect(res!.orbContext.active_constraints).toContain('time_pressure');
  });
});

describe('verifyBundleIntegrity', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('returns true for an unmodified bundle and false when bundle_hash is tampered with', async () => {
    const res = await computeSituationalAwareness(POSITIVE_INPUT);
    expect(verifyBundleIntegrity(res.bundle!)).toBe(true);
    expect(verifyBundleIntegrity({ ...res.bundle!, bundle_hash: 'deadbeefdeadbeef' })).toBe(false);
  });

  it('detects tampering with vector_id or computed_at, not just bundle_hash directly', async () => {
    const res = await computeSituationalAwareness(POSITIVE_INPUT);
    const tamperedVector = {
      ...res.bundle!,
      situation_vector: { ...res.bundle!.situation_vector, vector_id: 'sv_tampered' },
    };
    expect(verifyBundleIntegrity(tamperedVector)).toBe(false);

    const tamperedTime = { ...res.bundle!, computed_at: '2099-01-01T00:00:00.000Z' };
    expect(verifyBundleIntegrity(tamperedTime)).toBe(false);
  });
});

describe('verifyDeterminism', () => {
  it('matches (no differences) for identical input under a frozen clock', async () => {
    setTime('2026-07-27T10:00:00.000Z');
    const res = await verifyDeterminism(POSITIVE_INPUT);
    expect(res).toEqual({ match: true, differences: [] });
  });

  it('reports failure without throwing when the underlying computation fails both times', async () => {
    const res = await verifyDeterminism({ user_id: undefined as any, tenant_id: 't' });
    expect(res.match).toBe(false);
    expect(res.differences).toContain('One or both computations failed');
  });
});

// ---------------------------------------------------------------------------
// 12. Tenant / user isolation (CLAUDE.md ALWAYS #28 / NEVER #7)
// ---------------------------------------------------------------------------

describe('tenant/user isolation', () => {
  beforeEach(() => setTime('2026-07-27T10:00:00.000Z'));

  it('each bundle carries exactly its own caller-supplied user_id/tenant_id, never anothers', async () => {
    const [a, b] = await Promise.all([
      computeSituationalAwareness({ user_id: 'user-A', tenant_id: 'tenant-A', explicit_availability: 'free' }),
      computeSituationalAwareness({ user_id: 'user-B', tenant_id: 'tenant-B', explicit_availability: 'busy' }),
    ]);
    expect(a.bundle!.user_id).toBe('user-A');
    expect(a.bundle!.tenant_id).toBe('tenant-A');
    expect(a.bundle!.situation_vector.availability_context.availability_level).toBe('free');

    expect(b.bundle!.user_id).toBe('user-B');
    expect(b.bundle!.tenant_id).toBe('tenant-B');
    expect(b.bundle!.situation_vector.availability_context.availability_level).toBe('busy');

    // Cross-checks: neither bundle's identity fields leak into the other.
    expect(a.bundle!.user_id).not.toBe(b.bundle!.user_id);
    expect(a.bundle!.tenant_id).not.toBe(b.bundle!.tenant_id);
    expect(a.bundle!.vector_id ?? a.bundle!.situation_vector.vector_id).not.toContain('user-B');
    expect(b.bundle!.situation_vector.vector_id).not.toContain('user-A');
  });

  it('determinism_key differs across tenants even with identical every other field', async () => {
    const a = await computeSituationalAwareness({ user_id: 'same-user', tenant_id: 'tenant-A', timezone: 'UTC' });
    const b = await computeSituationalAwareness({ user_id: 'same-user', tenant_id: 'tenant-B', timezone: 'UTC' });
    expect(a.bundle!.metadata.determinism_key).not.toBe(b.bundle!.metadata.determinism_key);
  });

  it('OASIS events emitted for one tenant carry only that tenant/user pair in the payload', async () => {
    await computeSituationalAwareness({ user_id: 'user-iso', tenant_id: 'tenant-iso', explicit_availability: 'free' });
    const payload = mockEmitOasisEvent.mock.calls[0][0].payload;
    expect(payload.user_id).toBe('user-iso');
    expect(payload.tenant_id).toBe('tenant-iso');
  });
});

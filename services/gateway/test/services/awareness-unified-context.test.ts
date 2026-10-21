/**
 * VTID-03248 (R1 slice 1) — canonical spoken-first-name resolver tests.
 *
 * Locks the single precedence (memory_facts → app_users → email) that both
 * the Vertex and LiveKit spoken-name sites now share, and proves it
 * reproduces the prior Vertex inline logic (so that migration is a no-op).
 */

import {
  resolveSpokenFirstName,
  type ResolvedFirstName,
  resolveLifeCompassState,
  resolveJourneyPlanPhase,
  isTargetDateInPast,
  type JourneyPlanPhase,
} from '../../src/services/awareness-unified-context';

describe('resolveSpokenFirstName', () => {
  it('1) prefers memory_facts.user_name and returns the first token', () => {
    expect(
      resolveSpokenFirstName({
        memoryFactUserName: 'Dragan Alexander',
        displayName: 'Someone Else',
        email: 'x@y.com',
      }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Dragan', source: 'memory_facts' });
  });

  it('2) falls back to app_users.display_name when no fact', () => {
    expect(
      resolveSpokenFirstName({ memoryFactUserName: null, displayName: 'Maria Rossi', email: 'x@y.com' }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Maria', source: 'app_users' });
  });

  it('3) falls back to the email local-part, digit/sep-stripped + capitalized (faithful to existing logic)', () => {
    expect(
      resolveSpokenFirstName({ memoryFactUserName: '', displayName: '', email: 'dragan1@example.com' }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Dragan', source: 'email' });
    // NOTE: the strip regex removes the separator char, so "d_stevanovic"
    // collapses to "Dstevanovic" (NOT "Stevanovic"). This reproduces the prior
    // Vertex inline behavior exactly — improving email-derived name quality is
    // a later, separate change, not this zero-behavior-change slice.
    expect(
      resolveSpokenFirstName({ email: 'd_stevanovic@hotmail.com' }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Dstevanovic', source: 'email' });
  });

  it('4) returns none when nothing usable', () => {
    expect(resolveSpokenFirstName({})).toEqual<ResolvedFirstName>({ firstName: null, source: 'none' });
    expect(
      resolveSpokenFirstName({ memoryFactUserName: '   ', displayName: '   ', email: '' }),
    ).toEqual<ResolvedFirstName>({ firstName: null, source: 'none' });
  });

  it('5) does not derive from an email local-part shorter than 2 chars after stripping', () => {
    expect(
      resolveSpokenFirstName({ email: '1@example.com' }),
    ).toEqual<ResolvedFirstName>({ firstName: null, source: 'none' });
  });

  it('6) trims surrounding whitespace before tokenizing', () => {
    expect(
      resolveSpokenFirstName({ memoryFactUserName: '  Dragan  ' }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Dragan', source: 'memory_facts' });
  });

  it('7) email fallback only triggers on a real address (must contain @)', () => {
    expect(resolveSpokenFirstName({ email: 'not-an-email' })).toEqual<ResolvedFirstName>({
      firstName: null,
      source: 'none',
    });
  });

  it('8) reproduces the prior Vertex inline behavior across the precedence chain', () => {
    // memory_facts present → memory_facts
    expect(resolveSpokenFirstName({ memoryFactUserName: 'Ana', displayName: 'B', email: 'c1@d.com' }).source).toBe('memory_facts');
    // only display → app_users
    expect(resolveSpokenFirstName({ displayName: 'Ben Stiller', email: 'c1@d.com' }).source).toBe('app_users');
    // only email → email
    expect(resolveSpokenFirstName({ email: 'carol2@d.com' })).toEqual<ResolvedFirstName>({ firstName: 'Carol', source: 'email' });
  });
});

// ===========================================================================
// R1 slice 2 — life_compass state resolver.
// ===========================================================================

describe('resolveLifeCompassState', () => {
  it('hasActiveRow === false forces not_set even with stale goal text / set_at', () => {
    expect(
      resolveLifeCompassState({ hasActiveRow: false, primaryGoal: 'Run a marathon', setAt: '2026-01-01' }),
    ).toBe('not_set');
  });

  it('non-empty primary goal → set', () => {
    expect(resolveLifeCompassState({ primaryGoal: 'Sleep 8h' })).toBe('set');
  });

  it('whitespace-only primary goal does NOT count as set', () => {
    expect(resolveLifeCompassState({ primaryGoal: '   ' })).toBe('not_set');
  });

  it('parseable set_at alone → set', () => {
    expect(resolveLifeCompassState({ setAt: '2026-05-01T10:00:00Z' })).toBe('set');
  });

  it('unparseable set_at alone → not_set', () => {
    expect(resolveLifeCompassState({ setAt: 'not-a-date' })).toBe('not_set');
  });

  it('explicit hasActiveRow === true → set even with no goal/setAt', () => {
    expect(resolveLifeCompassState({ hasActiveRow: true })).toBe('set');
  });

  it('empty input → not_set', () => {
    expect(resolveLifeCompassState({})).toBe('not_set');
    expect(resolveLifeCompassState({ primaryGoal: null, setAt: null, hasActiveRow: null })).toBe('not_set');
  });

  it('goal wins over an explicit false? No — false hard-overrides (strictest)', () => {
    // hasActiveRow:false is the strictest signal and must win.
    expect(resolveLifeCompassState({ hasActiveRow: false, primaryGoal: 'X' })).toBe('not_set');
  });
});

// ===========================================================================
// R1 slice 2 — isTargetDateInPast helper.
// ===========================================================================

describe('isTargetDateInPast', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('null / undefined / empty → false', () => {
    expect(isTargetDateInPast(null, now)).toBe(false);
    expect(isTargetDateInPast(undefined, now)).toBe(false);
    expect(isTargetDateInPast('   ', now)).toBe(false);
  });

  it('unparseable string → false', () => {
    expect(isTargetDateInPast('someday', now)).toBe(false);
  });

  it('date-only in the past → true', () => {
    expect(isTargetDateInPast('2026-05-31', now)).toBe(true);
  });

  it('date-only in the future → false', () => {
    expect(isTargetDateInPast('2026-06-02', now)).toBe(false);
  });

  it('date-only == today is NOT past (anchored to end-of-day UTC)', () => {
    // 2026-06-01T23:59:59Z is after now (12:00Z) → not past.
    expect(isTargetDateInPast('2026-06-01', now)).toBe(false);
  });

  it('full ISO timestamp earlier today IS past', () => {
    expect(isTargetDateInPast('2026-06-01T06:00:00Z', now)).toBe(true);
  });

  it('full ISO timestamp later today is NOT past', () => {
    expect(isTargetDateInPast('2026-06-01T18:00:00Z', now)).toBe(false);
  });
});

// ===========================================================================
// R1 slice 2 — journey plan_phase resolver (the §1.4 4-way discriminator).
// ===========================================================================

describe('resolveJourneyPlanPhase', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  const phase = (
    over: Partial<Parameters<typeof resolveJourneyPlanPhase>[0]>,
  ): JourneyPlanPhase =>
    resolveJourneyPlanPhase({
      dayInJourney: 1,
      totalDays: 90,
      lifeCompassState: 'not_set',
      now,
      ...over,
    }).plan_phase;

  // --- not_set branch (day vs total_days boundary) ---

  it('not_set, day < total_days → default_active', () => {
    expect(phase({ dayInJourney: 45, totalDays: 90 })).toBe('default_active');
  });

  it('not_set, day == total_days → default_active (boundary: on last day, not past)', () => {
    expect(phase({ dayInJourney: 90, totalDays: 90 })).toBe('default_active');
  });

  it('not_set, day == total_days + 1 → default_finished_no_goal', () => {
    expect(phase({ dayInJourney: 91, totalDays: 90 })).toBe('default_finished_no_goal');
  });

  it('not_set, day >> total_days → default_finished_no_goal', () => {
    expect(phase({ dayInJourney: 200, totalDays: 90 })).toBe('default_finished_no_goal');
  });

  // --- set branch (target_date past/future/null) ---

  it('set, no target_date → on_personalized_goal', () => {
    const r = resolveJourneyPlanPhase({ dayInJourney: 5, totalDays: 90, lifeCompassState: 'set', now });
    expect(r.plan_phase).toBe('on_personalized_goal');
    expect(r.target_date_in_past).toBe(false);
  });

  it('set, future target_date → on_personalized_goal', () => {
    const r = resolveJourneyPlanPhase({
      dayInJourney: 5, totalDays: 90, lifeCompassState: 'set', targetDate: '2026-12-31', now,
    });
    expect(r.plan_phase).toBe('on_personalized_goal');
    expect(r.target_date_in_past).toBe(false);
  });

  it('set, past target_date → goal_completed', () => {
    const r = resolveJourneyPlanPhase({
      dayInJourney: 5, totalDays: 90, lifeCompassState: 'set', targetDate: '2026-05-01', now,
    });
    expect(r.plan_phase).toBe('goal_completed');
    expect(r.target_date_in_past).toBe(true);
  });

  it('set, target_date == today → on_personalized_goal (today not yet past)', () => {
    expect(
      phase({ lifeCompassState: 'set', targetDate: '2026-06-01' }),
    ).toBe('on_personalized_goal');
  });

  it('set state takes precedence over day count (goal overrides plan window)', () => {
    // Even when day > total_days, a set goal means on_personalized_goal,
    // never default_finished_no_goal.
    expect(
      phase({ lifeCompassState: 'set', dayInJourney: 500, totalDays: 90 }),
    ).toBe('on_personalized_goal');
  });

  it('past target_date is ignored when life_compass is not_set', () => {
    // No goal → the target_date is irrelevant; day-vs-total decides.
    const r = resolveJourneyPlanPhase({
      dayInJourney: 10, totalDays: 90, lifeCompassState: 'not_set', targetDate: '2020-01-01', now,
    });
    expect(r.plan_phase).toBe('default_active');
    // helper still reports the raw past-ness, but it does not change phase.
    expect(r.target_date_in_past).toBe(true);
  });

  it('end-to-end with resolveLifeCompassState: real goal text → on_personalized_goal', () => {
    const state = resolveLifeCompassState({ primaryGoal: 'Lose 5kg' });
    expect(phase({ lifeCompassState: state })).toBe('on_personalized_goal');
  });
});

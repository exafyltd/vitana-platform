/**
 * BOOTSTRAP-AUTOPILOT-EXPANSION: unit tests for the calendar-prep analyzer.
 *
 * Covers the PURE rule layer (classifyCalendarPrep / classifyCalendarPrepBatch):
 * no DB, no clock — `now` is always injected so assertions are deterministic.
 */

import {
  classifyCalendarPrep,
  classifyCalendarPrepBatch,
  generateCalendarPrepFingerprint,
  DEFAULT_CALENDAR_PREP_CONFIG,
  CalendarEventRow,
  CalendarPrepSignal,
  WellnessPillar,
} from '../../../../src/services/recommendation-engine/analyzers/calendar-prep-analyzer';

const NOW = new Date('2026-06-02T09:00:00.000Z');

function ev(over: Partial<CalendarEventRow> = {}): CalendarEventRow {
  return {
    id: over.id ?? 'evt-1',
    user_id: over.user_id ?? 'user-1',
    tenant_id: 'tenant_id' in over ? over.tenant_id! : 'tenant-1',
    // default: 3h from NOW → within lookahead, imminent, same day
    start_time: over.start_time ?? '2026-06-02T12:00:00.000Z',
    // Respect an explicit `pillar: null` (don't coerce via ??).
    pillar: 'pillar' in over ? over.pillar! : 'exercise',
    event_type: over.event_type ?? 'workout',
    status: over.status ?? 'confirmed',
    source_type: over.source_type ?? 'user',
  };
}

describe('classifyCalendarPrep (pure single-event rules)', () => {
  it('emits a signal for an upcoming wellness-pillar event with no prep block', () => {
    const target = ev();
    const sig = classifyCalendarPrep(target, [target], NOW);
    expect(sig).not.toBeNull();
    expect(sig!.pillar).toBe('exercise');
    expect(sig!.user_id).toBe('user-1');
    expect(sig!.target_event_id).toBe('evt-1');
    expect(sig!.hours_until).toBe(3);
    expect(sig!.summary).toContain('exercise');
  });

  it('returns null when the event has no pillar', () => {
    const target = ev({ pillar: null });
    expect(classifyCalendarPrep(target, [target], NOW)).toBeNull();
  });

  it('returns null for cancelled events', () => {
    const target = ev({ status: 'cancelled' });
    expect(classifyCalendarPrep(target, [target], NOW)).toBeNull();
  });

  it('returns null for events already in the past', () => {
    const target = ev({ start_time: '2026-06-02T08:00:00.000Z' }); // 1h before NOW
    expect(classifyCalendarPrep(target, [target], NOW)).toBeNull();
  });

  it('returns null for events beyond the lookahead horizon', () => {
    // 60h out, lookahead default is 48h
    const target = ev({ start_time: '2026-06-04T21:00:00.000Z' });
    expect(classifyCalendarPrep(target, [target], NOW)).toBeNull();
  });

  it('returns null when a prep block already exists within the prep window', () => {
    const target = ev({ id: 'evt-target', start_time: '2026-06-02T12:00:00.000Z' });
    const prep = ev({
      id: 'evt-prep',
      pillar: 'exercise',
      start_time: '2026-06-02T11:00:00.000Z', // 1h before target, inside 120-min window
    });
    expect(classifyCalendarPrep(target, [target, prep], NOW)).toBeNull();
  });

  it('still emits when the only nearby block is a DIFFERENT pillar', () => {
    const target = ev({ id: 'evt-target', pillar: 'exercise', start_time: '2026-06-02T12:00:00.000Z' });
    const otherPillar = ev({
      id: 'evt-other',
      pillar: 'sleep',
      start_time: '2026-06-02T11:00:00.000Z',
    });
    const sig = classifyCalendarPrep(target, [target, otherPillar], NOW);
    expect(sig).not.toBeNull();
    expect(sig!.pillar).toBe('exercise');
  });

  it('still emits when the nearby same-pillar block is OUTSIDE the prep window', () => {
    const target = ev({ id: 'evt-target', start_time: '2026-06-02T12:00:00.000Z' });
    const tooEarly = ev({
      id: 'evt-early',
      pillar: 'exercise',
      start_time: '2026-06-02T09:30:00.000Z', // 2.5h before target, outside 120-min window
    });
    expect(classifyCalendarPrep(target, [target, tooEarly], NOW)).not.toBeNull();
  });

  it('ignores a cancelled prep block (does not count as prepared)', () => {
    const target = ev({ id: 'evt-target', start_time: '2026-06-02T12:00:00.000Z' });
    const cancelledPrep = ev({
      id: 'evt-prep',
      pillar: 'exercise',
      start_time: '2026-06-02T11:00:00.000Z',
      status: 'cancelled',
    });
    expect(classifyCalendarPrep(target, [target, cancelledPrep], NOW)).not.toBeNull();
  });

  describe('severity ladder', () => {
    it('high for imminent same-day events', () => {
      const target = ev({ start_time: '2026-06-02T12:00:00.000Z' }); // 3h, same day
      expect(classifyCalendarPrep(target, [target], NOW)!.severity).toBe('high');
    });

    it('medium for imminent but next-day events', () => {
      // imminent_hours default = 6. Pick an event ~5h out that crosses midnight.
      const lateNow = new Date('2026-06-02T21:00:00.000Z');
      const target = ev({ start_time: '2026-06-03T01:00:00.000Z' }); // 4h out, next day
      expect(classifyCalendarPrep(target, [target], lateNow)!.severity).toBe('medium');
    });

    it('low for events further out than the imminent window', () => {
      const target = ev({ start_time: '2026-06-03T20:00:00.000Z' }); // ~35h out
      expect(classifyCalendarPrep(target, [target], NOW)!.severity).toBe('low');
    });
  });

  it('confidence is higher for sooner events and clamped to [0.4, 0.9]', () => {
    const soon = ev({ start_time: '2026-06-02T10:00:00.000Z' }); // 1h
    const far = ev({ start_time: '2026-06-04T08:00:00.000Z' }); // ~47h
    const soonSig = classifyCalendarPrep(soon, [soon], NOW)!;
    const farSig = classifyCalendarPrep(far, [far], NOW)!;
    expect(soonSig.confidence).toBeGreaterThan(farSig.confidence);
    expect(soonSig.confidence).toBeLessThanOrEqual(0.9);
    expect(farSig.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it('honours a custom config', () => {
    // Tighten lookahead to 1h — a 3h-out event should now be skipped.
    const target = ev({ start_time: '2026-06-02T12:00:00.000Z' });
    expect(
      classifyCalendarPrep(target, [target], NOW, { ...DEFAULT_CALENDAR_PREP_CONFIG, lookahead_hours: 1 }),
    ).toBeNull();
  });
});

describe('classifyCalendarPrepBatch (pure multi-user rules)', () => {
  it('emits at most one signal per (user, pillar), keeping the soonest', () => {
    const early = ev({ id: 'e1', user_id: 'u1', pillar: 'exercise', start_time: '2026-06-02T11:00:00.000Z' });
    const later = ev({ id: 'e2', user_id: 'u1', pillar: 'exercise', start_time: '2026-06-02T18:00:00.000Z' });
    const out = classifyCalendarPrepBatch([later, early], NOW);
    const exercise = out.filter((s) => s.user_id === 'u1' && s.pillar === 'exercise');
    expect(exercise).toHaveLength(1);
    expect(exercise[0].target_event_id).toBe('e1'); // the soonest
  });

  it('emits separate signals for different pillars of the same user', () => {
    const exercise = ev({ id: 'e1', user_id: 'u1', pillar: 'exercise', start_time: '2026-06-02T12:00:00.000Z' });
    const sleep = ev({ id: 'e2', user_id: 'u1', pillar: 'sleep', start_time: '2026-06-02T22:00:00.000Z' });
    const out = classifyCalendarPrepBatch([exercise, sleep], NOW);
    const pillars = out.filter((s) => s.user_id === 'u1').map((s) => s.pillar).sort();
    expect(pillars).toEqual<WellnessPillar[]>(['exercise', 'sleep']);
  });

  it('keeps users isolated — u2\'s prep block only suppresses u2\'s own target, not u1\'s', () => {
    // u1: a lone unprepared target → must yield a signal targeting evt-a.
    const u1target = ev({ id: 'a', user_id: 'u1', pillar: 'exercise', start_time: '2026-06-02T12:00:00.000Z' });
    // u2: same 12:00 target, but with an 11:00 prep block before it. The 12:00
    // target (evt-b) is suppressed; the 11:00 prep (evt-c) is itself the soonest
    // unprepared exercise block for u2, so u2 gets exactly one signal — for evt-c.
    const u2target = ev({ id: 'b', user_id: 'u2', pillar: 'exercise', start_time: '2026-06-02T12:00:00.000Z' });
    const u2prep = ev({ id: 'c', user_id: 'u2', pillar: 'exercise', start_time: '2026-06-02T11:00:00.000Z' });

    const out = classifyCalendarPrepBatch([u1target, u2target, u2prep], NOW);
    const targets = out.map((s) => s.target_event_id).sort();

    // u1 keeps its signal (evt-a); u2's 12:00 target (evt-b) is suppressed by its
    // own prep; u2 instead surfaces the earliest unprepared block (evt-c).
    expect(targets).toEqual(['a', 'c']);
    expect(targets).not.toContain('b');
  });

  it('returns an empty array when nothing qualifies', () => {
    const past = ev({ start_time: '2026-06-01T12:00:00.000Z' });
    expect(classifyCalendarPrepBatch([past], NOW)).toEqual([]);
  });
});

describe('generateCalendarPrepFingerprint', () => {
  const base: CalendarPrepSignal = {
    user_id: 'u1',
    tenant_id: 't1',
    pillar: 'exercise',
    target_event_id: 'e1',
    severity: 'high',
    confidence: 0.8,
    hours_until: 3,
    summary: 'x',
  };

  it('is stable for the same user+pillar (daily bucket)', () => {
    expect(generateCalendarPrepFingerprint(base)).toBe(generateCalendarPrepFingerprint(base));
  });

  it('differs by pillar', () => {
    expect(generateCalendarPrepFingerprint(base)).not.toBe(
      generateCalendarPrepFingerprint({ ...base, pillar: 'sleep' }),
    );
  });

  it('differs by user', () => {
    expect(generateCalendarPrepFingerprint(base)).not.toBe(
      generateCalendarPrepFingerprint({ ...base, user_id: 'u2' }),
    );
  });

  it('is a 16-char hex string', () => {
    expect(generateCalendarPrepFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});

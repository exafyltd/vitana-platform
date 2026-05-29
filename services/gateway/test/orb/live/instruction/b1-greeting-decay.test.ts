/**
 * VTID-02930 (B1) — greeting decay tests.
 *
 * Direct mapping to the 7 acceptance checks the user locked:
 *   1. Repeated greetings decay across recent sessions.
 *   2. Reconnects do not behave like fresh first-time greetings.
 *   3. Greeting policy returns a typed decision with reason/evidence.
 *   4. Empty/unknown cadence data degrades safely.
 *   5. Command Hub panel renders even when no cadence data exists.
 *      (structural test in b1-walls.test.ts)
 *   6. No mutation from preview/panel routes.
 *      (structural test in b1-walls.test.ts)
 *   7. Tests prove B1 does not alter B0d continuation behavior except
 *      through the intended greeting-policy seam.
 *      (regression test below — decideGreetingPolicy still returns
 *      the same string union for the legacy bucket-only inputs.)
 */

import {
  decideGreetingPolicy,
  decideGreetingPolicyWithEvidence,
} from '../../../../src/orb/live/instruction/greeting-policy';

describe('B1 acceptance check #1: repeated greetings decay', () => {
  it('same greeting style twice in a row → downgrades one tier', () => {
    // bucket=today → default warm_return. last_used=warm_return →
    // should decay to brief_resume.
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      greeting_style_last_used: 'warm_return',
    });
    expect(r.policy).toBe('brief_resume');
    expect(r.reason).toBe('bucket_with_decay_layer');
    expect(r.evidence.find((e) => e.signal === 'greeting_style_last_used')?.influence).toBe('dampened');
  });

  it('fresh_intro twice in a row → downgrades to warm_return', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'long',
      greeting_style_last_used: 'fresh_intro',
    });
    expect(r.policy).toBe('warm_return');
  });

  it('brief_resume twice in a row → downgrades to skip', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'same_day',
      greeting_style_last_used: 'brief_resume',
    });
    expect(r.policy).toBe('skip');
  });

  it('skip → stays skip when last_used was also skip (no flip up)', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'reconnect',
      greeting_style_last_used: 'skip',
    });
    // reconnect bucket forces skip BEFORE the decay layer evaluates;
    // the result is still skip, but for the bucket reason, not the
    // style avoidance.
    expect(r.policy).toBe('skip');
  });

  it('different style last → no downgrade', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      greeting_style_last_used: 'brief_resume',
    });
    expect(r.policy).toBe('warm_return'); // unchanged
  });

  it('sessions_today_count >= 3 with bucket=today caps intensity at brief_resume', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      sessions_today_count: 4,
    });
    expect(r.policy).toBe('brief_resume');
    expect(r.evidence.find((e) => e.signal === 'sessions_today_count')?.influence).toBe('dampened');
  });

  it('sessions_today_count < 3 does not dampen', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      sessions_today_count: 2,
    });
    expect(r.policy).toBe('warm_return');
    expect(r.evidence.find((e) => e.signal === 'sessions_today_count')?.influence).toBe('ignored');
  });

  it('time_since_last_greeting_today_ms < 15min → skip', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      time_since_last_greeting_today_ms: 5 * 60 * 1000,
    });
    expect(r.policy).toBe('skip');
    expect(r.reason).toBe('greeted_recently_within_window');
  });

  it('time_since_last_greeting_today_ms > 15min → does NOT skip', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      time_since_last_greeting_today_ms: 30 * 60 * 1000,
    });
    expect(r.policy).toBe('warm_return');
  });
});

describe('B1 acceptance check #2: reconnects do not behave like first-time greetings', () => {
  it('isReconnect=true → skip regardless of bucket', () => {
    for (const bucket of ['first', 'long', 'week', 'today']) {
      const r = decideGreetingPolicyWithEvidence({ bucket, isReconnect: true });
      expect(r.policy).toBe('skip');
      expect(r.reason).toBe('isReconnect_forces_skip');
    }
  });

  it('is_transparent_reconnect=true → skip with the transparent_reconnect reason', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'first',
      is_transparent_reconnect: true,
    });
    expect(r.policy).toBe('skip');
    expect(r.reason).toBe('transparent_reconnect_forces_skip');
  });

  it('bucket=reconnect → skip even without the boolean flag', () => {
    const r = decideGreetingPolicyWithEvidence({ bucket: 'reconnect' });
    expect(r.policy).toBe('skip');
    expect(r.reason).toBe('bucket_reconnect_forces_skip');
  });

  it('cross-surface continuation (turn within 5min) → skip', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'first', // would otherwise be fresh_intro
      seconds_since_last_turn_anywhere: 60, // 1 minute
    });
    expect(r.policy).toBe('skip');
    expect(r.reason).toBe('recent_turn_continues_thread');
  });

  it('device handoff → brief_resume, not fresh_intro', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'first',
      device_handoff_signal: true,
    });
    expect(r.policy).toBe('brief_resume');
    expect(r.reason).toBe('device_handoff_continues_thread');
  });
});

describe('B1 acceptance check #3: typed decision with reason + evidence', () => {
  it('returns the full envelope shape on every call', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      greeting_style_last_used: 'warm_return',
      sessions_today_count: 5,
    });
    expect(r).toHaveProperty('policy');
    expect(r).toHaveProperty('reason');
    expect(r).toHaveProperty('evidence');
    expect(r).toHaveProperty('signalsPresent');
    expect(r).toHaveProperty('signalsMissing');
    expect(r).toHaveProperty('fellBackToBucket');
  });

  it('evidence items have stable shape (signal + value + influence)', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      greeting_style_last_used: 'warm_return',
    });
    for (const e of r.evidence) {
      expect(typeof e.signal).toBe('string');
      expect(['forced', 'dampened', 'preferred', 'ignored']).toContain(e.influence);
    }
  });

  it('signalsPresent / signalsMissing add up to the full 7-signal set', () => {
    const allSignals = [
      'seconds_since_last_turn_anywhere',
      'sessions_today_count',
      'is_transparent_reconnect',
      'time_since_last_greeting_today_ms',
      'greeting_style_last_used',
      'wake_origin',
      'device_handoff_signal',
    ];
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      sessions_today_count: 2,
      wake_origin: 'orb_tap',
    });
    expect(r.signalsPresent.sort()).toEqual(['sessions_today_count', 'wake_origin']);
    expect(r.signalsPresent.length + r.signalsMissing.length).toBe(allSignals.length);
    expect([...r.signalsPresent, ...r.signalsMissing].sort()).toEqual(allSignals.sort());
  });

  it('fellBackToBucket=true when only bucket is provided', () => {
    const r = decideGreetingPolicyWithEvidence({ bucket: 'today' });
    expect(r.fellBackToBucket).toBe(true);
  });

  it('fellBackToBucket=false when a forced override fires', () => {
    const r = decideGreetingPolicyWithEvidence({ bucket: 'today', isReconnect: true });
    expect(r.fellBackToBucket).toBe(false);
  });
});

describe('B1 acceptance check #4: empty/unknown cadence data degrades safely', () => {
  it('no cadence signals → falls back to A4 bucket logic', () => {
    expect(decideGreetingPolicyWithEvidence({ bucket: 'today' }).policy).toBe('warm_return');
    expect(decideGreetingPolicyWithEvidence({ bucket: 'long' }).policy).toBe('fresh_intro');
    expect(decideGreetingPolicyWithEvidence({ bucket: 'same_day' }).policy).toBe('brief_resume');
  });

  it('unknown bucket → fresh_intro (conservative default)', () => {
    expect(decideGreetingPolicyWithEvidence({ bucket: 'made_up' }).policy).toBe('fresh_intro');
  });

  it('NaN / Infinity / negative numeric signals are ignored, not crash', () => {
    const cases = [
      { seconds_since_last_turn_anywhere: NaN },
      { seconds_since_last_turn_anywhere: Number.POSITIVE_INFINITY },
      { seconds_since_last_turn_anywhere: -1 },
      { time_since_last_greeting_today_ms: NaN },
      { time_since_last_greeting_today_ms: -100 },
      { sessions_today_count: NaN },
    ];
    for (const c of cases) {
      const r = decideGreetingPolicyWithEvidence({ bucket: 'today', ...c });
      expect(r.policy).toBe('warm_return'); // bucket default
    }
  });

  it('unknown wake_origin string is ignored (not stored as evidence influence=forced)', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'today',
      wake_origin: 'unknown',
    });
    // 'unknown' is a known value but should NOT trigger push_tap path.
    expect(r.policy).toBe('warm_return');
  });

  it('wake_origin=push_tap on fresh_intro path nudges to warm_return', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'long',
      wake_origin: 'push_tap',
    });
    expect(r.policy).toBe('warm_return');
  });

  it('wake_origin=push_tap on brief_resume path is left alone', () => {
    const r = decideGreetingPolicyWithEvidence({
      bucket: 'same_day',
      wake_origin: 'push_tap',
    });
    expect(r.policy).toBe('brief_resume');
  });
});

describe('B1 acceptance check #7: B0d behavior unchanged via the seam', () => {
  // The wake-brief-wiring (B0d.4) calls decideGreetingPolicy(input) and
  // uses the string return value. The function must keep that signature
  // and continue returning the same string values for the legacy A4
  // inputs (bucket + isReconnect + wasFailure).

  it('decideGreetingPolicy still returns a string (not the envelope)', () => {
    const result = decideGreetingPolicy({ bucket: 'today' });
    expect(typeof result).toBe('string');
    expect(['skip', 'brief_resume', 'warm_return', 'fresh_intro']).toContain(result);
  });

  const a4TruthTable: Array<[string, boolean | undefined, boolean | undefined, string]> = [
    ['reconnect', false, false, 'skip'],
    ['recent', false, false, 'brief_resume'],
    ['recent', false, true, 'warm_return'],          // wasFailure override
    ['same_day', false, false, 'brief_resume'],
    ['today', false, false, 'warm_return'],
    ['yesterday', false, false, 'warm_return'],
    ['week', false, false, 'warm_return'],
    ['long', false, false, 'fresh_intro'],
    ['first', false, false, 'fresh_intro'],
    ['anything-unknown', false, false, 'fresh_intro'],
    ['today', true, false, 'skip'],                  // isReconnect=true forces skip
  ];

  it.each(a4TruthTable)(
    'A4 truth table: bucket=%s isReconnect=%s wasFailure=%s → %s',
    (bucket, isReconnect, wasFailure, expected) => {
      const result = decideGreetingPolicy({
        bucket,
        ...(isReconnect !== undefined ? { isReconnect } : {}),
        ...(wasFailure !== undefined ? { wasFailure } : {}),
      });
      expect(result).toBe(expected);
    },
  );
});

/**
 * A4 — Characterization test for the greeting-policy stub.
 *
 * Locks the truth table that B1 (Session Cadence & Greeting Decay) must
 * preserve when it replaces the stub with signal-driven logic. The
 * mapping mirrors today's inline behavior inside
 * `buildTemporalJourneyContextSection` — A4's stub is intentionally
 * faithful so this PR ships zero behavior change.
 */

import {
  decideGreetingPolicy,
  GreetingPolicy,
  GreetingPolicyInput,
} from '../../../../src/orb/live/instruction/greeting-policy';

describe('A4 characterization: decideGreetingPolicy stub', () => {
  describe('reconnect override (VTID-02637)', () => {
    it.each([
      ['recent'],
      ['same_day'],
      ['today'],
      ['yesterday'],
      ['week'],
      ['long'],
      ['first'],
    ])('isReconnect=true forces "skip" regardless of bucket "%s"', (bucket) => {
      expect(decideGreetingPolicy({ bucket, isReconnect: true })).toBe('skip');
    });
  });

  describe('bucket → policy mapping (today\'s truth table)', () => {
    const cases: Array<[string, Partial<GreetingPolicyInput>, GreetingPolicy]> = [
      ['reconnect', {}, 'skip'],
      ['recent', {}, 'brief_resume'],
      ['recent', { wasFailure: true }, 'warm_return'],
      ['same_day', {}, 'brief_resume'],
      ['today', {}, 'warm_return'],
      ['yesterday', {}, 'warm_return'],
      ['week', {}, 'warm_return'],
      ['long', {}, 'fresh_intro'],
      ['first', {}, 'fresh_intro'],
    ];

    it.each(cases)(
      'bucket=%s with %j → %s',
      (bucket, extra, expected) => {
        expect(decideGreetingPolicy({ bucket, ...extra })).toBe(expected);
      }
    );
  });

  describe('unknown buckets default conservatively', () => {
    it.each([
      'unknown',
      '',
      'totally-not-a-bucket',
      'reconnects', // typo guard — must NOT match the real 'reconnect' bucket
    ])('unknown bucket "%s" → fresh_intro (conservative default)', (bucket) => {
      expect(decideGreetingPolicy({ bucket })).toBe('fresh_intro');
    });
  });

  describe('output domain', () => {
    it('always returns one of the four declared policies', () => {
      const valid: GreetingPolicy[] = ['skip', 'brief_resume', 'warm_return', 'fresh_intro'];
      for (const bucket of ['reconnect', 'recent', 'same_day', 'today', 'yesterday', 'week', 'long', 'first', 'whatever']) {
        for (const isReconnect of [true, false, undefined]) {
          for (const wasFailure of [true, false, undefined]) {
            const result = decideGreetingPolicy({ bucket, isReconnect, wasFailure });
            expect(valid).toContain(result);
          }
        }
      }
    });
  });
});

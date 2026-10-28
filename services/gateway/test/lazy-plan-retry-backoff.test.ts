/**
 * lazyPlanTick retry backoff (VTID-03579)
 *
 * The only thing that stopped a finding being re-planned was the EXISTENCE of a
 * plan_versions row. A finding whose plan generation FAILED therefore looked
 * identical to one nobody had tried yet, and came back on the next 30-second
 * tick forever.
 *
 * Measured on prod 2026-08-10/11: 12 findings, 19-38 consecutive plan_gen
 * failures each over ~40 hours, 990 planner LLM calls in one day, 863 billed to
 * Gemini. Not one produced a plan.
 *
 * What makes this worth a dedicated test file: the symptom was already known.
 * writeAutopilotFailure() carries a 10-minute dedup window whose own comment
 * names "lazyPlanTick re-firing the same plan_gen failure every ~30s" as the
 * thing it suppresses. That silenced the log and left the loop spending money.
 * The policy now lives in a pure function so it can be asserted directly rather
 * than inferred from a tick's side effects.
 */

import {
  planRetryDecision,
  findingVtid,
} from '../src/services/dev-autopilot-execute';

const MIN = 60 * 1000;
const NOW = 1_760_000_000_000;

describe('planRetryDecision (VTID-03579)', () => {
  it('allows a finding that has never failed', () => {
    expect(planRetryDecision(0, null, NOW)).toEqual({ attempt: true });
  });

  it('treats a missing timestamp as no history rather than blocking', () => {
    // Defensive: a row with an unparseable created_at must not wedge planning.
    expect(planRetryDecision(3, null, NOW).attempt).toBe(true);
  });

  it('holds a finding back immediately after its first failure', () => {
    const d = planRetryDecision(1, NOW - 1 * MIN, NOW);
    expect(d.attempt).toBe(false);
    expect(d.reason).toBe('backoff');
  });

  it('waits at least the 10-minute dedup window on the first failure', () => {
    // Base is deliberately the writer's dedup window: prod records at most one
    // failure row per 10 minutes, so a shorter backoff cannot be observed in
    // the very data this decision reads.
    expect(planRetryDecision(1, NOW - 9 * MIN, NOW).attempt).toBe(false);
    expect(planRetryDecision(1, NOW - 11 * MIN, NOW).attempt).toBe(true);
  });

  it('doubles the wait with each successive failure', () => {
    // 2 failures -> 20 min, 3 -> 40 min. The point is that a persistently
    // broken finding costs geometrically less, instead of one call every 30s.
    expect(planRetryDecision(2, NOW - 15 * MIN, NOW).attempt).toBe(false);
    expect(planRetryDecision(2, NOW - 25 * MIN, NOW).attempt).toBe(true);
    expect(planRetryDecision(3, NOW - 35 * MIN, NOW).attempt).toBe(false);
    expect(planRetryDecision(3, NOW - 45 * MIN, NOW).attempt).toBe(true);
  });

  it('stops retrying entirely once failures are chronic', () => {
    // Every finding in the prod incident had 19-38 failures. Backoff alone
    // would still pay for a call every 6 hours forever; a finding failing this
    // consistently needs a human or a code change, not more LLM spend.
    const d = planRetryDecision(6, NOW - 30 * 24 * 60 * MIN, NOW);
    expect(d.attempt).toBe(false);
    expect(d.reason).toBe('exhausted');
  });

  it('stays exhausted no matter how much time passes', () => {
    expect(planRetryDecision(38, NOW - 365 * 24 * 60 * MIN, NOW).reason).toBe('exhausted');
  });

  it('caps the backoff so the wait cannot overflow into absurdity', () => {
    // 5 failures would be 160 min uncapped; the cap is 6h and only binds at
    // higher counts, but the arithmetic must never produce Infinity/NaN.
    const d = planRetryDecision(5, NOW - 7 * 60 * MIN, NOW);
    expect(d.attempt).toBe(true);
    const held = planRetryDecision(5, NOW - 1 * MIN, NOW);
    expect(held.attempt).toBe(false);
    expect(held.waitMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    expect(Number.isFinite(held.waitMs!)).toBe(true);
  });

  it('would have suppressed the real prod incident', () => {
    // VTID-DA-FIND-b7ff0b51: 38 failure rows. Under the old code every 30s tick
    // spent another planner call on it. Under this policy it is left alone.
    expect(planRetryDecision(38, NOW - 5 * MIN, NOW).attempt).toBe(false);
  });
});

describe('findingVtid (VTID-03579)', () => {
  it('matches the key writeAutopilotFailure records against', () => {
    // The backoff lookup joins failure history to findings on this string. If
    // it ever diverges from the planner's own `VTID-DA-FIND-${id.slice(0,8)}`,
    // every lookup silently misses and the backoff quietly stops working —
    // which looks exactly like the bug it fixes.
    expect(findingVtid('b7ff0b51-1234-4321-abcd-000000000000')).toBe('VTID-DA-FIND-b7ff0b51');
    expect(findingVtid('332234cd')).toBe('VTID-DA-FIND-332234cd');
  });
});

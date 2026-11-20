/**
 * VTID-05737 (agentic-delivery-scope/dispatcher): the retry schedule and eligibility as pure functions.
 * Plan agentic-delivery-scope §5: backoff 15/30/60/120/240/480 min, at most 6 attempts in 24 h, the 7th is blocked with
 * next_actor owner; security / data loss / production write / protected file without its reviews / escalated sparring
 * are never retried.
 */
import {
  RETRY_BACKOFF_MINUTES,
  RETRY_MAX_ATTEMPTS,
  RETRY_WINDOW_MS,
  isRetryable,
  nextRetry,
  type RetryAttempt,
  type RetryLane,
} from '../../src/services/project-manager/retry';

const MIN = 60_000;
const T0 = Date.parse('2026-11-18T10:00:00Z');
const lane = (over: Partial<RetryLane> = {}): RetryLane => ({ slug: 'plan-x', lane: 'lane-a', parked_at_ms: T0, reason: 'ci_failed_3_consecutive', ...over });

describe('retry constants', () => {
  it('pins the schedule, the attempt cap and the window from the plan', () => {
    expect([...RETRY_BACKOFF_MINUTES]).toEqual([15, 30, 60, 120, 240, 480]);
    expect(RETRY_MAX_ATTEMPTS).toBe(6);
    expect(RETRY_WINDOW_MS).toBe(24 * 60 * MIN);
    expect(RETRY_BACKOFF_MINUTES.length).toBe(RETRY_MAX_ATTEMPTS);
  });
});

describe('isRetryable', () => {
  it.each(['ci_failed_3_consecutive', 'failed_check', 'model_tier_unavailable', 'missing_prerequisite', 'infra_failure'])('%s is retryable', (r) => {
    expect(isRetryable(r)).toBe(true);
  });
  it.each([
    'security_risk', 'data_loss_risk', 'production_write', 'protected_file_unreviewed', 'sparring_escalated',
    'reviewer_flagged_risk', 'stale_claim', 'something_new', '', null, undefined,
  ])('%s is never retried (fail closed)', (r) => {
    expect(isRetryable(r as string)).toBe(false);
  });
});

describe('nextRetry: the schedule', () => {
  it('the first attempt is due 15 min after the lane was parked', () => {
    const n = nextRetry(lane(), [], T0);
    expect(n).toMatchObject({ blocked: false, attempt: 1, at_ms: T0 + 15 * MIN });
    expect((n as { at: string }).at).toBe(new Date(T0 + 15 * MIN).toISOString());
  });

  it('each next attempt is due its backoff after the previous attempt', () => {
    const history: RetryAttempt[] = [];
    let last = T0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const n = nextRetry(lane(), history, last);
      expect(n.blocked).toBe(false);
      if (n.blocked) throw new Error('unreachable');
      expect(n.attempt).toBe(i + 1);
      expect(n.at_ms).toBe(last + RETRY_BACKOFF_MINUTES[i] * MIN);
      seen.push((n.at_ms - last) / MIN);
      history.push({ attempt: n.attempt, at_ms: n.at_ms });
      last = n.at_ms;
    }
    expect(seen).toEqual([15, 30, 60, 120, 240, 480]);
  });

  it('the 7th attempt inside 24 h is blocked with next_actor owner', () => {
    const history: RetryAttempt[] = [];
    let t = T0;
    for (let i = 0; i < 6; i++) { t += RETRY_BACKOFF_MINUTES[i] * MIN; history.push({ attempt: i + 1, at_ms: t }); }
    expect(t - T0).toBeLessThan(RETRY_WINDOW_MS);
    expect(nextRetry(lane(), history, t)).toEqual({ blocked: true, reason: 'attempts_exhausted', next_actor: 'owner', attempts: 6 });
  });

  it('attempts older than 24 h no longer count, so a lane parked again a day later starts over', () => {
    const old: RetryAttempt[] = Array.from({ length: 6 }, (_, i) => ({ attempt: i + 1, at_ms: T0 + i * MIN }));
    const now = T0 + RETRY_WINDOW_MS + 10 * MIN;
    const n = nextRetry(lane({ parked_at_ms: now }), old, now);
    expect(n).toMatchObject({ blocked: false, attempt: 1, at_ms: now + 15 * MIN });
  });

  it('counts only the attempts inside the window and backs off from the newest of them', () => {
    const now = T0 + RETRY_WINDOW_MS;
    const history: RetryAttempt[] = [
      { attempt: 1, at_ms: now - RETRY_WINDOW_MS - 1 * MIN }, // 1 min older than the window: ignored
      { attempt: 2, at_ms: now - 100 * MIN },
      { attempt: 3, at_ms: now - 30 * MIN },
    ];
    const n = nextRetry(lane(), history, now);
    expect(n).toMatchObject({ blocked: false, attempt: 3, at_ms: now - 30 * MIN + 60 * MIN });
  });

  it('does not depend on the order of the history', () => {
    const a: RetryAttempt[] = [{ attempt: 1, at_ms: T0 + 15 * MIN }, { attempt: 2, at_ms: T0 + 45 * MIN }];
    const now = T0 + 50 * MIN;
    expect(nextRetry(lane(), [...a].reverse(), now)).toEqual(nextRetry(lane(), a, now));
  });
});

describe('nextRetry: never retried', () => {
  it.each(['security_risk', 'data_loss_risk', 'production_write', 'protected_file_unreviewed', 'sparring_escalated'])('%s is blocked at once', (reason) => {
    expect(nextRetry(lane({ reason }), [], T0)).toEqual({ blocked: true, reason: 'not_retryable', next_actor: 'owner', attempts: 0 });
  });
  it('a lane with no recorded reason is not retried', () => {
    expect(nextRetry(lane({ reason: null }), [], T0)).toMatchObject({ blocked: true, reason: 'not_retryable' });
  });
  it('unusable times block instead of throwing', () => {
    expect(nextRetry(lane({ parked_at_ms: Number.NaN }), [], T0)).toMatchObject({ blocked: true, reason: 'invalid_input' });
    expect(nextRetry(lane(), [], Number.NaN)).toMatchObject({ blocked: true, reason: 'invalid_input' });
    expect(nextRetry(lane(), [{ attempt: 1, at_ms: Number.NaN }], T0)).toMatchObject({ blocked: true, reason: 'invalid_input' });
  });
});

describe('nextRetry: purity', () => {
  it('does not change its inputs and returns the same answer twice', () => {
    const l = lane();
    const h: RetryAttempt[] = [{ attempt: 1, at_ms: T0 + 15 * MIN }];
    const snapshot = JSON.stringify([l, h]);
    const a = nextRetry(l, h, T0 + 20 * MIN);
    const b = nextRetry(l, h, T0 + 20 * MIN);
    expect(a).toEqual(b);
    expect(JSON.stringify([l, h])).toBe(snapshot);
  });
});

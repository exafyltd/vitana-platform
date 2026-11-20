/**
 * VTID-05737 (agentic-delivery-scope/dispatcher): retry with backoff instead of questions.
 *
 * The PM unparks a parked lane that has a retryable reason, on a fixed backoff, at most 6 times in 24 hours; after the 6th
 * attempt the lane stays parked with `next_actor: owner` and the change is recorded as blocked (plan agentic-delivery-scope §5,
 * agentic-delivery-v2 §20). Everything here is a pure function: no I/O, no clock. The current time is an argument, like every
 * other PM decide function (`types.ts` header).
 *
 *   schedule    attempt n is due RETRY_BACKOFF_MINUTES[n-1] after the previous attempt (the first: after the lane was parked)
 *   window      only attempts of the last 24 h count; a lane parked again a day later starts over
 *   retryable   a failed check, a model tier that is unavailable, a missing prerequisite, an infrastructure failure
 *   never       security or data-loss risk, a production write, a protected-file merge without its reviews, an escalated
 *               sparring verdict, and any reason this module does not know (fail closed)
 */

/** Minutes to wait before attempt 1..6. The sum is 945 min (15 h 45 min), so all six fit in the 24 h window. */
export const RETRY_BACKOFF_MINUTES: readonly number[] = Object.freeze([15, 30, 60, 120, 240, 480]);
/** At most this many attempts inside RETRY_WINDOW_MS. */
export const RETRY_MAX_ATTEMPTS = 6;
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

const MIN_MS = 60_000;

/** Reasons a parked lane may be retried. `ci_failed_3_consecutive` is the PM's own "failed check" park reason. */
const RETRYABLE: ReadonlySet<string> = new Set([
  'ci_failed_3_consecutive',
  'failed_check',
  'model_tier_unavailable',
  'missing_prerequisite',
  'infra_failure',
]);

/** The parked lane as the retry rule sees it. */
export interface RetryLane {
  slug: string;
  lane: string;
  /** When the lane was parked, epoch ms. */
  parked_at_ms: number;
  /** The park reason, or null when none is recorded (then the lane is never retried). */
  reason: string | null;
}

/** One attempt already made (a `retry attempt N` lane-log entry, or a `delivery.retry.scheduled` event). */
export interface RetryAttempt {
  attempt: number;
  at_ms: number;
}

export type NextRetry =
  | { blocked: false; attempt: number; at: string; at_ms: number }
  | { blocked: true; reason: 'not_retryable' | 'attempts_exhausted' | 'invalid_input'; next_actor: 'owner'; attempts: number };

/** Is a lane parked for this reason ever retried by the machine? Unknown reasons are not. */
export function isRetryable(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && RETRYABLE.has(reason);
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const blocked = (reason: 'not_retryable' | 'attempts_exhausted' | 'invalid_input', attempts: number): NextRetry =>
  ({ blocked: true, reason, next_actor: 'owner', attempts });

/**
 * The next attempt for a parked lane, or why there is none. `at_ms` is when the attempt is due; the caller acts
 * when `at_ms <= nowMs` (`retryDue`). The history may be in any order and may hold attempts older than the window.
 */
export function nextRetry(lane: RetryLane, history: readonly RetryAttempt[], nowMs: number): NextRetry {
  if (!finite(nowMs) || !finite(lane.parked_at_ms) || history.some((h) => !finite(h.at_ms))) return blocked('invalid_input', 0);
  const recent = history.filter((h) => nowMs - h.at_ms < RETRY_WINDOW_MS);
  if (!isRetryable(lane.reason)) return blocked('not_retryable', recent.length);
  if (recent.length >= RETRY_MAX_ATTEMPTS) return blocked('attempts_exhausted', recent.length);
  const base = recent.length === 0 ? lane.parked_at_ms : Math.max(...recent.map((h) => h.at_ms));
  const at_ms = base + RETRY_BACKOFF_MINUTES[recent.length] * MIN_MS;
  return { blocked: false, attempt: recent.length + 1, at: new Date(at_ms).toISOString(), at_ms };
}

/** Is a scheduled attempt due now? */
export function retryDue(next: NextRetry, nowMs: number): boolean {
  return !next.blocked && finite(nowMs) && next.at_ms <= nowMs;
}

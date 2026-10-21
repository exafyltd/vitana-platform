/**
 * VTID-04164: in-process rate limit for the Operator Console execution
 * on-ramp (`autopilot_run_task` / `autopilot_execute_task`).
 *
 * An operator chat thread deciding to queue execution after execution is a
 * real way to flood the executor: each queued call allocates/uses a VTID and
 * enters the Dev Autopilot lane which writes code and opens PRs. This caps a
 * single thread at 5 queued calls in any rolling 60-second window, so a
 * runaway tool-calling loop (or a double-clicked button) is refused instead
 * of fanning out.
 *
 * Deliberately a small, deterministic sliding-window counter rather than a
 * distributed/store-backed limiter: the on-ramp is a single gateway process
 * today, and the point here is a cheap guard, not a cluster-wide quota. The
 * factory is pure with respect to time — `check(key, nowMs)` takes the clock
 * as an argument — which is what makes it independently testable without
 * fake timers or a running gateway.
 */

export const ONRAMP_RATE_LIMIT_MAX_CALLS = 5;
export const ONRAMP_RATE_LIMIT_WINDOW_MS = 60_000;

export interface OnRampRateLimitResult {
  /** true when this call is inside the limit and has been counted. */
  allowed: boolean;
  /** Calls counted in the window (including this one when allowed). */
  count: number;
  limit: number;
  window_ms: number;
  /** Milliseconds until the oldest counted call leaves the window. 0 when allowed. */
  retry_after_ms: number;
}

export interface SlidingWindowLimiter {
  /** Count-and-decide for `key`. Only an allowed call is recorded. */
  check(key: string, nowMs?: number): OnRampRateLimitResult;
  /** Drop all state (used by tests to isolate cases). */
  reset(): void;
}

/**
 * Rolling-window (sliding-window) counter: keeps the timestamps of the
 * allowed calls per key and prunes anything older than `windowMs`. No timer,
 * no interval, no background work — expired entries are dropped on read.
 */
export function createSlidingWindowLimiter(opts: {
  limit: number;
  windowMs: number;
}): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string, nowMs: number = Date.now()): OnRampRateLimitResult {
      const cutoff = nowMs - opts.windowMs;
      const inWindow = (hits.get(key) || []).filter((t) => t > cutoff);

      if (inWindow.length >= opts.limit) {
        // Refused calls are NOT counted — otherwise an abuser would push the
        // window forward forever and never recover.
        if (inWindow.length > 0) hits.set(key, inWindow);
        return {
          allowed: false,
          count: inWindow.length,
          limit: opts.limit,
          window_ms: opts.windowMs,
          retry_after_ms: Math.max(1, inWindow[0] + opts.windowMs - nowMs),
        };
      }

      inWindow.push(nowMs);
      hits.set(key, inWindow);
      return {
        allowed: true,
        count: inWindow.length,
        limit: opts.limit,
        window_ms: opts.windowMs,
        retry_after_ms: 0,
      };
    },

    reset(): void {
      hits.clear();
    },
  };
}

/**
 * Format the refusal. Names the limit, the window, and how long until the
 * window resets — the operator-facing reason has to be actionable.
 */
export function describeOnRampRateLimit(result: OnRampRateLimitResult): string {
  const seconds = Math.max(1, Math.ceil(result.retry_after_ms / 1000));
  const windowSeconds = Math.round(result.window_ms / 1000);
  return (
    `operator_onramp_rate_limited: limit is ${result.limit} on-ramp executions (autopilot_run_task / ` +
    `autopilot_execute_task) per ${windowSeconds}s per thread — try again in ${seconds}s`
  );
}

const limiter = createSlidingWindowLimiter({
  limit: ONRAMP_RATE_LIMIT_MAX_CALLS,
  windowMs: ONRAMP_RATE_LIMIT_WINDOW_MS,
});

/** Count-and-decide for one Operator Console thread. */
export function checkOnRampRateLimit(threadId: string, nowMs?: number): OnRampRateLimitResult {
  return limiter.check(threadId, nowMs);
}

/** Test-only: clear the process-wide counter. */
export function resetOnRampRateLimit(): void {
  limiter.reset();
}

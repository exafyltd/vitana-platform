/**
 * VTID-04243: refuse to re-approve a finding after a turn-cap failure.
 *
 * AUTO_RETRY_CAP (5 terminal failures / 24 h) bounds the retry loop; it
 * does not prevent it. Live 2026-09-21 (docs/validation/VTID-04237/): the
 * npm-audit finding failed on the agent's turn cap, autoApproveTick
 * re-approved it within one tick, and the chain burned ≈5.5 M DeepSeek
 * input tokens per attempt — three attempts before the owner asked for a
 * cheaper breaker. A turn-cap exit means the agent could not finish the
 * task with the tools it has; re-running the identical plan on the
 * identical tool surface produces the identical exhaustion. One such
 * failure is therefore terminal for auto-approve: the finding is snoozed
 * 7 days (the same lever the retry cap uses) and an operator can unsnooze
 * it once the plan, scope or tool surface changes.
 *
 * The signal is the failure reason the runner stores on the row
 * (`metadata.error`): `agent hit the N-turn cap without calling finish`
 * (agent-loop.ts) — matched by shape, not by the number, so the fix-round
 * variant (`2-turn cap`, VTID-04244) and any future cap size count too.
 */

// VTID-04394: a run stopped by the progress ledger (`agent stalled: …`) is
// the same class — the agent could not finish this finding — so it trips
// the breaker too.
// VTID-04466: a run stopped by the exploration budget (no edit by the
// hand-off point) is the same class too.
export const TURN_CAP_FAILURE_RE = /\bturn cap\b|\bmax turns reached\b|\bagent stalled\b|\bexploration budget\b/i;

export function isTurnCapFailure(metadata: Record<string, unknown> | null | undefined): boolean {
  const err = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).error : null;
  return typeof err === 'string' && TURN_CAP_FAILURE_RE.test(err);
}

/** True when any terminal-failure row of the finding died on the turn cap. */
export function hasTurnCapFailure(rows: Array<{ metadata?: Record<string, unknown> | null }> | null | undefined): boolean {
  if (!rows || !Array.isArray(rows)) return false;
  return rows.some((r) => isTurnCapFailure(r?.metadata));
}

/**
 * VTID-04368: provider outages are not the finding's fault.
 *
 * Live 2026-09-22 22:00 → 09-23 11:27 UTC: the AWS account block made every
 * Bedrock call fail with "Operation not allowed" and DeepSeek answered 402
 * "Insufficient Balance", so every execution died on its first LLM call. The
 * IMPACT auto-approve pass had no retry cap at all and re-approved one finding
 * 461 times in 12 h; the baseline pass would have snoozed every finding 7 days
 * for an outage that had nothing to do with them. Two rules follow:
 *   1. an outage failure never counts toward a finding's retry cap;
 *   2. while the newest terminal failures are all outages, the loop stops
 *      approving and claiming, then probes with one execution at a time.
 * VTID-04467: an executor task that could not be started (ECS refused
 * RunTask) is the same class — infrastructure, not the finding.
 */
export const PROVIDER_OUTAGE_RE =
  /both providers failed|Insufficient Balance|Operation not allowed|account is currently blocked|executor task could not be started/i;

export const AUTO_RETRY_CAP = 5;
export const OUTAGE_WINDOW_MS = 30 * 60 * 1000;
export const OUTAGE_STREAK = 3;

function errorOf(metadata: Record<string, unknown> | null | undefined): string | null {
  const err = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).error : null;
  return typeof err === 'string' ? err : null;
}

export function isProviderOutageFailure(metadata: Record<string, unknown> | null | undefined): boolean {
  const err = errorOf(metadata);
  return err !== null && PROVIDER_OUTAGE_RE.test(err);
}

/** Terminal failures that are the finding's own (outage failures excluded). */
export function findingOwnedFailures<T extends { metadata?: Record<string, unknown> | null }>(
  rows: T[] | null | undefined,
): T[] {
  if (!rows || !Array.isArray(rows)) return [];
  return rows.filter((r) => !isProviderOutageFailure(r?.metadata));
}

export type RetryBreakerDecision = 'admit' | 'snooze_turn_cap' | 'snooze_retry_cap';

/** One decision for both auto-approve passes, from the finding's 24 h terminal failures. */
export function decideRetryBreaker(
  rows: Array<{ metadata?: Record<string, unknown> | null }> | null | undefined,
): RetryBreakerDecision {
  const owned = findingOwnedFailures(rows);
  if (hasTurnCapFailure(owned)) return 'snooze_turn_cap';
  if (owned.length >= AUTO_RETRY_CAP) return 'snooze_retry_cap';
  return 'admit';
}

export type OutageState = 'clear' | 'probe' | 'outage';

/**
 * From the newest terminal executions (newest first):
 *   outage — the newest OUTAGE_STREAK are all outage failures and the newest
 *            is inside OUTAGE_WINDOW_MS: approve and claim nothing;
 *   probe  — the newest is an outage failure but the streak/window rule does
 *            not hold: approve and claim at most one, to find out;
 *   clear  — otherwise.
 */
export function detectProviderOutage(
  newestFirst: Array<{ updated_at: string; metadata?: Record<string, unknown> | null }> | null | undefined,
  nowMs: number = Date.now(),
): OutageState {
  if (!newestFirst || newestFirst.length === 0) return 'clear';
  const newest = newestFirst[0];
  if (!isProviderOutageFailure(newest.metadata)) return 'clear';
  const streak = newestFirst.slice(0, OUTAGE_STREAK);
  const recent = nowMs - Date.parse(newest.updated_at) <= OUTAGE_WINDOW_MS;
  if (recent && streak.length >= OUTAGE_STREAK && streak.every((r) => isProviderOutageFailure(r.metadata))) {
    return 'outage';
  }
  return 'probe';
}

/** Slots allowed this tick under an outage state. */
export function slotsUnderOutage(state: OutageState, slots: number): number {
  if (state === 'outage') return 0;
  if (state === 'probe') return Math.min(1, slots);
  return slots;
}

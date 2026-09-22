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

export const TURN_CAP_FAILURE_RE = /\bturn cap\b|\bmax turns reached\b/i;

export function isTurnCapFailure(metadata: Record<string, unknown> | null | undefined): boolean {
  const err = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).error : null;
  return typeof err === 'string' && TURN_CAP_FAILURE_RE.test(err);
}

/** True when any terminal-failure row of the finding died on the turn cap. */
export function hasTurnCapFailure(rows: Array<{ metadata?: Record<string, unknown> | null }> | null | undefined): boolean {
  if (!rows || !Array.isArray(rows)) return false;
  return rows.some((r) => isTurnCapFailure(r?.metadata));
}

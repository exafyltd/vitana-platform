/**
 * VTID-04244: each fix round gets its own turn floor.
 *
 * run-agent-execution.ts budgets every round as `AGENT_MAX_TURNS -
 * totalTurns`. Live 2026-09-21 (docs/validation/VTID-04237/): two runs
 * called `finish` at turn 118 of 120, the post-hoc scope check rejected
 * their diff, and the fix round opened with maxTurns = 2 — the model edited
 * twice and died on "agent hit the 2-turn cap". A run that finishes near the
 * cap had no repair budget at all, so AGENT_MAX_FIX_ROUNDS was effectively
 * zero exactly when it was needed.
 *
 * Round 0 keeps the full cap. Every later round gets at least
 * `AGENT_FIX_ROUND_MIN_TURNS` (default 15) even if the first round consumed
 * everything — a bounded overrun (≤ AGENT_MAX_FIX_ROUNDS × floor) in
 * exchange for fix rounds that can actually fix. The wall-clock deadline is
 * unchanged and still bounds the whole execution.
 */

export const DEFAULT_FIX_ROUND_MIN_TURNS = 15;

export function resolveFixRoundMinTurns(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.AGENT_FIX_ROUND_MIN_TURNS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FIX_ROUND_MIN_TURNS;
}

export function fixRoundTurnBudget(round: number, maxTurns: number, totalTurns: number, minTurns: number = DEFAULT_FIX_ROUND_MIN_TURNS): number {
  const remaining = Math.max(0, maxTurns - totalTurns);
  if (round <= 0) return Math.max(1, remaining);
  return Math.max(minTurns, remaining);
}

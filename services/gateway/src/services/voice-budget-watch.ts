/**
 * Voice instruction budget watch — Phase D (ORB Memory Resilience observability).
 *
 * See heavy users *before* they break. Phase A caps the bootstrap so nobody can
 * overflow Vertex setup; Phase D surfaces WHO is approaching the cap so the team can
 * prune / consolidate proactively instead of waiting for a "Vitana won't talk" report.
 *
 * The pure helpers here (pct-of-cap, classification) are unit-tested in isolation.
 * `fetchVoiceBudgetWatch` runs the aggregation query; it is exercised against a mocked
 * Supabase client (no live DB in CI).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Character budget a user's memory is measured against. Kept in lock-step with the
 * Phase A `BOOTSTRAP_CONTEXT_MAX_CHARS` cap in
 * `orb/live/instruction/bootstrap-cap.ts`. Defined locally (not imported) so the
 * observability stream (Phase D) builds independently of the Phase A branch.
 */
export const BUDGET_CAP_CHARS = 12_000;

/** At/above this % of the cap a user is "at risk" (warn). */
export const AT_RISK_PCT = 70;
/** At/above this % of the cap a user is "overflow" (severe — would be trimmed). */
export const OVERFLOW_PCT = 100;

export type BudgetSeverity = 'ok' | 'at_risk' | 'overflow';

export interface VoiceBudgetRow {
  user_id: string;
  vitana_id: string | null;
  display_name: string | null;
  memory_items: number;
  memory_chars: number;
  memory_facts: number;
  pct_of_cap: number;
  severity: BudgetSeverity;
}

export interface VoiceBudgetQueryOptions {
  limit?: number;
  minPct?: number;
}

/** Percentage of the budget cap a given memory-char total represents (1 decimal). */
export function computePctOfCap(memoryChars: number, cap: number = BUDGET_CAP_CHARS): number {
  if (cap <= 0) return 0;
  return Math.round((1000 * memoryChars) / cap) / 10; // one decimal place
}

/** Classify a percentage-of-cap into a severity bucket. */
export function classifyBudget(pctOfCap: number): BudgetSeverity {
  if (pctOfCap >= OVERFLOW_PCT) return 'overflow';
  if (pctOfCap >= AT_RISK_PCT) return 'at_risk';
  return 'ok';
}

/**
 * Shape a raw aggregation row (snake_case from SQL) into a typed VoiceBudgetRow with a
 * derived severity. Tolerant of string/number/null inputs from the driver.
 */
export function toVoiceBudgetRow(raw: Record<string, unknown>): VoiceBudgetRow {
  const memoryChars = Number(raw.memory_chars ?? 0) || 0;
  const pct =
    raw.pct_of_cap != null ? Number(raw.pct_of_cap) || 0 : computePctOfCap(memoryChars);
  return {
    user_id: String(raw.user_id ?? ''),
    vitana_id: raw.vitana_id != null ? String(raw.vitana_id) : null,
    display_name: raw.display_name != null ? String(raw.display_name) : null,
    memory_items: Number(raw.memory_items ?? 0) || 0,
    memory_chars: memoryChars,
    memory_facts: Number(raw.memory_facts ?? 0) || 0,
    pct_of_cap: pct,
    severity: classifyBudget(pct),
  };
}

/**
 * SQL for the top-N users by memory-budget usage. Parameterised via an RPC-style call
 * so we never string-interpolate user input. Kept here so the route + cron share one
 * definition of "budget usage".
 */
export const VOICE_BUDGET_WATCH_SQL = `
  SELECT
    u.user_id,
    u.vitana_id,
    u.display_name,
    COUNT(mi.id) AS memory_items,
    COALESCE(SUM(LENGTH(mi.content)), 0) AS memory_chars,
    (SELECT COUNT(*) FROM memory_facts mf WHERE mf.user_id = u.user_id) AS memory_facts,
    ROUND(100.0 * COALESCE(SUM(LENGTH(mi.content)), 0) / $1, 1) AS pct_of_cap
  FROM app_users u
  LEFT JOIN memory_items mi ON mi.user_id = u.user_id
  GROUP BY u.user_id, u.vitana_id, u.display_name
  HAVING ROUND(100.0 * COALESCE(SUM(LENGTH(mi.content)), 0) / $1, 1) >= $2
  ORDER BY pct_of_cap DESC
  LIMIT $3
`;

/**
 * Fetch the voice-budget watch rows. Uses the `exec_sql` RPC convention if available;
 * callers in tests inject a mock that returns `{ data, error }`.
 */
export async function fetchVoiceBudgetWatch(
  supabase: SupabaseClient,
  opts: VoiceBudgetQueryOptions = {},
): Promise<VoiceBudgetRow[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const minPct = Math.max(0, opts.minPct ?? 10);

  const { data, error } = await supabase.rpc('exec_sql', {
    query: VOICE_BUDGET_WATCH_SQL,
    params: [BUDGET_CAP_CHARS, minPct, limit],
  });

  if (error) {
    throw new Error(`voice-budget-watch query failed: ${error.message ?? String(error)}`);
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => toVoiceBudgetRow(r as Record<string, unknown>));
}

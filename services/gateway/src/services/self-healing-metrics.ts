/**
 * Self-Healing observability metrics (Step 5).
 *
 * Steps 1–4 changed how the self-healing loop *behaves* (auto-approval,
 * non-actionable classification, verify-and-rollback, per-stage retry
 * calibration) but nothing surfaced whether those changes are actually
 * working. This module aggregates the rows the loop already writes —
 * `self_healing_log` and `dev_autopilot_executions` — into a single metrics
 * object the dashboard / an operator can read to answer:
 *
 *   - Are auto-fixes landing? (self-healing resolved-rate, autopilot success-rate)
 *   - Why aren't they? (escalations broken down by failure class + stage)
 *   - How much of the queue is infra/policy noise vs genuinely fixable?
 *     (the actionable split from Step 2's tagging)
 *
 * The aggregation is a pure function over the fetched rows so it is unit-
 * testable without Supabase; the route handler only fetches + calls it.
 */

export interface SelfHealingLogRow {
  outcome?: string | null;
  failure_class?: string | null;
  confidence?: number | string | null;
  attempt_number?: number | null;
  created_at?: string | null;
  diagnosis?: {
    actionable?: boolean;
    non_actionable_reason?: string | null;
    [k: string]: unknown;
  } | null;
}

export interface AutopilotExecRow {
  status?: string | null;
  failure_stage?: string | null;
  created_at?: string | null;
}

export interface SelfHealingMetrics {
  window_days: number;
  generated_at: string;
  self_healing: {
    total: number;
    by_outcome: Record<string, number>;
    /** Step 2 tagging: how much of the queue is fixable vs infra/policy noise. */
    actionable: { actionable: number; non_actionable: number; unknown: number };
    non_actionable_reasons: Record<string, number>;
    /** outcome='escalated' rows broken down by failure_class — why fixes aren't landing. */
    escalations_by_class: Record<string, number>;
    /** fixed / (fixed + failed + escalated + rolled_back). 0 when no terminal rows. */
    resolved_rate: number;
    /** mean triage confidence per outcome — sanity-checks the Step 4 calibration. */
    avg_confidence_by_outcome: Record<string, number>;
  };
  dev_autopilot: {
    total: number;
    by_status: Record<string, number>;
    completed: number;
    /** failed + reverted + failed_escalated. */
    failed: number;
    /** completed / (completed + failed). 0 when no terminal executions. */
    success_rate: number;
    /** where terminal failures occurred (ci / deploy / verification). */
    failure_stage_breakdown: Record<string, number>;
  };
}

/** Self-healing outcomes that count as a successful auto-fix. */
const SH_SUCCESS = new Set(['fixed']);
/** Self-healing outcomes that count as a terminal failure of the fix. */
const SH_TERMINAL_FAIL = new Set(['failed', 'escalated', 'rolled_back']);
/** Autopilot execution statuses that are terminal failures. */
const EXEC_FAIL = new Set(['failed', 'reverted', 'failed_escalated']);

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Aggregate the raw rows into the metrics object. Pure — given the same rows it
 * always returns the same result. `windowDays` and `now` are echoed/derived for
 * the response envelope only.
 */
export function aggregateSelfHealingMetrics(
  logs: SelfHealingLogRow[],
  execs: AutopilotExecRow[],
  windowDays: number,
  now: Date = new Date(),
): SelfHealingMetrics {
  const byOutcome: Record<string, number> = {};
  const nonActionableReasons: Record<string, number> = {};
  const escalationsByClass: Record<string, number> = {};
  const actionable = { actionable: 0, non_actionable: 0, unknown: 0 };

  // Running confidence sums per outcome for the average.
  const confSum: Record<string, number> = {};
  const confCount: Record<string, number> = {};

  let shSuccess = 0;
  let shTerminalFail = 0;

  for (const row of logs) {
    const outcome = row.outcome || '(none)';
    inc(byOutcome, outcome);

    if (SH_SUCCESS.has(outcome)) shSuccess++;
    else if (SH_TERMINAL_FAIL.has(outcome)) shTerminalFail++;

    // Step 2 actionable split (from the diagnosis jsonb tag).
    const act = row.diagnosis?.actionable;
    if (act === true) actionable.actionable++;
    else if (act === false) actionable.non_actionable++;
    else actionable.unknown++;

    const reason = row.diagnosis?.non_actionable_reason;
    if (typeof reason === 'string' && reason) inc(nonActionableReasons, reason);

    if (outcome === 'escalated') inc(escalationsByClass, row.failure_class || '(none)');

    const c = toNum(row.confidence);
    if (c !== null) {
      confSum[outcome] = (confSum[outcome] || 0) + c;
      confCount[outcome] = (confCount[outcome] || 0) + 1;
    }
  }

  const avgConfidenceByOutcome: Record<string, number> = {};
  for (const k of Object.keys(confCount)) {
    avgConfidenceByOutcome[k] = round(confSum[k] / confCount[k]);
  }

  const shTerminal = shSuccess + shTerminalFail;

  // ── dev_autopilot executions ──
  const byStatus: Record<string, number> = {};
  const failureStageBreakdown: Record<string, number> = {};
  let completed = 0;
  let execFailed = 0;
  for (const e of execs) {
    const status = e.status || '(none)';
    inc(byStatus, status);
    if (status === 'completed') completed++;
    else if (EXEC_FAIL.has(status)) {
      execFailed++;
      if (e.failure_stage) inc(failureStageBreakdown, e.failure_stage);
    }
  }
  const execTerminal = completed + execFailed;

  return {
    window_days: windowDays,
    generated_at: now.toISOString(),
    self_healing: {
      total: logs.length,
      by_outcome: byOutcome,
      actionable,
      non_actionable_reasons: nonActionableReasons,
      escalations_by_class: escalationsByClass,
      resolved_rate: shTerminal === 0 ? 0 : round(shSuccess / shTerminal),
      avg_confidence_by_outcome: avgConfidenceByOutcome,
    },
    dev_autopilot: {
      total: execs.length,
      by_status: byStatus,
      completed,
      failed: execFailed,
      success_rate: execTerminal === 0 ? 0 : round(completed / execTerminal),
      failure_stage_breakdown: failureStageBreakdown,
    },
  };
}

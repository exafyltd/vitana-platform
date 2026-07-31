/**
 * VTID-03460 — Watcher Phase 1: source → WatcherStep normalizers.
 *
 * Pure functions. No I/O, no clock reads, no randomness — the observer
 * rescans an overlap window every tick, so a normalizer must map the same
 * source row to the same step row every single time or idempotency breaks.
 *
 * =============================================================================
 * Why this is an ALLOWLIST and not a prefix match
 * =============================================================================
 * `autopilot.*` in this codebase is TWO unrelated systems:
 *
 *   1. DEV autopilot — `dev_autopilot.*`, plus `autopilot.state.*`. This is
 *      the development lifecycle we care about. Low volume.
 *   2. USER-FACING autopilot — `autopilot.recommendation.*`,
 *      `autopilot.heartbeat.*`, `autopilot.health.stuck_task`,
 *      `vtid.daily_recompute.*`, `vtid.stage.{matches,topics,longevity,
 *      index,community_recs}.*`. Product runtime for community users.
 *      Very high volume — `autopilot.health.stuck_task` alone ran 2,692
 *      times in 45 days, and `vtid.live.*` (ORB voice) another ~1,400.
 *
 * A `topic LIKE 'autopilot%'` filter would bury the ~50 real development
 * steps under thousands of product-telemetry rows, and the timeline would be
 * useless on day one. Worse, it would silently get *more* wrong over time as
 * new product topics are added.
 *
 * So: nothing is observed unless it is named here. A development topic we
 * forgot is a visible gap in the timeline (findable, fixable). A product
 * topic we failed to exclude would be invisible pollution.
 *
 * Topic inventory verified against production `oasis_events`, 45-day window,
 * 2026-07-31. When you add a topic, check it against the real table first —
 * several plausible-sounding topics do not exist, and CLAUDE.md §6's own
 * documented event schema names a `type` column the table does not have
 * (the real discriminator is `topic`).
 */

import type {
  StepActor,
  StepOutcome,
  WatcherStep,
  WatcherStepName,
} from './types';

export const SOURCE_OASIS = 'oasis_events';
export const SOURCE_EXECUTIONS = 'dev_autopilot_executions';
export const SOURCE_SESSION = 'session_api';

/** Minimal shape the observer selects out of oasis_events. */
export interface OasisEventRow {
  id: string;
  topic: string | null;
  vtid: string | null;
  status: string | null;
  message: string | null;
  service: string | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Minimal shape the observer selects out of dev_autopilot_executions. */
export interface ExecutionRow {
  id: string;
  status: string;
  finding_id: string | null;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  failure_stage: string | null;
  self_healing_vtid: string | null;
  parent_execution_id: string | null;
  auto_fix_depth: number | null;
  updated_at: string;
}

interface TopicRule {
  step: WatcherStepName;
  /** Fixed outcome, or 'derive' to read it from the event's status field. */
  outcome: StepOutcome | 'derive';
  actor: StepActor;
}

/**
 * The allowlist. Exact topic → step mapping.
 *
 * Deliberately omitted, with reasons:
 *   worker_runner.registered / worker_runner.heartbeat — infra liveness, not
 *     work. CLAUDE.md §6: heartbeat ≠ event, and a timeline full of
 *     registrations tells you nothing about what happened to a task.
 *   dev_autopilot.scan.{started,completed} — the scanner sweeping for
 *     findings is upstream of any unit of work; it has no work_unit to
 *     attach to.
 *   autopilot.* (recommendation/heartbeat/health/intent/automation) and
 *     vtid.{daily_recompute,live,stage.matches,stage.topics,stage.longevity,
 *     stage.index,stage.community_recs}.* — user-facing product runtime.
 */
const TOPIC_RULES: Record<string, TopicRule> = {
  // --- planning -------------------------------------------------------------
  'dev_autopilot.plan.generated': { step: 'planned', outcome: 'success', actor: 'autopilot' },
  'dev_autopilot.plan.version_added': { step: 'planned', outcome: 'success', actor: 'autopilot' },
  'dev_autopilot.plan.failed': { step: 'planned', outcome: 'failure', actor: 'autopilot' },
  'vtid.spec.generate.requested': { step: 'planned', outcome: 'unknown', actor: 'autopilot' },
  'vtid.spec.generate.completed': { step: 'planned', outcome: 'success', actor: 'autopilot' },
  'vtid.spec.validation.completed': { step: 'validated', outcome: 'derive', actor: 'autopilot' },
  'vtid.spec.quality_check.passed': { step: 'validated', outcome: 'success', actor: 'autopilot' },
  'vtid.spec.approved': { step: 'planned', outcome: 'success', actor: 'human' },

  // --- execution: dev autopilot --------------------------------------------
  'dev_autopilot.execution.ci_passed': { step: 'ci', outcome: 'success', actor: 'ci' },
  'dev_autopilot.execution.ci_failed': { step: 'ci', outcome: 'failure', actor: 'ci' },
  'dev_autopilot.execution.pr_merged': { step: 'merged', outcome: 'success', actor: 'autopilot' },
  // Not a failure: the gate correctly declined to auto-merge (e.g. high risk).
  // Recording it as 'failed' would teach Phase 2 that a working safety gate is
  // a defect to be avoided.
  'dev_autopilot.execution.auto_merge_declined': { step: 'merged', outcome: 'skipped', actor: 'autopilot' },
  'dev_autopilot.execution.deployed': { step: 'deploying', outcome: 'success', actor: 'autopilot' },
  'dev_autopilot.execution.failed': { step: 'failed', outcome: 'failure', actor: 'autopilot' },
  'autopilot.state.failed': { step: 'failed', outcome: 'failure', actor: 'autopilot' },
  'autopilot.state.completed': { step: 'completed', outcome: 'success', actor: 'autopilot' },

  // --- execution: worker-runner (VTID-01200) -------------------------------
  'worker_runner.claimed': { step: 'queued', outcome: 'success', actor: 'worker-runner' },
  'worker_runner.claim_failed': { step: 'queued', outcome: 'failure', actor: 'worker-runner' },
  'worker_runner.routed': { step: 'running', outcome: 'unknown', actor: 'worker-runner' },
  'worker_runner.exec_started': { step: 'running', outcome: 'unknown', actor: 'worker-runner' },
  'worker_runner.exec_completed': { step: 'completed', outcome: 'derive', actor: 'worker-runner' },
  'worker_runner.error': { step: 'failed', outcome: 'failure', actor: 'worker-runner' },
  'worker_runner.terminalized': { step: 'terminalized', outcome: 'success', actor: 'worker-runner' },

  // --- deploy / verify ------------------------------------------------------
  'deploy.gateway.success': { step: 'deploying', outcome: 'success', actor: 'ci' },
  'vtid.stage.verification.start': { step: 'verified', outcome: 'unknown', actor: 'ci' },
  'vtid.stage.verification.failed': { step: 'verified', outcome: 'failure', actor: 'ci' },
  'vtid.stage.verification.error': { step: 'verified', outcome: 'failure', actor: 'ci' },
  // 'advisory' is a soft signal — verification ran and had something to say
  // but did not fail the gate. Neither success nor failure.
  'vtid.stage.verification.advisory': { step: 'verified', outcome: 'unknown', actor: 'ci' },

  // --- terminal -------------------------------------------------------------
  'vtid.lifecycle.completed': { step: 'completed', outcome: 'success', actor: 'unknown' },
  'vtid.execute.completed': { step: 'completed', outcome: 'success', actor: 'unknown' },
  'vtid.terminalize.success': { step: 'terminalized', outcome: 'success', actor: 'unknown' },
  'vtid.governance.terminalize_blocked': { step: 'escalated', outcome: 'failure', actor: 'unknown' },

  // --- self-healing ---------------------------------------------------------
  'self-healing.report.received': { step: 'escalated', outcome: 'unknown', actor: 'autopilot' },
  'self-healing.spec.generated': { step: 'escalated', outcome: 'success', actor: 'autopilot' },
  'self-healing.preflight.recovered': { step: 'reverted', outcome: 'success', actor: 'autopilot' },
  'self-healing.terminalize.blocked': { step: 'escalated', outcome: 'failure', actor: 'autopilot' },
};

/**
 * `vtid.stage.worker_<domain>.<result>` is emitted per worker domain
 * (worker_backend, worker_frontend, worker_ai, worker_memory, worker_infra,
 * worker_orchestrator) and there are too many combinations to enumerate by
 * hand without drifting. This is the one prefix rule, and it is tightly
 * anchored so it cannot swallow `vtid.stage.matches.*` or the other product
 * stages that share the `vtid.stage.` prefix.
 */
const WORKER_STAGE_RE = /^vtid\.stage\.(worker_[a-z_]+)\.(start|success|failed|claimed|released|route)$/;

const WORKER_STAGE_STEP: Record<string, { step: WatcherStepName; outcome: StepOutcome }> = {
  start: { step: 'running', outcome: 'unknown' },
  route: { step: 'running', outcome: 'unknown' },
  claimed: { step: 'queued', outcome: 'success' },
  released: { step: 'queued', outcome: 'skipped' },
  success: { step: 'running', outcome: 'success' },
  failed: { step: 'running', outcome: 'failure' },
};

/** Map an event's own `status` field onto a step outcome. */
export function deriveOutcome(status: string | null | undefined): StepOutcome {
  switch ((status || '').toLowerCase()) {
    case 'success':
    case 'ok':
    case 'passed':
      return 'success';
    case 'error':
    case 'failed':
    case 'failure':
      return 'failure';
    case 'skipped':
    case 'declined':
      return 'skipped';
    default:
      return 'unknown';
  }
}

/**
 * Normalize one oasis_events row. Returns null when the topic is not on the
 * allowlist — the overwhelmingly common case, and not an error.
 */
export function normalizeOasisEvent(row: OasisEventRow): WatcherStep | null {
  const topic = row.topic || '';
  if (!topic) return null;

  let step: WatcherStepName;
  let outcome: StepOutcome;
  let actor: StepActor;

  const rule = TOPIC_RULES[topic];
  if (rule) {
    step = rule.step;
    outcome = rule.outcome === 'derive' ? deriveOutcome(row.status) : rule.outcome;
    actor = rule.actor;
  } else {
    const m = WORKER_STAGE_RE.exec(topic);
    if (!m) return null;
    const mapped = WORKER_STAGE_STEP[m[2]];
    if (!mapped) return null;
    step = mapped.step;
    outcome = mapped.outcome;
    actor = 'worker-runner';
  }

  // A VTID is the best work_unit we have; without one the event still
  // happened and is worth keeping, keyed by its own id. Dropping it would
  // hide exactly the ungoverned work the Watcher exists to notice.
  const vtid = row.vtid && row.vtid.trim() ? row.vtid.trim() : null;

  return {
    work_unit_kind: vtid ? 'vtid' : 'execution',
    work_unit_id: vtid || row.id,
    vtid,
    step,
    outcome,
    actor,
    evidence: {
      topic,
      event_id: row.id,
      status: row.status ?? null,
      message: row.message ?? null,
      service: row.service ?? null,
      emitter: row.source ?? null,
    },
    source: SOURCE_OASIS,
    source_ref: row.id,
    observed_at: row.created_at,
  };
}

/**
 * dev_autopilot_executions status → step.
 *
 * KNOWN LIMITATION, deliberately accepted: this source is a poll over a
 * MUTABLE row, so it only ever sees the status the row holds at scan time.
 * An execution that goes running → ci → merging inside one tick interval
 * contributes only `merging`. The intermediate transitions are not lost —
 * `oasis_events` carries them, and that source is scanned in the same tick.
 * This source's job is to be the backstop that guarantees every execution
 * appears on the timeline at all, even if its events failed to emit.
 *
 * Terminal statuses are the ones actually worth anchoring, which is why
 * queued/cooling map to a step but carry outcome 'unknown'.
 */
const EXECUTION_STATUS_STEP: Record<string, { step: WatcherStepName; outcome: StepOutcome }> = {
  queued: { step: 'queued', outcome: 'unknown' },
  cooling: { step: 'queued', outcome: 'unknown' },
  cancelled: { step: 'failed', outcome: 'skipped' },
  running: { step: 'running', outcome: 'unknown' },
  ci: { step: 'ci', outcome: 'unknown' },
  merging: { step: 'merged', outcome: 'unknown' },
  deploying: { step: 'deploying', outcome: 'unknown' },
  verifying: { step: 'verified', outcome: 'unknown' },
  completed: { step: 'completed', outcome: 'success' },
  failed: { step: 'failed', outcome: 'failure' },
  reverted: { step: 'reverted', outcome: 'failure' },
  self_healed: { step: 'completed', outcome: 'success' },
  failed_escalated: { step: 'escalated', outcome: 'failure' },
  // Archived rows are bookkeeping, not a lifecycle event. Recording them
  // would date-stamp a step at archive time, months after the real work.
  auto_archived: { step: 'failed', outcome: 'skipped' },
};

export function normalizeExecution(row: ExecutionRow): WatcherStep | null {
  const mapped = EXECUTION_STATUS_STEP[row.status];
  if (!mapped) return null;
  if (row.status === 'auto_archived') return null;

  const vtid = row.self_healing_vtid && row.self_healing_vtid.trim()
    ? row.self_healing_vtid.trim()
    : null;

  return {
    work_unit_kind: 'execution',
    work_unit_id: row.id,
    vtid,
    step: mapped.step,
    outcome: mapped.outcome,
    actor: 'autopilot',
    evidence: {
      execution_status: row.status,
      finding_id: row.finding_id ?? null,
      branch: row.branch ?? null,
      pr_url: row.pr_url ?? null,
      pr_number: row.pr_number ?? null,
      failure_stage: row.failure_stage ?? null,
      parent_execution_id: row.parent_execution_id ?? null,
      auto_fix_depth: row.auto_fix_depth ?? 0,
    },
    source: SOURCE_EXECUTIONS,
    // Keyed by (execution, status) rather than execution alone: one row
    // legitimately contributes several steps over its life, one per status
    // it is observed in, and each must survive an overlap rescan unchanged.
    source_ref: `${row.id}:${row.status}`,
    observed_at: row.updated_at,
  };
}

/** Topics currently observed. Exported for /health and for the tests. */
export function observedTopics(): string[] {
  return Object.keys(TOPIC_RULES).sort();
}

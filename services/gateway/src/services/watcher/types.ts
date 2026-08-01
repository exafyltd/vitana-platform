/**
 * VTID-03460 — Watcher Phase 1: shared types.
 *
 * Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454).
 *
 * These mirror the watcher_steps CHECK constraints exactly. When you add a
 * value here you must add it to the migration too — a step the DB rejects
 * fails the whole batch insert, and the observer is deliberately best-effort,
 * so the failure would be logged and then invisible.
 */

export type WorkUnitKind = 'vtid' | 'execution' | 'pr' | 'session';

export type WatcherStepName =
  | 'allocated'
  | 'planned'
  | 'queued'
  | 'running'
  | 'validated'
  | 'pr_opened'
  | 'ci'
  | 'merged'
  | 'deploying'
  | 'verified'
  | 'completed'
  | 'failed'
  | 'reverted'
  | 'escalated'
  | 'doc_updated'
  | 'terminalized';

export type StepOutcome = 'success' | 'failure' | 'skipped' | 'unknown';

export type StepActor =
  | 'autopilot'
  | 'worker-runner'
  | 'claude-session'
  | 'human'
  | 'ci'
  | 'unknown';

/** A normalized lifecycle step, ready to upsert into watcher_steps. */
export interface WatcherStep {
  work_unit_kind: WorkUnitKind;
  work_unit_id: string;
  vtid: string | null;
  step: WatcherStepName;
  outcome: StepOutcome;
  actor: StepActor;
  evidence: Record<string, unknown>;
  source: string;
  /**
   * Stable identity of the observed thing within its source. Together with
   * (source, step) this is the idempotency key — the observer rescans an
   * overlap window every tick, so this value must be derived purely from the
   * source row, never from wall-clock time or a random id.
   */
  source_ref: string;
  observed_at: string;
}

/** Per-source cursor state, as stored in watcher_observer_state. */
export interface ObserverState {
  source: string;
  cursor_at: string;
  last_run_at: string | null;
  last_error: string | null;
  last_written: number;
  updated_at: string;
}

/** Outcome of one source's tick. Returned for /health and for logging. */
export interface SourceTickResult {
  source: string;
  scanned: number;
  written: number;
  cursor_at: string;
  error?: string;
}

/** Shape accepted by POST /api/v1/watcher/session-step. */
export interface SessionStepInput {
  session_id: string;
  step: WatcherStepName;
  outcome?: StepOutcome;
  vtid?: string | null;
  evidence?: Record<string, unknown>;
  observed_at?: string;
  /**
   * Caller-supplied idempotency key within the session. Two posts with the
   * same (session_id, step, ref) collapse to one row — so a hook that fires
   * twice on a retry does not double-count.
   */
  ref?: string;
}

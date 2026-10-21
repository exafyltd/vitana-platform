/**
 * B0b (orb-live-refactor): per-source latency + degradation flags.
 *
 * Tracks the health of every context-source the compiler consults
 * (situational core, match-journey provider, memory broker adapters,
 * future capability registry). The compiler emits an OASIS event
 * (`assistant.context_source_degraded`) for every source whose
 * latency exceeds budget or whose call threw.
 *
 * **Why it ships in B0b (not later):** match-journey acceptance
 * checks reference `source health for match context` (check #4 + #5).
 * Without this module, the Command Hub Match Journey panel cannot
 * display per-source degradation.
 *
 * The module is **state-free** at module scope — every call returns
 * a fresh `SourceHealthReport` describing the most recent compile.
 * Long-term metrics live in OASIS, not here.
 */

import { CONTEXT_SOURCE_DEGRADED } from './telemetry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceName =
  | 'situational_core'
  | 'match_journey_context'
  | 'memory_broker'
  | 'context_pack'
  | 'context_window'
  | 'capability_registry';

export type SourceStatus = 'ok' | 'slow' | 'failed' | 'skipped';

export interface SourceTiming {
  source: SourceName;
  status: SourceStatus;
  latencyMs: number;
  /** Free-form reason; set when status is 'slow' / 'failed' / 'skipped'. */
  reason?: string;
}

export interface SourceHealthReport {
  /** Per-source timings, in the order they ran. */
  timings: ReadonlyArray<SourceTiming>;
  /**
   * Sources to flag for the Command Hub Source Health panel + the
   * `assistant.context_source_degraded` OASIS event. Includes anything
   * with status !== 'ok'.
   */
  degradedSources: ReadonlyArray<SourceTiming>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Soft latency budgets per source. Anything over budget is marked 'slow'
 * (still usable, but flagged on the source-health panel). Budgets are
 * intentionally conservative for B0b — they will be tuned once we have
 * production data.
 */
export const SOURCE_LATENCY_BUDGET_MS: Record<SourceName, number> = {
  situational_core: 5,
  match_journey_context: 50,
  memory_broker: 200,
  context_pack: 200,
  context_window: 50,
  capability_registry: 100,
};

/**
 * Time the execution of a single context-source call and produce a
 * `SourceTiming`. The compiler calls this around every adapter call.
 */
export async function timeSource<T>(
  source: SourceName,
  fn: () => Promise<T> | T,
): Promise<{ value: T | null; timing: SourceTiming }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    const latencyMs = Date.now() - t0;
    const budget = SOURCE_LATENCY_BUDGET_MS[source];
    const status: SourceStatus = latencyMs > budget ? 'slow' : 'ok';
    return {
      value,
      timing: {
        source,
        status,
        latencyMs,
        ...(status === 'slow' ? { reason: `over budget (${budget}ms)` } : {}),
      },
    };
  } catch (err: any) {
    return {
      value: null,
      timing: {
        source,
        status: 'failed',
        latencyMs: Date.now() - t0,
        reason: err?.message ?? String(err),
      },
    };
  }
}

/**
 * Aggregate per-source timings into a `SourceHealthReport`. The compiler
 * calls this once per session-start after running all sources.
 */
export function summarizeSourceHealth(
  timings: SourceTiming[],
): SourceHealthReport {
  const degraded = timings.filter((t) => t.status !== 'ok');
  return {
    timings: Object.freeze(timings.slice()),
    degradedSources: Object.freeze(degraded),
  };
}

/**
 * Build the OASIS event payload for a degraded source. Callers (the
 * compiler) emit one event per degraded source.
 */
export function buildDegradedSourceEvent(
  timing: SourceTiming,
): { topic: string; payload: Record<string, unknown> } {
  return {
    topic: CONTEXT_SOURCE_DEGRADED,
    payload: {
      source: timing.source,
      status: timing.status,
      latency_ms: timing.latencyMs,
      reason: timing.reason ?? null,
    },
  };
}

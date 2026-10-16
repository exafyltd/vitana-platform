/**
 * VTID-05216 — Project Manager agent (P3: observe + decide, dry_run).
 *
 * Barrel + the deterministic decide tick. P3 is observe + decide ONLY:
 * `runDecideTick` observes (read-only), decides (pure), and reports each
 * decision through the emitter. It NEVER acts — no merge, no reassign commit,
 * no park write, no Gate-2 send, no GitHub/Supabase/AWS write. `live` act is P4.
 *
 * The last tick's decision list is held in memory so the read route
 * (GET /api/v1/project-manager/status) can report it.
 */

import { decide } from './decide';
import { PmDecisionEmitter, defaultEmitter } from './emit';
import { PmObserver, defaultObserver } from './observe';
import { pmMode } from './config';
import { PmDecision, PmMode } from './types';

export * from './types';
export { decide } from './decide';
export { PmObserver, StubObserver, defaultObserver } from './observe';
export { PmDecisionEmitter, LoggingDecisionEmitter, defaultEmitter } from './emit';
export { pmAgentEnabled, pmMode, pmTickIntervalMs } from './config';

/** A snapshot of the most recent decide tick, reported by the status route. */
export interface PmStatusSnapshot {
  mode: PmMode;
  /** ISO timestamp of the last decide tick, or null if none has run. */
  last_tick_at: string | null;
  decisions: PmDecision[];
}

let lastSnapshot: PmStatusSnapshot = {
  mode: pmMode(),
  last_tick_at: null,
  decisions: [],
};

/** Read the latest decide snapshot (status route). Reflects live PM_MODE. */
export function getStatusSnapshot(): PmStatusSnapshot {
  return { ...lastSnapshot, mode: pmMode() };
}

export interface RunDecideTickDeps {
  observer?: PmObserver;
  emitter?: PmDecisionEmitter;
  /** Injected clock for tests; defaults to Date.now(). */
  now?: () => number;
}

/**
 * One deterministic decide tick: observe → decide → report. Pure decide, no
 * act. Returns the decisions it reported and updates the status snapshot.
 *
 * In `off` mode it decides nothing. In `dry_run` (and, for the decide half,
 * `live`) it reports decisions through the emitter. P3 performs NO act in any
 * mode — the act step is P4.
 */
export async function runDecideTick(deps: RunDecideTickDeps = {}): Promise<PmDecision[]> {
  const observer = deps.observer ?? defaultObserver();
  const emitter = deps.emitter ?? defaultEmitter();
  const now = deps.now ?? Date.now;

  const mode = pmMode();
  const state = await observer.observe(mode);
  const decisions = decide(state, now());

  for (const d of decisions) {
    await emitter.emit(d);
  }

  lastSnapshot = {
    mode,
    last_tick_at: new Date(now()).toISOString(),
    decisions,
  };

  return decisions;
}

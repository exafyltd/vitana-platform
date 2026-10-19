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
import { actOnDecisions, ActDeps, ActTickResult } from './act';
import { PmDecision, PmMode } from './types';

export * from './types';
export { decide } from './decide';
export { PmObserver, StubObserver, defaultObserver } from './observe';
export { PmDecisionEmitter, LoggingDecisionEmitter, defaultEmitter } from './emit';
export { pmAgentEnabled, pmMode, pmTickIntervalMs } from './config';
export {
  actOnDecisions,
  governanceMergeAllowed,
  laneTouchesGovernance,
  prNumberFromUrl,
} from './act';
export type {
  ActDeps,
  ActTickResult,
  SafeMergeFn,
  LaneFileWriter,
  LaneFileChange,
  Gate2Poster,
  Gate2Message,
  Gate2EvidenceResolver,
} from './act';
export { LeaseManager, NoLeaseManager, defaultLeaseManager } from './lease';
export type { LeaseOutcome } from './lease';

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

export interface RunActTickDeps extends RunDecideTickDeps {
  /** The act seams (safe-merge, lane writer, Gate-2 poster, lease). */
  act: ActDeps;
}

/**
 * One full PM tick in `live` mode: observe → decide → ACT (VTID-05217 / P4).
 *
 * It observes and decides exactly as `runDecideTick` does, updates the status
 * snapshot the same way, then acts on the decisions through the injected act
 * seams. The act step itself is a no-op unless `PM_MODE=live` AND the per-tick
 * lease is held (see `actOnDecisions`): in `off`/`dry_run`, or when the pm_lease
 * table is absent (P1 not merged) or another task holds the lease, nothing is
 * acted on. Returns both the decisions and the act result.
 */
export async function runActTick(
  deps: RunActTickDeps,
): Promise<{ decisions: PmDecision[]; act: ActTickResult }> {
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

  const act = await actOnDecisions(decisions, state, deps.act);

  return { decisions, act };
}

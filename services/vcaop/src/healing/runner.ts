/**
 * Health-and-heal runner (SELF-HEALING-PLAN.md) — the entrypoint a scheduler/cron
 * calls each cycle. Runs the in-process `invariantProbe` through the
 * `SelfHealingOrchestrator` with the (injected) recovery primitives. On a healthy
 * system it returns `{status:'healthy'}` silently; on failure it walks the ladder
 * and returns `recovered` or `escalated`.
 */
import { SelfHealingOrchestrator, defaultLadder, HealPrimitives, HealOutcome, Incident } from './orchestrator';
import { invariantProbe } from './health-probe';
import { OasisSink } from '../api/oasis-sink';
import { EmitHumanTask } from '../guardrails/human-gate';

export interface RunHealOptions {
  oasis: OasisSink;
  emitHumanTask: EmitHumanTask;
  onEscalate?: (incident: Incident) => Promise<void> | void;
  /** Real recovery primitives in prod (rollback/migration/reseed/degrade); mock/empty in dev. */
  primitives?: HealPrimitives;
  maxAttemptsPerStep?: number;
  backoffMs?: number;
}

export async function runHealthAndHeal(opts: RunHealOptions): Promise<HealOutcome> {
  const orchestrator = new SelfHealingOrchestrator(invariantProbe, {
    oasis: opts.oasis,
    emitHumanTask: opts.emitHumanTask,
    onEscalate: opts.onEscalate,
    ladder: defaultLadder(opts.primitives ?? {}),
    maxAttemptsPerStep: opts.maxAttemptsPerStep,
    backoffMs: opts.backoffMs,
  });
  return orchestrator.runCycle();
}

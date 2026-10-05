/**
 * VTID-04774: Jev P1 gate A2 — can the Dev Autopilot agent finish this
 * execution? (docs/JEV-INTEGRATION-PLAN.md §10.4 A2)
 *
 *   claim_feasibility   (JEV_CLAIM_FEASIBILITY_MODE = off | shadow | enforce)
 *
 * Asked once per execution, right after the executor claims it (the one
 * point every execution passes, including self-heal children and fix-mode
 * rows that never went through approval). Jev `execution_feasibility`
 * answers feasible / needs_human / needs_infra / too_large / unclear from
 * the finding's title, plan excerpt and file paths.
 *
 * Shadow only: fire-and-forget, never delays the claim or changes the
 * dispatch. One `jev_shadow_decisions` row per execution, subject_ref =
 * execution id. When the execution's result is applied (ECS task or
 * in-process — both go through applyExecutionResult), the row gets the
 * outcome and `agreed`:
 *   feasible predicted   and the run opened its PR / held for approval → agreed
 *   any blocker predicted and the run failed                          → agreed
 *   otherwise                                                         → disagreed
 * Cancelled runs and abstentions carry agreed = null.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';
import * as repo from '../jev-repository';

export const CLAIM_FEASIBILITY_GATE = 'claim_feasibility';
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-executor', system: true } as const;
const OUTCOME_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

export interface FeasibilityContext {
  title: string;
  plan: string;
  files: string[];
  fix_mode: boolean;
  prior_failure?: string | null;
  risk_class?: string | null;
  source_type?: string | null;
}

export interface ClaimFeasibilityArgs {
  executionId: string;
  findingId: string;
  /** Reads the plan and finding; called only when the gate is on. */
  load: () => Promise<FeasibilityContext | null>;
  /** What the executor does regardless of the verdict (for the row). */
  systemAction?: string;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}

export function isClaimFeasibilityOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(CLAIM_FEASIBILITY_GATE, env) !== 'off';
}

/** Never throws. Returns the shadow row id, or null when off or on any error. */
export async function runClaimFeasibilityCheck(a: ClaimFeasibilityArgs): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(CLAIM_FEASIBILITY_GATE, env);
  if (mode === 'off') return null;
  try {
    const ctx = await a.load();
    if (!ctx) {
      console.warn(`[jev] ${CLAIM_FEASIBILITY_GATE}: no plan/finding for ${a.executionId} — not asked`);
      return null;
    }
    const r = await decide(
      'execution_feasibility',
      {
        title: (ctx.title || '(untitled finding)').slice(0, 300),
        plan: (ctx.plan || '(no plan)').slice(0, 3000),
        files: (ctx.files || []).slice(0, 40).map((f) => String(f).slice(0, 200)),
        fix_mode: !!ctx.fix_mode,
        prior_failure: ctx.prior_failure ? ctx.prior_failure.slice(0, 800) : undefined,
        risk_class: ctx.risk_class || undefined,
        source_type: ctx.source_type || undefined,
      },
      SYSTEM_CALLER,
      { ...(a.decideOptions || {}), source: `gate:${CLAIM_FEASIBILITY_GATE}`, env },
    );
    return await recordJevShadowDecision(
      {
        gate: CLAIM_FEASIBILITY_GATE,
        decision: 'execution_feasibility',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_autopilot_execution',
        subject_ref: a.executionId,
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? { feasibility: r.verdict.value, will_succeed: r.answers.will_succeed?.probability ?? null, finding_id: a.findingId, fix_mode: ctx.fix_mode }
          : { reason: r.reason, finding_id: a.findingId },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: a.systemAction || 'dispatch',
        cost_usd: r.ok ? r.cost_usd : 0,
      },
      a.sb === undefined ? getSupabase() : a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${CLAIM_FEASIBILITY_GATE} check failed for ${a.executionId}: ${err?.message || err}`);
    return null;
  }
}

export interface ExecutionResultLike {
  ok: boolean;
  awaiting_approval?: boolean;
  cancelled?: boolean;
  error?: string;
}

/**
 * Writes the execution's outcome onto its feasibility row, if one exists.
 * Independent of the mode (the executor task may not carry the switch):
 * no row → nothing to do. Never throws.
 */
export async function recordClaimFeasibilityOutcome(
  executionId: string,
  result: ExecutionResultLike,
  opts: { sb?: SupabaseClient | null; now?: () => number } = {},
): Promise<void> {
  try {
    const sb = opts.sb === undefined ? getSupabase() : opts.sb;
    if (!sb) return;
    const since = new Date((opts.now ?? Date.now)() - OUTCOME_LOOKBACK_MS).toISOString();
    const { data, error } = await repo.fetchRecentShadowRow(sb, CLAIM_FEASIBILITY_GATE, executionId, since);
    if (error || !data) return;
    const row = data as { id: string; jev_outcome: string; jev_verdict: { feasibility?: string } | null };
    const outcome = result.cancelled ? 'cancelled' : result.ok ? (result.awaiting_approval ? 'awaiting_approval' : 'pr_opened') : 'failed';
    const predicted = row.jev_outcome === 'decided' ? row.jev_verdict?.feasibility : undefined;
    const agreed = outcome === 'cancelled' || !predicted ? null : (predicted === 'feasible') === result.ok;
    await recordJevShadowOutcome(row.id, `run_${outcome}`, agreed, sb);
  } catch (err: any) {
    console.warn(`[jev] ${CLAIM_FEASIBILITY_GATE} outcome not recorded for ${executionId}: ${err?.message || err}`);
  }
}

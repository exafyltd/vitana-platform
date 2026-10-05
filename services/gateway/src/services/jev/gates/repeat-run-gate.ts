/**
 * VTID-04801: Jev P2 gate A4 — is a new Dev Autopilot attempt a repeat of
 * one that already failed? (docs/JEV-INTEGRATION-PLAN.md §10.4 A4)
 *
 *   repeat_run_guard   (JEV_REPEAT_RUN_GUARD_MODE = off | shadow | enforce)
 *
 * 685 executions served 142 findings in the 30 days to 2026-10-01; 619 of
 * them ended auto_archived. The retry cap, the turn-cap breaker
 * (VTID-04243) and the outage stop (VTID-04368) bound HOW OFTEN a finding
 * is retried; none of them can see WHAT the new attempt will do. A4 asks,
 * at the claim, whether this attempt is the previous failed approach again.
 *
 *   - No failed attempt of this finding in the last 7 days → no row.
 *   - Same plan version as the failed attempt → a repeat by definition:
 *     a rules row, no Jev call.
 *   - A different plan version → Jev `execution_repeat` compares the two
 *     plans and the previous failure (plans and failure text only).
 *
 * Fire-and-forget beside the A2 feasibility check: the claim and dispatch
 * are unchanged. The outcome is written from the run's applied result:
 * "repeat" agrees with a failed run, "not a repeat" with a PR. No enforce
 * behaviour yet (holding a repeat instead of dispatching it).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';

export const REPEAT_RUN_GATE = 'repeat_run_guard';
export const REPEAT_LOOKBACK_DAYS = 7;
/** Terminal statuses that mean the attempt did not land. */
export const FAILED_EXECUTION_STATUSES = ['failed', 'failed_escalated', 'auto_archived', 'reverted'] as const;
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-executor', system: true } as const;
const OUTCOME_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

export interface RepeatAttempt {
  execution_id: string;
  plan_version: number;
  plan: string;
  failure: string;
}

export interface RepeatContext {
  title: string | null;
  plan_version: number;
  plan: string;
  fix_mode: boolean;
  /** The newest failed attempt of the same finding inside the lookback, or null. */
  previous: RepeatAttempt | null;
}

export function isRepeatRunGuardOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(REPEAT_RUN_GATE, env) !== 'off';
}

/** Never throws. Returns the shadow row id, or null when off/skipped/failed. */
export async function runRepeatRunCheck(a: {
  executionId: string;
  findingId: string;
  load: () => Promise<RepeatContext | null>;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(REPEAT_RUN_GATE, env);
  if (mode === 'off') return null;
  try {
    const ctx = await a.load();
    if (!ctx || !ctx.previous || !ctx.plan) return null;
    const prev = ctx.previous;
    const base = {
      gate: REPEAT_RUN_GATE,
      mode,
      plane: 'internal',
      tenant_id: null,
      subject_type: 'dev_autopilot_execution',
      subject_ref: a.executionId,
      system_action: 'dispatch',
    };
    const sb = a.sb === undefined ? getSupabase() : a.sb;

    if (prev.plan_version === ctx.plan_version) {
      return await recordJevShadowDecision(
        {
          ...base,
          decision: 'rules:same_plan_version',
          jev_outcome: 'decided',
          jev_verdict: { source: 'rules', repeat: true, previous_execution_id: prev.execution_id, plan_version: ctx.plan_version, finding_id: a.findingId },
          jev_confidence: 1,
          cost_usd: 0,
        },
        sb,
      );
    }

    const r = await decide(
      'execution_repeat',
      {
        title: ctx.title ?? undefined,
        previous_plan: prev.plan.slice(0, 6000) || '(empty)',
        previous_failure: prev.failure.slice(0, 2000) || '(no reason recorded)',
        new_plan: ctx.plan.slice(0, 6000),
        fix_mode: ctx.fix_mode,
      },
      SYSTEM_CALLER,
      { ...(a.decideOptions || {}), source: `gate:${REPEAT_RUN_GATE}`, env },
    );
    return await recordJevShadowDecision(
      {
        ...base,
        decision: 'execution_repeat',
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? {
              source: 'jev',
              repeat: r.outcome === 'decided' ? r.verdict.value === true : null,
              probability: r.answers.repeat?.probability ?? null,
              will_succeed: r.answers.will_succeed?.probability ?? null,
              previous_execution_id: prev.execution_id,
              previous_plan_version: prev.plan_version,
              plan_version: ctx.plan_version,
              finding_id: a.findingId,
            }
          : { reason: r.reason, previous_execution_id: prev.execution_id, finding_id: a.findingId },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        cost_usd: r.ok ? r.cost_usd : 0,
      },
      sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${REPEAT_RUN_GATE} check failed for ${a.executionId}: ${err?.message || err}`);
    return null;
  }
}

/** Writes the run's outcome onto its repeat row, if one exists. Never throws. */
export async function recordRepeatRunOutcome(
  executionId: string,
  result: { ok: boolean; awaiting_approval?: boolean; cancelled?: boolean },
  opts: { sb?: SupabaseClient | null; now?: () => number } = {},
): Promise<void> {
  try {
    const sb = opts.sb === undefined ? getSupabase() : opts.sb;
    if (!sb) return;
    const since = new Date((opts.now ?? Date.now)() - OUTCOME_LOOKBACK_MS).toISOString();
    const { data, error } = await repo.fetchRecentShadowRow(sb, REPEAT_RUN_GATE, executionId, since);
    if (error || !data) return;
    const row = data as { id: string; jev_outcome: string; jev_verdict: { repeat?: boolean | null } | null };
    const outcome = result.cancelled ? 'run_cancelled' : result.ok ? (result.awaiting_approval ? 'run_awaiting_approval' : 'run_pr_opened') : 'run_failed';
    const repeat = row.jev_outcome === 'decided' && typeof row.jev_verdict?.repeat === 'boolean' ? row.jev_verdict.repeat : null;
    const agreed = result.cancelled || repeat === null ? null : repeat === !result.ok;
    await recordJevShadowOutcome(row.id, outcome, agreed, sb);
  } catch (err: any) {
    console.warn(`[jev] ${REPEAT_RUN_GATE} outcome not recorded for ${executionId}: ${err?.message || err}`);
  }
}

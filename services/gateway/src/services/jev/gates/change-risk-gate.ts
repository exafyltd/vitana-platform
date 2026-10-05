/**
 * VTID-04815: Jev P3 gate A9 — per-change risk score for a Dev Autopilot
 * diff (advisory). (docs/JEV-INTEGRATION-PLAN.md §10.4 A9)
 *
 *   change_risk   (JEV_CHANGE_RISK_MODE = off | shadow | enforce)
 *
 * The only risk signal today is the finding's `risk_class`, set by the
 * scanner before any code exists (high → never auto-executed). Nothing
 * looks at the change the agent actually produced: how many files, whether
 * they are shared or central, how much of it is tested.
 *
 * After the agent runner pushes a new change (not a fix-mode push), Jev
 * `change_risk` scores it (low / moderate / high / very high) from the
 * finding title and class, the changed paths, the diff stat, a bounded patch
 * excerpt, the number of test files in the diff and the fix rounds it took.
 * Never awaited; nothing is shown and nothing changes. The outcome is what
 * happened to the change: CI failed or the post-deploy verification failed
 * (the risk was real), or verification passed (it landed). "High" or worse
 * agrees with a bad landing. Showing the score next to the PR / approval is
 * enforce, after the data. Like A1/A5 it runs where the agent runs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';

export const CHANGE_RISK_GATE = 'change_risk';
/** "High" in change_risk's four levels. */
export const HIGH_RISK_LEVEL = 2;
export const PATCH_EXCERPT_CHARS = 8000;
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-executor', system: true } as const;
const OUTCOME_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const TEST_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export interface ChangeRiskInput {
  finding_title: string;
  finding_risk_class?: string;
  files: string[];
  diff_stat: string;
  patch_excerpt: string;
  tests_in_diff: number;
  fix_rounds: number;
}

export function isChangeRiskOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(CHANGE_RISK_GATE, env) !== 'off';
}

/** What the runner sends, built from its own diff. Pure. */
export function changeRiskInput(a: {
  findingTitle: string | null | undefined;
  findingRiskClass?: string | null;
  diff: { stat: string; patch: string; files: string[] };
  fixRounds: number;
}): ChangeRiskInput {
  const patch = a.diff.patch || '';
  return {
    finding_title: (a.findingTitle || '').slice(0, 300) || '(untitled)',
    finding_risk_class: a.findingRiskClass || undefined,
    files: a.diff.files.slice(0, 60),
    diff_stat: (a.diff.stat || '').slice(0, 4000) || '(no stat)',
    patch_excerpt: patch.length > PATCH_EXCERPT_CHARS ? `${patch.slice(0, PATCH_EXCERPT_CHARS - 40)}\n… [${patch.length - PATCH_EXCERPT_CHARS + 40} more chars]` : patch || '(empty)',
    tests_in_diff: a.diff.files.filter((f) => TEST_RE.test(f)).length,
    fix_rounds: Math.max(0, Math.floor(a.fixRounds || 0)),
  };
}

/** Score a pushed change. Returns the shadow row id or null; never throws. */
export async function runChangeRiskCheck(a: {
  executionId: string;
  input: ChangeRiskInput;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(CHANGE_RISK_GATE, env);
  if (mode === 'off') return null;
  try {
    const r = await decide('change_risk', { ...a.input }, SYSTEM_CALLER, { ...(a.decideOptions || {}), source: `gate:${CHANGE_RISK_GATE}`, env });
    return await recordJevShadowDecision(
      {
        gate: CHANGE_RISK_GATE,
        decision: 'change_risk',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_autopilot_execution',
        subject_ref: a.executionId,
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? { level: r.outcome === 'decided' ? r.verdict.value : null, label: r.verdict.label ?? null, files: a.input.files.length, tests_in_diff: a.input.tests_in_diff, finding_risk_class: a.input.finding_risk_class ?? null }
          : { reason: r.reason, files: a.input.files.length },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: 'pushed',
        cost_usd: r.ok ? r.cost_usd : 0,
      },
      a.sb === undefined ? getSupabase() : a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${CHANGE_RISK_GATE} check failed for ${a.executionId}: ${err?.message || err}`);
    return null;
  }
}

export type ChangeLanding = 'ci_failed' | 'verification_failed' | 'verification_passed';

/** How the change landed, compared with the score. First landing wins; never throws. */
export async function recordChangeRiskOutcome(
  executionId: string,
  landing: ChangeLanding,
  opts: { sb?: SupabaseClient | null; now?: () => number } = {},
): Promise<void> {
  try {
    const sb = opts.sb === undefined ? getSupabase() : opts.sb;
    if (!sb) return;
    const since = new Date((opts.now ?? Date.now)() - OUTCOME_LOOKBACK_MS).toISOString();
    const { data, error } = await repo.fetchRecentShadowRow(sb, CHANGE_RISK_GATE, executionId, since);
    if (error || !data) return;
    const row = data as { id: string; jev_outcome?: string; jev_verdict?: { level?: unknown }; outcome?: string | null };
    if (row.outcome) return;
    const level = row.jev_outcome === 'decided' && typeof row.jev_verdict?.level === 'number' ? row.jev_verdict.level : null;
    const bad = landing !== 'verification_passed';
    const agreed = level === null ? null : (level >= HIGH_RISK_LEVEL) === bad;
    await recordJevShadowOutcome(row.id, landing, agreed, sb);
  } catch (err: any) {
    console.warn(`[jev] ${CHANGE_RISK_GATE} outcome not recorded for ${executionId}: ${err?.message || err}`);
  }
}

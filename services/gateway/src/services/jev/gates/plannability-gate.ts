/**
 * VTID-04806: Jev P2 gate A3 — is a Dev Autopilot finding plannable?
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 A3)
 *
 *   plannability   (JEV_PLANNABILITY_MODE = off | shadow | enforce)
 *
 * The planner spends a full LLM session on every finding it is asked to
 * plan, and 77 of the 159 plans in the 30 days to 2026-10-01 were follow-up
 * versions — someone had to send the plan back. Some findings are not
 * plannable as written: too vague, too broad, waiting on a decision, or
 * with no location in the code.
 *
 * On a first-time plan (never a human's continue-planning call), Jev
 * `finding_plannable` is asked from the finding's own title, summary,
 * signal and file hints, in parallel with the planner — never awaited
 * before it. When the planner finishes, the row records what happened:
 * a plan that cites files is "planned"; a planner failure that is the
 * planner's own (no plan text) counts against plannability only when it is
 * not an infrastructure error (provider down, timeout, unknown error,
 * storage). There is no enforce behaviour yet: skipping the planner for a
 * finding Jev calls unplannable comes after the data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';

export const PLANNABILITY_GATE = 'plannability';
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-planner', system: true } as const;

/** Planner errors that say nothing about the finding itself. */
export const INFRA_ERROR = /unknown error|providers? failed|timed? ?out|timeout|not configured|supabase|insert failed|lookup failed|ECONN|socket|\b5\d\d\b/i;

export interface PlannableFinding {
  id: string;
  title: string;
  summary: string;
  domain?: string | null;
  risk_class?: string | null;
  spec_snapshot?: { signal_type?: string; file_path?: string; suggested_action?: string; proposed_files?: unknown } | null;
}

export interface PlanResult {
  ok: boolean;
  files?: number;
  error?: string;
}

export function isPlannabilityOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(PLANNABILITY_GATE, env) !== 'off';
}

/** The file hints a finding carries before any plan exists. */
export function findingFiles(f: PlannableFinding): string[] {
  const s = f.spec_snapshot || {};
  const out = new Set<string>();
  if (typeof s.file_path === 'string' && s.file_path.trim()) out.add(s.file_path.trim());
  if (Array.isArray(s.proposed_files)) for (const p of s.proposed_files) if (typeof p === 'string' && p.includes('/')) out.add(p.trim());
  return [...out].slice(0, 20);
}

export interface PlannabilityCheck {
  shadow_id: string | null;
  plannable: boolean | null;
  /** VTID-05012: Jev's below-threshold answer when it abstained (null otherwise). */
  lean?: boolean | null;
}

/** Ask Jev and write the shadow row. Returns null when off; never throws. */
export async function runPlannabilityCheck(a: {
  finding: PlannableFinding;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<PlannabilityCheck | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(PLANNABILITY_GATE, env);
  if (mode === 'off') return null;
  try {
    const f = a.finding;
    const s = f.spec_snapshot || {};
    const r = await decide(
      'finding_plannable',
      {
        title: String(f.title || '').slice(0, 300) || '(untitled)',
        summary: String(f.summary || '').slice(0, 3000) || '(no summary)',
        domain: f.domain || undefined,
        risk_class: f.risk_class || undefined,
        signal_type: s.signal_type || undefined,
        suggested_action: typeof s.suggested_action === 'string' ? s.suggested_action.slice(0, 1000) : undefined,
        files: findingFiles(f),
      },
      SYSTEM_CALLER,
      { ...(a.decideOptions || {}), source: `gate:${PLANNABILITY_GATE}`, env },
    );
    const plannable = r.ok && r.outcome === 'decided' ? r.verdict.value === true : null;
    const lean = r.ok && r.outcome === 'abstained' ? r.verdict.value === true : null;
    const id = await recordJevShadowDecision(
      {
        gate: PLANNABILITY_GATE,
        decision: 'finding_plannable',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_autopilot_finding',
        subject_ref: f.id,
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? { plannable, ...(lean !== null ? { lean } : {}), probability: r.answers.plannable?.probability ?? null, blocker: r.answers.blocker?.value ?? null, files: findingFiles(f).length }
          : { reason: r.reason },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: 'planner_ran',
        cost_usd: r.ok ? r.cost_usd : 0,
      },
      a.sb,
    );
    return { shadow_id: id, plannable, ...(lean !== null ? { lean } : {}) };
  } catch (err: any) {
    console.warn(`[jev] ${PLANNABILITY_GATE} check failed for ${a.finding?.id}: ${err?.message || err}`);
    return null;
  }
}

/** What the planner did, compared with Jev's call. Never throws. */
export async function recordPlannabilityOutcome(
  check: Promise<PlannabilityCheck | null> | null,
  result: PlanResult,
  sb?: SupabaseClient | null,
): Promise<void> {
  try {
    const c = check ? await check : null;
    if (!c || !c.shadow_id) return;
    let outcome: string;
    let planned: boolean | null;
    if (result.ok) {
      planned = (result.files ?? 0) > 0;
      outcome = planned ? 'plan_with_files' : 'plan_without_files';
    } else if (INFRA_ERROR.test(result.error || '')) {
      planned = null;
      outcome = 'plan_infra_error';
    } else {
      planned = false;
      outcome = 'plan_failed';
    }
    const agreed = planned === null || c.plannable === null ? null : c.plannable === planned;
    // VTID-05012: an abstained row is scored on its lean; `agreed` stays decided-only.
    const lean = c.lean ?? null;
    const leanAgreed = lean === null ? undefined : planned === null ? null : lean === planned;
    await recordJevShadowOutcome(c.shadow_id, outcome, agreed, sb, leanAgreed);
  } catch (err: any) {
    console.warn(`[jev] ${PLANNABILITY_GATE} outcome not recorded: ${err?.message || err}`);
  }
}

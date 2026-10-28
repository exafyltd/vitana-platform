/**
 * VTID-04803: Jev P2 gate B6 — a second opinion on Dev Autopilot fix
 * verification. (docs/JEV-INTEGRATION-PLAN.md §10.4 B6)
 *
 *   fix_verification   (JEV_FIX_VERIFICATION_MODE = off | shadow | enforce)
 *
 * The watcher's verdict is rules: no new error events attributable to other
 * work in the 30-minute window after deploy, plus a re-probe of the finding's
 * HTTP endpoint when it has one. A finding with no probeable endpoint (most
 * code-quality findings) passes on "no new errors" alone, which says nothing
 * about whether the original problem is gone.
 *
 * At each verdict (pass, blast-radius fail, re-probe fail), fire-and-forget,
 * Jev `fix_verification` is asked whether the finding's problem is resolved
 * and whether the evidence is enough to tell — from the finding text, the
 * plan's file paths and the rules' window summary (never code). One
 * `jev_shadow_decisions` row per execution next to the rules' verdict, with
 * agreement written at once. The transition, events and self-heal bridge are
 * unchanged; no enforce behaviour (e.g. holding a pass Jev doubts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevGateSkip, recordJevShadowDecision } from '../jev-shadow';

export const FIX_VERIFICATION_GATE = 'fix_verification';
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-watcher', system: true } as const;

export interface FixVerdict {
  state: 'pass' | 'fail';
  reason: string | null;
  blast_radius: number;
  probe: { endpoint: string; healthy: boolean; http_status: number | null } | null;
}

export interface FixContext {
  title: string;
  summary: string;
  source_type: string | null;
  files: string[];
}

/** The rules' verdict as one plain line for Jev. */
export function verdictText(v: FixVerdict): string {
  const parts = [
    `rules verdict: ${v.state}${v.reason ? ` (${v.reason})` : ''}`,
    `new error events from other work in the window: ${v.blast_radius}`,
    v.probe ? `re-probe of ${v.probe.endpoint}: ${v.probe.healthy ? 'healthy' : `unhealthy (${v.probe.http_status ?? 'no response'})`}` : 'no probeable endpoint for this finding',
  ];
  return parts.join('\n').slice(0, 2000);
}

export function isFixVerificationOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(FIX_VERIFICATION_GATE, env) !== 'off';
}

/** Never throws. Returns the shadow row id, or null when off/skipped/failed. */
export async function runFixVerificationCheck(a: {
  executionId: string;
  verdict: FixVerdict;
  load: () => Promise<FixContext | null>;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(FIX_VERIFICATION_GATE, env);
  if (mode === 'off') return null;
  // VTID-05012: a gate that is on but does not ask Jev records why.
  const skip = (reason: string) =>
    recordJevGateSkip(
      { gate: FIX_VERIFICATION_GATE, decision: 'fix_verification', mode, reason, subject_type: 'dev_autopilot_execution', subject_ref: a.executionId, system_action: `verification_${a.verdict.state}` },
      a.sb,
    );
  try {
    const ctx = await a.load();
    if (!ctx || !(ctx.title || ctx.summary)) {
      await skip('no_fix_context');
      return null;
    }
    const finding = [ctx.title, ctx.summary].filter(Boolean).join('\n').slice(0, 3000);
    const r = await decide(
      'fix_verification',
      { finding, changed_files: ctx.files.slice(0, 60), verification: verdictText(a.verdict), source_type: ctx.source_type ?? undefined },
      SYSTEM_CALLER,
      { ...(a.decideOptions || {}), source: `gate:${FIX_VERIFICATION_GATE}`, env },
    );
    const resolved = r.ok && r.outcome === 'decided' ? r.verdict.value === true : null;
    const agreed = resolved === null ? null : resolved === (a.verdict.state === 'pass');
    return await recordJevShadowDecision(
      {
        gate: FIX_VERIFICATION_GATE,
        decision: 'fix_verification',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_autopilot_execution',
        subject_ref: a.executionId,
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? {
              resolved,
              probability: r.answers.resolved?.probability ?? null,
              evidence_sufficient: r.answers.evidence_sufficient?.probability ?? null,
              rule_state: a.verdict.state,
              probed: a.verdict.probe !== null,
            }
          : { reason: r.reason, rule_state: a.verdict.state, probed: a.verdict.probe !== null },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: `verification_${a.verdict.state}`,
        agreed,
        outcome: agreed === null ? null : 'compared_with_rules',
        outcome_at: agreed === null ? null : new Date().toISOString(),
        cost_usd: r.ok ? r.cost_usd : 0,
      },
      a.sb === undefined ? getSupabase() : a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${FIX_VERIFICATION_GATE} check failed for ${a.executionId}: ${err?.message || err}`);
    await skip('error');
    return null;
  }
}

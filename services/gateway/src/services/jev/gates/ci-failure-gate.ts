/**
 * VTID-04800: Jev P2 gate A6 — what kind of CI failure is a Dev Autopilot
 * PR's failing check? (docs/JEV-INTEGRATION-PLAN.md §10.4 A6)
 *
 *   ci_failure_routing   (JEV_CI_FAILURE_ROUTING_MODE = off | shadow | enforce)
 *
 * Every failing check today goes to the same place: self-healing fix mode,
 * which re-runs the coding agent. That is right for a failing test or a type
 * error, wrong for a governance gate (the evidence pack, not the code, is
 * what failed — 8 of the 21 failing checks in the 30 days to 2026-10-01 were
 * `validate-pr`) and wasted on infrastructure (a runner lost mid-run).
 *
 * Runs where the watcher marks the execution `ci → failed`, after it has
 * fetched the failing jobs' log excerpts; fire-and-forget, so the
 * transition, the event and the self-heal bridge are unchanged. For each
 * failing check with an excerpt (≤ CI_LOG_MAX_JOBS), Jev `ci_failure_bucket`
 * names the bucket from the check name and the bounded log excerpt; a
 * small rule set buckets the same check from its name and well-known log
 * lines. One `jev_shadow_decisions` row per execution (subject = its id),
 * with both answers per check; where the rules recognised a check,
 * agreement is written at once. No enforce behaviour yet: routing a
 * governance or infrastructure failure away from fix mode is a later slice.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevGateSkip, recordJevShadowDecision } from '../jev-shadow';

export const CI_FAILURE_GATE = 'ci_failure_routing';
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-watcher', system: true } as const;

export type CiBucket = 'test_failure' | 'type_error' | 'lint' | 'governance_gate' | 'dependency' | 'infrastructure';

/** Repository governance checks, by name (scripts/ci + .github/workflows). */
const GOVERNANCE_CHECK_RE = /^(validate-pr|validate|change-suite|scan|path ownership guard|enforce phase 2b naming standards|check-phase-2b-docs|validate services structure|command hub ownership guard)$/i;

/** Rule bucket from the check name and log excerpt; null when unsure. */
export function ruleBucket(checkName: string, excerpt: string): CiBucket | null {
  if (GOVERNANCE_CHECK_RE.test(checkName.trim())) return 'governance_gate';
  const log = excerpt || '';
  if (/lost communication with the server|runner has received a shutdown|The operation was canceled|No space left on device|ECONNRESET|ETIMEDOUT|\b50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)/i.test(log)) return 'infrastructure';
  if (/npm ERR!|ERR_PNPM|ETARGET|Could not resolve dependency|ERESOLVE|Cannot find module '[^.\/]/i.test(log)) return 'dependency';
  if (/error TS\d{3,5}:/.test(log)) return 'type_error';
  if (/\beslint\b|prettier --check|\d+ problems? \(\d+ errors?/i.test(log)) return 'lint';
  if (/^\s*FAIL\s+\S+\.(test|spec)\.[jt]sx?|●\s.+›|AssertionError|Tests:\s+\d+ failed/m.test(log)) return 'test_failure';
  return null;
}

export interface CiCheckEvidence {
  check_name: string;
  excerpt: string;
  unavailable?: boolean;
}

export function isCiFailureRoutingOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(CI_FAILURE_GATE, env) !== 'off';
}

/** Never throws. Returns the shadow row id, or null when off/skipped/failed. */
export async function runCiFailureRouting(a: {
  executionId: string;
  failedChecks: string[];
  evidence: CiCheckEvidence[];
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(CI_FAILURE_GATE, env);
  if (mode === 'off') return null;
  // VTID-05012: a gate that is on but does not ask Jev records why.
  const skip = (reason: string) =>
    recordJevGateSkip(
      { gate: CI_FAILURE_GATE, decision: 'ci_failure_bucket', mode, reason, subject_type: 'dev_autopilot_execution', subject_ref: a.executionId, system_action: 'self_heal_fix_mode' },
      a.sb,
    );
  try {
    const usable = a.evidence.filter((e) => !e.unavailable && e.excerpt && e.excerpt.trim()).slice(0, 3);
    if (usable.length === 0) {
      await skip('no_ci_evidence');
      return null;
    }

    const checks: Array<{ check: string; jev: string | null; rule: CiBucket | null; confidence: number | null; reason?: string }> = [];
    let cost = 0;
    let decided = 0;
    let compared = 0;
    let matched = 0;
    for (const e of usable) {
      const rule = ruleBucket(e.check_name, e.excerpt);
      const r = await decide('ci_failure_bucket', { check_name: e.check_name.slice(0, 200), log_excerpt: e.excerpt.slice(0, 8000) }, SYSTEM_CALLER, {
        ...(a.decideOptions || {}), source: `gate:${CI_FAILURE_GATE}`, env,
      });
      const jev = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
      if (r.ok) cost += r.cost_usd;
      if (jev) decided++;
      if (jev && rule) {
        compared++;
        if (jev === rule) matched++;
      }
      checks.push({ check: e.check_name, jev, rule, confidence: r.ok ? r.verdict.confidence : null, ...(r.ok ? {} : { reason: r.reason }) });
    }
    const agreed = compared > 0 ? matched === compared : null;
    return await recordJevShadowDecision(
      {
        gate: CI_FAILURE_GATE,
        decision: 'ci_failure_bucket',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_autopilot_execution',
        subject_ref: a.executionId,
        jev_outcome: decided > 0 ? 'decided' : 'fallback',
        jev_verdict: { checks, failed_checks: a.failedChecks.slice(0, 20) },
        jev_confidence: null,
        system_action: 'self_heal_fix_mode',
        agreed,
        outcome: agreed === null ? null : 'compared_with_rules',
        outcome_at: agreed === null ? null : new Date().toISOString(),
        cost_usd: cost,
      },
      a.sb === undefined ? getSupabase() : a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${CI_FAILURE_GATE} check failed for ${a.executionId}: ${err?.message || err}`);
    await skip('error');
    return null;
  }
}

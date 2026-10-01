/**
 * VTID-04754: the Jev shadow framework (docs/JEV-INTEGRATION-PLAN.md §10.5).
 *
 * Every new Jev gate ships in shadow mode first. One kill switch per gate:
 *
 *   JEV_<GATE>_MODE = off | shadow | enforce     (exact values; default off)
 *
 *   off      no Jev call, nothing recorded — the system's own path only
 *   shadow   Jev is asked, the verdict is recorded next to what the system
 *            actually did, and the system's own path still decides
 *   enforce  the verdict is used when Jev decided (not abstained/fell back);
 *            the row is still recorded so agreement stays measurable
 *
 * Any other value is treated as off and logged once — a typo can never
 * silently enforce. The later outcome (was the system / Jev right?) is
 * written back with recordJevShadowOutcome, giving the agreement rate per
 * gate that decides whether a gate may move from shadow to enforce.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabase';
import { decide, DecideOptions, JevDecisionResult } from './jev-decision-service';
import { resolveJevAccess, JevCaller } from './jev-access';
import * as repo from './jev-repository';

export type JevGateMode = 'off' | 'shadow' | 'enforce';
const MODES: readonly JevGateMode[] = ['off', 'shadow', 'enforce'];

export function jevGateEnvName(gate: string): string {
  return `JEV_${gate.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODE`;
}

const warned = new Set<string>();

export function jevGateMode(gate: string, env: NodeJS.ProcessEnv = process.env): JevGateMode {
  const name = jevGateEnvName(gate);
  const raw = env[name];
  if (raw === undefined || raw === '') return 'off';
  if ((MODES as readonly string[]).includes(raw)) return raw as JevGateMode;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[jev] ${name}=${JSON.stringify(raw)} is not off|shadow|enforce — gate stays off`);
  }
  return 'off';
}

export interface JevGateRun {
  gate: string;
  mode: JevGateMode;
  /** True only in enforce mode on a confident decision: the caller may act on `result.verdict`. */
  enforce: boolean;
  result?: JevDecisionResult;
  shadow_id?: string | null;
}

export interface RunJevGateArgs {
  gate: string;
  decision: string;
  input: unknown;
  caller: JevCaller;
  subject: { type: string; ref: string };
  /** What the system did (or will do) on its own path, recorded for comparison. */
  systemAction: string;
  source: string;
  env?: NodeJS.ProcessEnv;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
  sb?: SupabaseClient | null;
}

/** Never throws; an 'off' gate costs nothing. */
export async function runJevGate(a: RunJevGateArgs): Promise<JevGateRun> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(a.gate, env);
  if (mode === 'off') return { gate: a.gate, mode, enforce: false };

  const result = await decide(a.decision, a.input, a.caller, { ...(a.decideOptions || {}), source: `gate:${a.gate}:${a.source}`, env });
  const access = resolveJevAccess(a.caller, env);
  const shadow_id = await recordJevShadowDecision(
    {
      gate: a.gate,
      decision: a.decision,
      mode,
      plane: result.ok ? result.plane : (result.plane ?? access.plane ?? 'internal'),
      tenant_id: a.caller.tenant_id ?? null,
      subject_type: a.subject.type,
      subject_ref: a.subject.ref,
      jev_outcome: result.outcome,
      jev_verdict: result.ok ? { primary: result.verdict, answers: result.answers } : { reason: result.reason },
      jev_confidence: result.ok ? result.verdict.confidence : null,
      system_action: a.systemAction,
      cost_usd: result.ok ? result.cost_usd : 0,
    },
    a.sb,
  );
  return { gate: a.gate, mode, enforce: mode === 'enforce' && result.ok && result.outcome === 'decided', result, shadow_id };
}

export async function recordJevShadowDecision(row: Record<string, unknown>, sbOverride?: SupabaseClient | null): Promise<string | null> {
  const sb = sbOverride === undefined ? getSupabase() : sbOverride;
  if (!sb) {
    console.error(`[jev] shadow row NOT recorded (no Supabase client) gate=${row.gate}`);
    return null;
  }
  try {
    const { data, error } = await repo.insertShadowDecision(sb, row);
    if (error) {
      console.error(`[jev] shadow row NOT recorded gate=${row.gate}: ${error.message}`);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (err: any) {
    console.error(`[jev] shadow row NOT recorded gate=${row.gate}: ${err?.message || err}`);
    return null;
  }
}

/** Writes the real outcome back; `agreed` = Jev's verdict matched what turned out right. */
export async function recordJevShadowOutcome(
  id: string,
  outcome: string,
  agreed: boolean | null,
  sbOverride?: SupabaseClient | null,
): Promise<boolean> {
  const sb = sbOverride === undefined ? getSupabase() : sbOverride;
  if (!sb) return false;
  const { error } = await repo.updateShadowOutcome(sb, id, { outcome, agreed, outcome_at: new Date().toISOString() });
  if (error) {
    console.error(`[jev] shadow outcome NOT recorded id=${id}: ${error.message}`);
    return false;
  }
  return true;
}

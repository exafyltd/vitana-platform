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

export interface JevGateSkip {
  gate: string;
  decision: string;
  /** The gate's current mode. Callers only skip after their own `off` check, so never 'off'. */
  mode: Exclude<JevGateMode, 'off'>;
  /** Short machine reason, e.g. 'no_ci_evidence', 'error'. */
  reason: string;
  subject_type: string;
  subject_ref: string;
  system_action: string;
  plane?: string;
  tenant_id?: string | null;
}

/**
 * VTID-05012: a gate that is on but ends without asking Jev writes a $0 'skipped' row, so a skip
 * is visible instead of looking like a gate that never ran. One row per (gate, subject_ref,
 * reason): a repeat hits the partial unique index and is treated as already recorded.
 * Never throws; returns the new row id, or null (no client, duplicate, insert error).
 */
export async function recordJevGateSkip(s: JevGateSkip, sbOverride?: SupabaseClient | null): Promise<string | null> {
  if (!s.subject_ref) return null;
  const sb = sbOverride === undefined ? getSupabase() : sbOverride;
  if (!sb) {
    console.error(`[jev] skip row NOT recorded (no Supabase client) gate=${s.gate}`);
    return null;
  }
  try {
    const { data, error } = await repo.insertShadowDecision(sb, {
      gate: s.gate,
      decision: s.decision,
      mode: s.mode,
      plane: s.plane ?? 'internal',
      tenant_id: s.tenant_id ?? null,
      subject_type: s.subject_type,
      subject_ref: s.subject_ref.slice(0, 500),
      jev_outcome: 'skipped',
      skip_reason: s.reason.slice(0, 100),
      jev_verdict: null,
      jev_confidence: null,
      system_action: s.system_action,
      cost_usd: 0,
    });
    if (error) {
      if ((error as { code?: string }).code === '23505') return null; // already recorded
      console.error(`[jev] skip row NOT recorded gate=${s.gate}: ${error.message}`);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (err: any) {
    console.error(`[jev] skip row NOT recorded gate=${s.gate}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Writes the real outcome back; `agreed` = Jev's verdict matched what turned out right.
 * VTID-05012: `leanAgreed` is the same comparison for an abstained row's below-threshold answer;
 * omitted, the column is left untouched.
 */
export async function recordJevShadowOutcome(
  id: string,
  outcome: string,
  agreed: boolean | null,
  sbOverride?: SupabaseClient | null,
  leanAgreed?: boolean | null,
): Promise<boolean> {
  const sb = sbOverride === undefined ? getSupabase() : sbOverride;
  if (!sb) return false;
  const patch: Record<string, unknown> = { outcome, agreed, outcome_at: new Date().toISOString() };
  if (leanAgreed !== undefined) patch.lean_agreed = leanAgreed;
  const { error } = await repo.updateShadowOutcome(sb, id, patch);
  if (error) {
    console.error(`[jev] shadow outcome NOT recorded id=${id}: ${error.message}`);
    return false;
  }
  return true;
}

export const JEV_SILENT_AFTER_MS = 48 * 60 * 60 * 1000;

export interface JevGateHealth {
  gate: string;
  env: string;
  mode: Exclude<JevGateMode, 'off'>;
  last_row_at: string | null;
  silent: boolean;
}

/**
 * VTID-05012: every gate that is on (per its JEV_*_MODE env var) with the time of its newest row in
 * the stats window; `silent` when it has written no row of any kind (skipped included) in 48 h.
 * Pure: the caller passes the stats rows, the env and the clock.
 */
export function jevGateHealth(
  stats: Array<{ gate: string; last_row_at?: string | null }> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): JevGateHealth[] {
  const last = new Map((stats || []).map((s) => [s.gate, s.last_row_at ?? null]));
  const out: JevGateHealth[] = [];
  for (const name of Object.keys(env).sort()) {
    const m = /^JEV_([A-Z0-9_]+)_MODE$/.exec(name);
    if (!m) continue;
    const gate = m[1].toLowerCase();
    const mode = jevGateMode(gate, env);
    if (mode === 'off') continue;
    const lastRowAt = last.get(gate) ?? null;
    const ts = lastRowAt ? Date.parse(lastRowAt) : NaN;
    out.push({ gate, env: name, mode, last_row_at: lastRowAt, silent: !Number.isFinite(ts) || nowMs - ts > JEV_SILENT_AFTER_MS });
  }
  return out;
}

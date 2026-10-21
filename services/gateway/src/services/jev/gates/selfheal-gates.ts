/**
 * VTID-04759: the first two Jev P1 gates (docs/JEV-INTEGRATION-PLAN.md §10.4,
 * B1 + B2), run before self-healing triage spends an LLM call.
 *
 *   selfheal_provider_failure  (JEV_SELFHEAL_PROVIDER_FAILURE_MODE)  — B2
 *     What kind of provider failure is this? credit / permission / quota /
 *     executor_unavailable → stop and alert (no retry or triage can help);
 *     throttle → back off; transient → retry once; input_too_large → a code
 *     problem, triage proceeds; unknown → triage proceeds.
 *
 *   selfheal_incident_dedupe   (JEV_SELFHEAL_INCIDENT_DEDUPE_MODE)   — B1
 *     Is this the same open incident as one triaged in the last 30 minutes?
 *     Key: failure class + providers for a provider failure, else the
 *     endpoint. One outage becomes one incident, not one per execution.
 *
 * Why rules first: 14 days of production llm.call.failed (2026-09-30) are a
 * handful of fixed provider strings — Bedrock "Operation not allowed" 2,187,
 * DeepSeek 402 "Insufficient Balance" 634, "Too many tokens per day" 18,
 * "prompt is too long" 14. A rule answers those exactly and for free. Jev
 * (ops_error_triage) is asked only for text the rules do not recognise.
 *
 *   selfheal_pretriage         (JEV_SELFHEAL_PRETRIAGE_MODE)         — B3 (VTID-04799)
 *     For an incident that is NOT a provider failure: Jev ops_error_triage
 *     names the cause class (transient / configuration / code_defect /
 *     dependency / data) and whether a human is needed, before the triage
 *     LLM call. Agreement comes from triage's own report: "not transient"
 *     should match a warning/critical report, "transient" an info one.
 *     enforce skips triage only for a decided "transient".
 *
 * All gates default to off (no read, no write, no call). shadow records a
 * jev_shadow_decisions row and triage runs as before. enforce skips triage
 * when the gate says so; the caller escalates exactly as on a failed triage.
 * The outcome is written back from triage's own result, so the agreement
 * rate per gate is measured without anyone labelling rows.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { PROVIDER_OUTAGE_RE, OUTAGE_WINDOW_MS } from '../../dev-autopilot-retry-breaker';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome, JevGateMode } from '../jev-shadow';
import * as repo from '../jev-repository';

export const PROVIDER_FAILURE_GATE = 'selfheal_provider_failure';
export const INCIDENT_DEDUPE_GATE = 'selfheal_incident_dedupe';
export const PRETRIAGE_GATE = 'selfheal_pretriage';

export type ProviderFailureClass =
  | 'credit'
  | 'permission'
  | 'quota'
  | 'executor_unavailable'
  | 'throttle'
  | 'transient'
  | 'input_too_large'
  | 'unknown'
  | 'none';

export type ProviderFailureAction = 'stop_and_alert' | 'back_off' | 'retry_once' | 'triage';

const RULES: Array<{ cls: Exclude<ProviderFailureClass, 'unknown' | 'none'>; re: RegExp }> = [
  // Order = severity: the first match wins, so "primary 402; fallback 502"
  // is a credit problem, not a blip.
  { cls: 'credit', re: /\b402\b|insufficient.?balance|credit balance|payment required|billing/i },
  { cls: 'permission', re: /operation not allowed|AccessDenied\w*|not authori[sz]ed|account is currently blocked|\b403\b|forbidden|invalid api key|\b401\b/i },
  { cls: 'quota', re: /too many tokens per day|ServiceQuotaExceeded\w*|quota exceeded|daily limit/i },
  { cls: 'executor_unavailable', re: /executor task could not be started/i },
  { cls: 'input_too_large', re: /prompt is too long|context length|maximum context|too many (input )?tokens\b(?! per day)/i },
  { cls: 'throttle', re: /\b429\b|Throttling\w*|rate.?limit|too many requests/i },
  { cls: 'transient', re: /\b5(?:0[0-4]|29)\b|bad gateway|ServiceUnavailable\w*|timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|overloaded/i },
];

const ACTION: Record<ProviderFailureClass, ProviderFailureAction> = {
  credit: 'stop_and_alert',
  permission: 'stop_and_alert',
  quota: 'stop_and_alert',
  executor_unavailable: 'stop_and_alert',
  throttle: 'back_off',
  transient: 'retry_once',
  input_too_large: 'triage',
  unknown: 'triage',
  none: 'triage',
};

const PROVIDER_NAMES = /\b(bedrock|deepseek|anthropic|openai|vertex|gemini|claude_subscription|nova|polly|fish|typesafe|jev)\b/gi;
const PROVIDER_SIGNAL = /LLM call failed|both providers failed|invoke_failed|provider|\b(bedrock|deepseek|anthropic|openai|vertex)\b/i;

export interface ProviderFailureVerdict {
  cls: ProviderFailureClass;
  action: ProviderFailureAction;
  providers: string[];
}

export function classifyProviderFailure(text: string | null | undefined): ProviderFailureVerdict {
  const t = (text || '').trim();
  if (!t) return { cls: 'none', action: 'triage', providers: [] };
  const providers = Array.from(new Set((t.match(PROVIDER_NAMES) || []).map((p) => p.toLowerCase()))).sort();
  // Only a provider call is this classifier's business: a 403 or a 502 from
  // one of our own endpoints is a code/config problem and must be triaged.
  const isProvider = PROVIDER_SIGNAL.test(t) || PROVIDER_OUTAGE_RE.test(t);
  if (!isProvider) return { cls: 'none', action: 'triage', providers };
  for (const r of RULES) if (r.re.test(t)) return { cls: r.cls, action: ACTION[r.cls], providers };
  // The retry breaker's outage pattern is authoritative for what it names.
  if (PROVIDER_OUTAGE_RE.test(t)) return { cls: 'permission', action: 'stop_and_alert', providers };
  return { cls: 'unknown', action: 'triage', providers };
}

/** The error text of a triage input, wherever its caller put it. */
export function failureTextOf(input: {
  failure?: { error?: string } | null;
  original_diagnosis?: Record<string, unknown> | null;
  diagnosis?: Record<string, unknown> | null;
  failure_class?: string | null;
}): string {
  const parts: unknown[] = [
    input.failure?.error,
    input.original_diagnosis?.error,
    input.original_diagnosis?.error_message,
    input.diagnosis?.error,
    input.diagnosis?.error_message,
    input.diagnosis?.root_cause,
  ];
  return parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join(' | ').slice(0, 4000);
}

export function incidentKey(
  verdict: ProviderFailureVerdict,
  input: { endpoint?: string | null; failure?: { endpoint?: string } | null; vtid: string },
): string {
  if (verdict.action === 'stop_and_alert' || verdict.action === 'back_off') {
    return `provider:${verdict.cls}:${verdict.providers.join('+') || 'any'}`;
  }
  const endpoint = input.endpoint || input.failure?.endpoint;
  return endpoint ? `endpoint:${endpoint}` : `vtid:${input.vtid}`;
}

export interface SelfHealGateResult {
  /** Set only by an enforced gate: triage must not run, and why. */
  skip: { gate: string; reason: string } | null;
  provider: { mode: JevGateMode; verdict: ProviderFailureVerdict; shadow_id: string | null };
  dedupe: { mode: JevGateMode; key: string; duplicate_of: string | null; shadow_id: string | null };
  /** VTID-04799 (B3). `cause` is null when the gate was off, not asked, or Jev did not decide. */
  pretriage?: { mode: JevGateMode; cause: string | null; needs_human: boolean | null; shadow_id: string | null };
}

export interface SelfHealGateInput {
  vtid: string;
  mode: string;
  endpoint?: string | null;
  failure?: { endpoint?: string; error?: string } | null;
  original_diagnosis?: Record<string, unknown> | null;
  diagnosis?: Record<string, unknown> | null;
  failure_class?: string | null;
}

export interface SelfHealGateOptions {
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  now?: () => number;
  /** Test seam for the Jev call on unrecognised text. */
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}

const SYSTEM_CALLER = { actor_id: 'self-healing-triage', system: true } as const;

/** Never throws; with both gates off it does nothing at all. */
export async function runSelfHealGates(input: SelfHealGateInput, opts: SelfHealGateOptions = {}): Promise<SelfHealGateResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const pMode = jevGateMode(PROVIDER_FAILURE_GATE, env);
  const dMode = jevGateMode(INCIDENT_DEDUPE_GATE, env);
  const tMode = jevGateMode(PRETRIAGE_GATE, env);
  const verdict = classifyProviderFailure(failureTextOf(input));
  const key = incidentKey(verdict, input);
  const result: SelfHealGateResult = {
    skip: null,
    provider: { mode: pMode, verdict, shadow_id: null },
    dedupe: { mode: dMode, key, duplicate_of: null, shadow_id: null },
    pretriage: { mode: tMode, cause: null, needs_human: null, shadow_id: null },
  };
  if (pMode === 'off' && dMode === 'off' && tMode === 'off') return result;

  const sb = opts.sb === undefined ? getSupabase() : opts.sb;

  try {
    // B1 first: the lookup must not see the row this run is about to write.
    if (dMode !== 'off') {
      let duplicateOf: string | null = null;
      if (sb) {
        const since = new Date(now() - OUTAGE_WINDOW_MS).toISOString();
        const { data, error } = await repo.fetchRecentShadowBySubject(sb, INCIDENT_DEDUPE_GATE, key, since);
        if (error) console.warn(`[jev] ${INCIDENT_DEDUPE_GATE} lookup failed: ${error.message}`);
        else duplicateOf = (data as { id?: string; subject_ref?: string } | null)?.id ? key : null;
      }
      result.dedupe.duplicate_of = duplicateOf;
      result.dedupe.shadow_id = await recordJevShadowDecision(
        {
          gate: INCIDENT_DEDUPE_GATE,
          decision: 'rules:incident_key',
          mode: dMode,
          plane: 'internal',
          tenant_id: null,
          subject_type: 'incident',
          subject_ref: key,
          jev_outcome: 'decided',
          jev_verdict: { source: 'rules', duplicate: duplicateOf !== null, key, triage_vtid: input.vtid, triage_mode: input.mode },
          jev_confidence: 1,
          system_action: 'triage',
          cost_usd: 0,
        },
        sb,
      );
      if (dMode === 'enforce' && duplicateOf) result.skip = { gate: INCIDENT_DEDUPE_GATE, reason: `duplicate_open_incident:${key}` };
    }

    // B2 — only a provider failure is this gate's business.
    if (pMode !== 'off' && verdict.cls !== 'none') {
      let jev: Record<string, unknown> | null = null;
      let cost = 0;
      if (verdict.cls === 'unknown') {
        const r = await decide(
          'ops_error_triage',
          { service: 'self-healing-triage', message: failureTextOf(input) },
          SYSTEM_CALLER,
          { ...(opts.decideOptions || {}), source: `gate:${PROVIDER_FAILURE_GATE}`, env },
        );
        jev = r.ok ? { outcome: r.outcome, cause: r.verdict.value, confidence: r.verdict.confidence, needs_human: r.answers.needs_human?.value } : { outcome: r.outcome, reason: r.reason };
        cost = r.ok ? r.cost_usd : 0;
      }
      result.provider.shadow_id = await recordJevShadowDecision(
        {
          gate: PROVIDER_FAILURE_GATE,
          decision: verdict.cls === 'unknown' ? 'ops_error_triage' : 'rules:provider_failure',
          mode: pMode,
          plane: 'internal',
          tenant_id: null,
          subject_type: 'triage',
          subject_ref: input.vtid,
          jev_outcome: 'decided',
          jev_verdict: { source: verdict.cls === 'unknown' ? 'rules+jev' : 'rules', class: verdict.cls, action: verdict.action, providers: verdict.providers, jev },
          jev_confidence: verdict.cls === 'unknown' ? (typeof jev?.confidence === 'number' ? (jev.confidence as number) : null) : 1,
          system_action: 'triage',
          cost_usd: cost,
        },
        sb,
      );
      if (pMode === 'enforce' && verdict.action === 'stop_and_alert' && !result.skip) {
        result.skip = { gate: PROVIDER_FAILURE_GATE, reason: `provider_${verdict.cls}` };
      }
    }

    // B3 — every incident B2 does not own: what kind of error is this?
    const text = failureTextOf(input);
    if (tMode !== 'off' && verdict.cls === 'none' && text) {
      const r = await decide(
        'ops_error_triage',
        {
          service: (input.failure?.endpoint || input.endpoint || 'self-healing').slice(0, 120),
          topic: `self-healing:${input.mode}`,
          message: text,
          context: input.failure_class ? `failure class: ${input.failure_class}` : undefined,
        },
        SYSTEM_CALLER,
        { ...(opts.decideOptions || {}), source: `gate:${PRETRIAGE_GATE}`, env },
      );
      const decided = r.ok && r.outcome === 'decided';
      const cause = decided ? String(r.verdict.value) : null;
      const needsHuman = r.ok && typeof r.answers.needs_human?.value === 'boolean' ? (r.answers.needs_human.value as boolean) : null;
      result.pretriage = {
        mode: tMode,
        cause,
        needs_human: needsHuman,
        shadow_id: await recordJevShadowDecision(
          {
            gate: PRETRIAGE_GATE,
            decision: 'ops_error_triage',
            mode: tMode,
            plane: 'internal',
            tenant_id: null,
            subject_type: 'triage',
            subject_ref: input.vtid,
            jev_outcome: r.outcome,
            jev_verdict: r.ok ? { cause: r.verdict.value, needs_human: needsHuman, triage_mode: input.mode } : { reason: r.reason, triage_mode: input.mode },
            jev_confidence: r.ok ? r.verdict.confidence : null,
            system_action: 'triage',
            cost_usd: r.ok ? r.cost_usd : 0,
          },
          sb,
        ),
      };
      if (tMode === 'enforce' && cause === 'transient' && !result.skip) {
        result.skip = { gate: PRETRIAGE_GATE, reason: 'pretriage_transient' };
      }
    }
  } catch (err: any) {
    // A gate must never break triage: on any error, triage runs as before.
    console.warn(`[jev] self-heal gates failed, triage proceeds: ${err?.message || err}`);
    result.skip = null;
  }
  return result;
}

/**
 * Writes the outcome back once triage has run (or was skipped).
 * Provider gate agreement: the gate said "stop" iff triage itself then died
 * on a stop-class provider failure — triage was futile exactly when predicted.
 */
export async function recordSelfHealGateOutcome(
  gates: SelfHealGateResult,
  triage: { ok: boolean; error?: string | null; skipped?: boolean },
  sb?: SupabaseClient | null,
): Promise<void> {
  try {
    const outcome = triage.skipped ? 'skipped_by_gate' : triage.ok ? 'triage_ok' : `triage_failed:${classifyProviderFailure(triage.error).cls}`;
    if (gates.provider.shadow_id && !triage.skipped) {
      const predictedStop = gates.provider.verdict.action === 'stop_and_alert';
      const triageDiedOnOutage = !triage.ok && classifyProviderFailure(triage.error).action === 'stop_and_alert';
      await recordJevShadowOutcome(gates.provider.shadow_id, outcome, predictedStop === triageDiedOnOutage, sb);
    } else if (gates.provider.shadow_id) {
      await recordJevShadowOutcome(gates.provider.shadow_id, outcome, null, sb);
    }
    if (gates.dedupe.shadow_id) await recordJevShadowOutcome(gates.dedupe.shadow_id, outcome, null, sb);
    // B3 is judged against the parsed report (recordPretriageOutcome); a
    // triage that never produced one leaves its row without agreement.
    if (gates.pretriage?.shadow_id && (triage.skipped || !triage.ok)) await recordJevShadowOutcome(gates.pretriage.shadow_id, outcome, null, sb);
  } catch (err: any) {
    console.warn(`[jev] self-heal gate outcome not recorded: ${err?.message || err}`);
  }
}

/**
 * VTID-04799 (B3): agreement from triage's own report. Jev "transient" should
 * come with an info-severity report; any other cause with warning/critical.
 */
export async function recordPretriageOutcome(
  gates: SelfHealGateResult,
  report: { severity: string },
  sb?: SupabaseClient | null,
): Promise<void> {
  try {
    const p = gates.pretriage;
    if (!p?.shadow_id) return;
    const agreed = p.cause ? (p.cause === 'transient') === (report.severity === 'info') : null;
    await recordJevShadowOutcome(p.shadow_id, `triage_ok:${report.severity}`, agreed, sb);
  } catch (err: any) {
    console.warn(`[jev] ${PRETRIAGE_GATE} outcome not recorded: ${err?.message || err}`);
  }
}

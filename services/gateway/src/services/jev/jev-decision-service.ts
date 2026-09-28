/**
 * VTID-04473: the one entry point every Jev caller goes through.
 *
 *   gate (role → plane) → decision lookup → input validation → state build
 *   → PII policy → size bound → callJev → answer interpretation
 *   → confidence threshold → telemetry
 *
 * Never throws. A decision that cannot be made returns outcome 'fallback'
 * with a named reason, so the caller keeps its existing path — never a
 * silent default (CLAUDE.md NEVER 35). An answer under the decision's
 * threshold returns 'abstained' with the answers attached for display, and
 * the caller must treat it like a fallback.
 */

import { callJev, jevModel, JevCallResult } from './jev-client';
import {
  choiceProbability,
  scoreLevel,
  JevAnswer,
  JevAnswers,
  JevChoiceAnswer,
  JevNoulAnswer,
  JevQuestion,
  JevScoreAnswer,
} from './jev-types';
import { resolveJevAccess, roleMayUseDecision, JevCaller, JevPlane } from './jev-access';
import { applyPiiPolicy } from './jev-pii';
import { getJevDecision, JevDecisionDef } from './jev-decisions';
import { emitJevDecisionEvent, jevCostUsd, JevOutcome } from './jev-telemetry';

/** Jev allows 64k tokens per request; stay far below it without a tokenizer. */
export const JEV_MAX_STATE_CHARS = 60_000;
export const JEV_MAX_BATCH = 500;
export const JEV_DEFAULT_CONCURRENCY = 8;

export interface InterpretedAnswer {
  type: JevQuestion['type'];
  /** noul: probability of yes; choice: the chosen option; score: 0-based level. */
  value: boolean | string | number;
  label?: string;
  probability?: number;
  confidence: number;
}

export type JevDecisionResult =
  | {
      ok: true;
      decision: string;
      outcome: 'decided' | 'abstained';
      verdict: InterpretedAnswer;
      answers: Record<string, InterpretedAnswer>;
      plane: JevPlane;
      model: string;
      input_tokens: number;
      cost_usd: number;
      latency_ms: number;
      redactions: number;
    }
  | {
      ok: false;
      decision: string;
      outcome: 'fallback' | 'denied' | 'invalid';
      reason: string;
      detail?: string;
      status?: number;
      plane?: JevPlane | null;
    };

export interface DecideOptions {
  source: string;
  /** Test seam. */
  call?: (args: Parameters<typeof callJev>[0]) => Promise<JevCallResult>;
  env?: NodeJS.ProcessEnv;
}

export function interpretAnswer(q: JevQuestion, a: JevAnswer): InterpretedAnswer {
  if (q.type === 'noul') {
    const p = (a as JevNoulAnswer).noul;
    return { type: 'noul', value: p >= 0.5, probability: p, confidence: Math.max(p, 1 - p) };
  }
  if (q.type === 'choice') {
    const c = a as JevChoiceAnswer;
    return { type: 'choice', value: c.choice, label: q.criteria[c.choice], probability: choiceProbability(c), confidence: c.confidence };
  }
  const s = a as JevScoreAnswer;
  const level = scoreLevel(s, q.criteria.length);
  return { type: 'score', value: level, label: q.criteria[level], confidence: s.confidence };
}

export function interpretAnswers(def: JevDecisionDef, answers: JevAnswers): Record<string, InterpretedAnswer> {
  const out: Record<string, InterpretedAnswer> = {};
  for (const [name, q] of Object.entries(def.questions)) out[name] = interpretAnswer(q, answers[name]);
  return out;
}

export async function decide(name: string, input: unknown, caller: JevCaller, opts: DecideOptions): Promise<JevDecisionResult> {
  const env = opts.env ?? process.env;
  const def = getJevDecision(name);
  if (!def) return { ok: false, decision: name, outcome: 'invalid', reason: 'unknown_decision', status: 404 };

  const access = resolveJevAccess(caller, env);
  if (!access.allowed) {
    return { ok: false, decision: name, outcome: 'denied', reason: access.reason, plane: access.plane, status: 403 };
  }
  if (!roleMayUseDecision(access.role, def.roles)) {
    return { ok: false, decision: name, outcome: 'denied', reason: 'decision_not_permitted_for_role', plane: access.plane, status: 403 };
  }

  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      decision: name,
      outcome: 'invalid',
      reason: 'invalid_input',
      detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      status: 400,
    };
  }

  const base = { decision: name, plane: access.plane, role: access.role, actor_id: caller.actor_id, tenant_id: caller.tenant_id ?? null, source: opts.source };
  const fallback = (reason: string, extra: Partial<{ latency_ms: number; detail: string; status: number; outcome: JevOutcome; model: string }> = {}): JevDecisionResult => {
    emitJevDecisionEvent({
      ...base,
      outcome: extra.outcome ?? 'fallback',
      reason,
      model: extra.model,
      latency_ms: extra.latency_ms ?? 0,
      input_tokens: 0,
      cost_usd: 0,
    });
    return { ok: false, decision: name, outcome: 'fallback', reason, detail: extra.detail, status: extra.status ?? 503, plane: access.plane };
  };

  const pii = applyPiiPolicy(def.buildState(parsed.data), def.pii);
  if (!pii.ok) return fallback('pii_forbidden', { detail: `contains ${pii.kinds.join(', ')}`, status: 422 });

  if (JSON.stringify(pii.value).length > JEV_MAX_STATE_CHARS) {
    return fallback('state_too_large', { status: 413 });
  }

  const call = opts.call ?? callJev;
  const res = await call({ state: pii.value, questions: def.questions, env });
  if (!res.ok) {
    // not_configured is the expected inert state, not an error.
    const outcome: JevOutcome = res.reason === 'not_configured' ? 'fallback' : 'failed';
    return fallback(res.reason, { latency_ms: res.latency_ms, detail: res.error, outcome, model: jevModel(env) });
  }

  const answers = interpretAnswers(def, res.answers);
  const verdict = answers[def.primary];
  const outcome: 'decided' | 'abstained' = verdict.confidence >= def.threshold ? 'decided' : 'abstained';
  const cost = jevCostUsd(res.model, res.usage.input_tokens);
  emitJevDecisionEvent({
    ...base,
    outcome,
    model: res.model,
    latency_ms: res.latency_ms,
    input_tokens: res.usage.input_tokens,
    cost_usd: cost,
    confidence: verdict.confidence,
    reason: outcome === 'abstained' ? 'low_confidence' : undefined,
    redactions: pii.redactions,
  });
  return {
    ok: true,
    decision: name,
    outcome,
    verdict,
    answers,
    plane: access.plane,
    model: res.model,
    input_tokens: res.usage.input_tokens,
    cost_usd: cost,
    latency_ms: res.latency_ms,
    redactions: pii.redactions,
  };
}

/**
 * Runs one decision over many inputs with bounded concurrency (Jev allows
 * 1,200 requests/minute; 8 in flight at ~1s each stays well under it).
 * Results keep input order.
 */
export async function decideMany(
  name: string,
  inputs: unknown[],
  caller: JevCaller,
  opts: DecideOptions & { concurrency?: number },
): Promise<JevDecisionResult[]> {
  const limit = Math.max(1, Math.min(opts.concurrency ?? JEV_DEFAULT_CONCURRENCY, 32));
  const results: JevDecisionResult[] = new Array(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const i = next++;
      results[i] = await decide(name, inputs[i], caller, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return results;
}

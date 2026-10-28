/**
 * VTID-04868 — Plan Sparring Gate: one partner pass (one round).
 *
 * The loop goes through `callViaRouter('plan_sparring', …)` so policy and
 * telemetry apply, ALWAYS with `allowFallback: false` (the router also
 * refuses fallback for this stage on its own — defence in depth). Requests
 * use adaptive thinking + output_config.effort 'high' (owner decision for
 * Opus 4.6); every thinking / redacted_thinking block is handed back verbatim
 * on the assistant turn it came from, which the API requires across tool turns.
 *
 * Partner tiers (owner decision 2026-10-19 — "build a fallback so sparring
 * never stops on burned quota"): Bedrock Opus 4.6 → Bedrock Sonnet 4.6 →
 * DeepSeek (`deepseek-v4-pro`). A failing Bedrock tier moves the pass to the
 * next tier for the rest of the round (sticky); only the last tier's failure
 * ends the pass with `model_unavailable`. Every switch is logged loudly and
 * every entry in model_log carries `fallback_tier`. The tiers live here, not in
 * the router: plan_sparring stays in NO_FALLBACK_STAGES, and the router only
 * lets the stage run on DeepSeek for a call flagged `planSparringLastResort`.
 * Kill switch for the DeepSeek tier: PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED=false.
 */

import type {
  LLMRouterMessage,
  LLMRouterOpts,
  LLMRouterResult,
  LLMRouterToolCall,
  LLMStage,
} from '../llm-router';
import {
  isPlanSparringDeepseekFallbackEnabled,
  resolvePlanSparringFallbackModel,
  resolvePlanSparringLastResortModel,
} from '../../constants/llm-defaults';
import { PARTNER_CODE_TOOLS, type ToolExecution } from './github-tools';
import {
  PARTNER_SYSTEM_PROMPT,
  ROUND1_MIN_VERIFIED_PREMISES,
  SUBMIT_REVIEW_TOOL,
  checkEvidence,
  parsePartnerReview,
} from './partner-prompt';
import type { EscalationReason, ModelLogEntry, PartnerReview, ToolLogEntry } from './types';

export const PARTNER_STAGE: LLMStage = 'plan_sparring';
export const PARTNER_MAX_TOOL_CALLS_PER_ROUND = 30;
export const PARTNER_MAX_TURNS_PER_ROUND = 40;
export const PARTNER_MAX_INVALID_SUBMISSIONS = 2;
export const PARTNER_MAX_OUTPUT_TOKENS = 16_000;
export const PARTNER_CONTINUE_PROMPT =
  'Tool results above. Continue gathering evidence with read_file/list_dir/search, or call submit_review when you are done.';
export const PARTNER_SUBMIT_NUDGE = 'You must finish this round by calling submit_review. Do not answer in plain text.';

export type CallLlm = (stage: LLMStage, prompt: string, opts: LLMRouterOpts) => Promise<LLMRouterResult>;
export type ExecuteTool = (name: string, args: Record<string, unknown>) => Promise<ToolExecution>;

/**
 * VTID (sparring-model-fallback): a RETRYABLE throttle on the primary partner
 * model (Opus 4.6). Matches the fresh-subscription daily-token cap
 * ("Too many tokens per day") and generic Bedrock throttling/rate-limit
 * errors. ONLY these trigger the one-shot Sonnet 4.6 fallback; auth, invalid
 * request, content and all other errors still end the pass as model_unavailable
 * with no retry.
 */
export function isRetryableThrottle(error: string | undefined): boolean {
  const e = (error || '').toLowerCase();
  return (
    /too many tokens per day/.test(e) ||
    /throttl/.test(e) ||
    /rate ?limit/.test(e) ||
    /too many requests/.test(e) ||
    /\b429\b/.test(e)
  );
}

/** One partner model tier (see runPartnerPass). */
export interface PartnerTier {
  name: 'primary' | 'bedrock_fallback' | 'deepseek';
  provider: 'bedrock' | 'deepseek';
  /** Omitted for the primary: the stage's own policy model (PLAN_SPARRING_MODEL). */
  model?: string;
}

/**
 * Owner decision 2026-10-19: a failing Bedrock tier (burned quota, throttle,
 * daily token cap, subscription/access error, outage) never ends the pass —
 * the next tier is tried. Only the LAST tier's failure ends the pass with
 * model_unavailable.
 */
export function shouldTryNextTier(tier: PartnerTier, _error: string | undefined): boolean {
  return tier.provider === 'bedrock';
}

export interface PartnerPassInput {
  round: number;
  prompt: string;
  callLlm: CallLlm;
  executeTool: ExecuteTool;
  /** Wall-clock budget for this pass. */
  deadlineMs: number;
  now?: () => number;
  maxToolCalls?: number;
}

export type PartnerPassResult =
  | {
      ok: true;
      review: PartnerReview;
      toolLog: ToolLogEntry[];
      modelLog: ModelLogEntry[];
      evidenceFloor: { required: number; verified: number; met: boolean };
    }
  | {
      ok: false;
      reason: EscalationReason;
      error: string;
      toolLog: ToolLogEntry[];
      modelLog: ModelLogEntry[];
    };

export async function runPartnerPass(input: PartnerPassInput): Promise<PartnerPassResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const maxToolCalls = input.maxToolCalls ?? PARTNER_MAX_TOOL_CALLS_PER_ROUND;
  const history: LLMRouterMessage[] = [];
  const toolLog: ToolLogEntry[] = [];
  const modelLog: ModelLogEntry[] = [];
  let prompt = input.prompt;
  let toolCallsUsed = 0;
  let invalidSubmissions = 0;
  let nudged = false;
  let lastProblem = '';
  const fallbackModel = resolvePlanSparringFallbackModel();
  const lastResortModel = resolvePlanSparringLastResortModel();

  // Partner tiers, tried in order: Opus 4.6 (primary) → Sonnet 4.6 (Bedrock
  // fallback) → DeepSeek (last resort, owner decision 2026-10-19). The tier is
  // STICKY for the rest of the pass: once a model is out of quota it is not
  // retried on every following turn.
  const tiers: PartnerTier[] = [
    { name: 'primary', provider: 'bedrock' },
    { name: 'bedrock_fallback', provider: 'bedrock', model: fallbackModel },
    ...(isPlanSparringDeepseekFallbackEnabled()
      ? [{ name: 'deepseek' as const, provider: 'deepseek' as const, model: lastResortModel }]
      : []),
  ];
  let tierIndex = 0;

  const fail = (reason: EscalationReason, error: string): PartnerPassResult => ({ ok: false, reason, error, toolLog, modelLog });
  // plan-spar-stuck-session: no awaited model call or tool call outlives the pass deadline (it was only checked
  // between turns, so a call that never returned left the session without a round). The losing promise is not
  // cancelled: llm-router / the Bedrock handler take no AbortSignal (follow-up, see the plan).
  const TIMED_OUT = Symbol('timed-out');
  const withinDeadline = async <T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> => {
    const remaining = Math.max(1, input.deadlineMs - (now() - startedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<typeof TIMED_OUT>((res) => { timer = setTimeout(() => res(TIMED_OUT), remaining); })]);
    } finally { if (timer) clearTimeout(timer); }
  };

  const invoke = (p: string, tier: PartnerTier): Promise<LLMRouterResult> =>
    input.callLlm(PARTNER_STAGE, p, {
      service: 'plan-sparring',
      vtid: null,
      allowFallback: false,
      systemPrompt: PARTNER_SYSTEM_PROMPT,
      tools: [...PARTNER_CODE_TOOLS, SUBMIT_REVIEW_TOOL],
      history: [...history],
      maxTokens: PARTNER_MAX_OUTPUT_TOKENS,
      thinking: { type: 'adaptive' },
      effort: 'high',
      // VTID (sparring-model-fallback): the Sonnet tier overrides only the
      // model, still on bedrock.
      ...(tier.name === 'bedrock_fallback' ? { providerOverride: 'bedrock' as const, modelOverride: tier.model } : {}),
      // Last resort: DeepSeek, explicitly flagged so the router lets the
      // no-fallback stage run on it for this one call. Thinking off: DeepSeek's
      // thinking mode needs reasoning_content handed back across tool turns,
      // which the OpenAI-shaped history does not carry.
      ...(tier.name === 'deepseek'
        ? { providerOverride: 'deepseek' as const, modelOverride: tier.model, planSparringLastResort: true, deepseekThinking: 'disabled' as const }
        : {}),
    });

  for (let turn = 1; turn <= PARTNER_MAX_TURNS_PER_ROUND; turn++) {
    if (now() - startedAt > input.deadlineMs) return fail('deadline_exceeded', `partner pass exceeded ${input.deadlineMs}ms`);

    let r: LLMRouterResult;
    for (;;) {
      const tier = tiers[tierIndex];
      const t0 = now();
      const raced = await withinDeadline(invoke(prompt, tier));
      if (raced === TIMED_OUT) return fail('deadline_exceeded', `partner model call exceeded the pass deadline (${input.deadlineMs}ms)`);
      r = raced;
      modelLog.push({
        round: input.round,
        provider: r.provider,
        model: r.model,
        latency_ms: now() - t0,
        input_tokens: r.usage?.inputTokens ?? 0,
        output_tokens: r.usage?.outputTokens ?? 0,
        ok: r.ok,
        ...(tier.name !== 'primary' ? { fallback: true, fallback_tier: tier.name } : {}),
        ...(r.ok ? {} : { error: (r.error || 'unknown').slice(0, 500) }),
      });
      if (r.ok || !shouldTryNextTier(tier, r.error) || tierIndex >= tiers.length - 1) break;
      const next = tiers[tierIndex + 1];
      console.warn(
        `[plan-sparring] partner tier ${tier.name} (${r.model ?? tier.model ?? 'primary'}) failed ` +
          `(${(r.error || '').slice(0, 160)}); switching to ${next.name} (${next.provider}/${next.model}) ` +
          `for the rest of round ${input.round}, from turn ${turn}`,
      );
      tierIndex += 1;
    }

    if (!r.ok) return fail('model_unavailable', r.error || 'partner model call failed');
    // Defence in depth: the router never falls back for this stage. The answer
    // must come from the provider of the tier that was asked.
    const expectedProvider = tiers[tierIndex].provider;
    if (r.fallbackUsed || r.provider !== expectedProvider) {
      return fail('model_unavailable', `partner answered by ${r.provider} (fallbackUsed=${String(r.fallbackUsed)}) — refused`);
    }

    const calls: LLMRouterToolCall[] = r.toolCalls ?? [];
    if (calls.length === 0) {
      if (nudged) return fail('partner_output_invalid', 'partner ended its turn without calling submit_review');
      history.push({ role: 'user', content: prompt }, { role: 'assistant', content: r.text || '(no text)' });
      prompt = PARTNER_SUBMIT_NUDGE;
      nudged = true;
      continue;
    }

    history.push({ role: 'user', content: prompt });
    history.push({
      role: 'assistant',
      toolCalls: calls,
      ...(r.text ? { content: r.text } : {}),
      ...(r.thinkingBlocks && r.thinkingBlocks.length > 0 ? { thinking: r.thinkingBlocks } : {}),
    });

    const results: Array<{ id?: string; name: string; result: string; isError?: boolean }> = [];
    for (const call of calls) {
      if (call.name === SUBMIT_REVIEW_TOOL.name) {
        const parsed = parsePartnerReview(call.arguments);
        if (!parsed.ok) {
          invalidSubmissions += 1;
          lastProblem = parsed.error;
          results.push({ id: call.id, name: call.name, result: `Review rejected: ${parsed.error}. Fix it and call submit_review again.`, isError: true });
          continue;
        }
        const ev = checkEvidence(parsed.review, toolLog, input.round);
        if (!ev.ok) {
          invalidSubmissions += 1;
          lastProblem = ev.problems.join('; ');
          results.push({
            id: call.id,
            name: call.name,
            result: `Review rejected by the store: ${lastProblem}. Read the files with read_file, cite them, and call submit_review again.`,
            isError: true,
          });
          continue;
        }
        return {
          ok: true,
          review: parsed.review,
          toolLog,
          modelLog,
          evidenceFloor: {
            required: input.round === 1 ? ROUND1_MIN_VERIFIED_PREMISES : 0,
            verified: ev.verifiedPremises,
            met: true,
          },
        };
      }

      if (toolCallsUsed >= maxToolCalls) {
        results.push({
          id: call.id,
          name: call.name,
          result: `Tool-call cap (${maxToolCalls}) for this round reached. Call submit_review now with the evidence you have.`,
          isError: true,
        });
        continue;
      }
      toolCallsUsed += 1;
      const execOrTimeout = await withinDeadline(input.executeTool(call.name, call.arguments ?? {}));
        if (execOrTimeout === TIMED_OUT) return fail('deadline_exceeded', `partner tool call ${call.name} exceeded the pass deadline (${input.deadlineMs}ms)`);
        const exec = execOrTimeout;
      toolLog.push(exec.log);
      results.push({ id: call.id, name: call.name, result: exec.result, ...(exec.isError ? { isError: true } : {}) });
    }

    if (invalidSubmissions > PARTNER_MAX_INVALID_SUBMISSIONS) {
      const floorProblem = /round 1 needs at least/.test(lastProblem);
      return fail(floorProblem ? 'evidence_floor_not_met' : 'partner_output_invalid', lastProblem);
    }

    history.push({ role: 'user', toolResults: results });
    prompt = PARTNER_CONTINUE_PROMPT;
  }
  return fail('partner_output_invalid', `partner did not submit a review within ${PARTNER_MAX_TURNS_PER_ROUND} turns`);
}

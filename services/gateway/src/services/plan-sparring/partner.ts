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
 * A failed model call ends the pass immediately with `model_unavailable` —
 * there is no retry on another model and no other provider is called.
 */

import type {
  LLMRouterMessage,
  LLMRouterOpts,
  LLMRouterResult,
  LLMRouterToolCall,
  LLMStage,
} from '../llm-router';
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

  const fail = (reason: EscalationReason, error: string): PartnerPassResult => ({ ok: false, reason, error, toolLog, modelLog });

  for (let turn = 1; turn <= PARTNER_MAX_TURNS_PER_ROUND; turn++) {
    if (now() - startedAt > input.deadlineMs) return fail('deadline_exceeded', `partner pass exceeded ${input.deadlineMs}ms`);

    const t0 = now();
    const r = await input.callLlm(PARTNER_STAGE, prompt, {
      service: 'plan-sparring',
      vtid: null,
      allowFallback: false,
      systemPrompt: PARTNER_SYSTEM_PROMPT,
      tools: [...PARTNER_CODE_TOOLS, SUBMIT_REVIEW_TOOL],
      history: [...history],
      maxTokens: PARTNER_MAX_OUTPUT_TOKENS,
      thinking: { type: 'adaptive' },
      effort: 'high',
    });
    modelLog.push({
      round: input.round,
      provider: r.provider,
      model: r.model,
      latency_ms: now() - t0,
      input_tokens: r.usage?.inputTokens ?? 0,
      output_tokens: r.usage?.outputTokens ?? 0,
      ok: r.ok,
      ...(r.ok ? {} : { error: (r.error || 'unknown').slice(0, 500) }),
    });

    if (!r.ok) return fail('model_unavailable', r.error || 'partner model call failed');
    // Defence in depth: the router never falls back for this stage, but if a
    // future change made it, the answer did not come from the partner model.
    if (r.fallbackUsed || r.provider !== 'bedrock') {
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
      const exec = await input.executeTool(call.name, call.arguments ?? {});
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

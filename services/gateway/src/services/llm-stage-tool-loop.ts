/**
 * VTID-04231: a bounded, provider-neutral tool loop for ONE routing stage.
 *
 * The agent executor has its own loop (`autopilot-agent/agent-loop.ts`)
 * whose end state is a `finish` tool and whose nudges name the executor's
 * file tools — the wrong shape for the validator, the triage agent and the
 * spec generator, each of which ends with a TEXT answer (a verdict, a
 * report, a spec). This loop is the shape those three share:
 *
 *   1. `callViaRouter(stage, prompt, { tools, history, … })` — the router
 *      picks the provider from `llm_routing_policy` and renders the same
 *      transcript as OpenAI-style `tool_calls` on DeepSeek and `tool_use`
 *      blocks on Bedrock (VTID-03579). No per-provider code here.
 *   2. Tool calls are executed through the caller's `execute` (the caller
 *      decides the tool set — that is the whole point: a tool set scoped to
 *      the responsibility), their results appended as `toolResults`, and the
 *      model is asked to continue.
 *   3. A text reply with no tool calls is the final answer.
 *
 * Every dimension is bounded — turns, tool calls, wall clock, per-result
 * size, resent history — and when a budget runs out the model gets exactly
 * ONE more call, with no tools, asking for its final answer from what it
 * already has. The loop never throws on a model or tool failure; it returns
 * `{ ok:false, error }` so each caller keeps its own posture (the validator
 * fails open, the investigator fails loud, the spec generator falls back to
 * its template).
 */

import type { LLMProvider, LLMRouterMessage, LLMRouterResult, LLMRouterTool, LLMRouterToolCall, LLMStage } from './llm-router';

export const STAGE_LOOP_DEFAULT_MAX_TURNS = 6;
export const STAGE_LOOP_DEFAULT_MAX_TOOL_CALLS = 10;
export const STAGE_LOOP_DEFAULT_DEADLINE_MS = 120_000;
export const STAGE_LOOP_TOOL_RESULT_MAX_CHARS = 20_000;
export const STAGE_LOOP_HISTORY_CHAR_BUDGET = 90_000;
export const STAGE_LOOP_CONTINUE_PROMPT = 'Tool results above. Continue: call another tool if you still need evidence, otherwise give your final answer now.';
export const STAGE_LOOP_FINAL_PROMPT = 'Your tool budget is used up. Give your final answer now from the evidence you already have — do not request more tools.';
const HISTORY_TRIM_NOTICE = '[tool result trimmed to bound context size — this tool ran earlier in the session]';

export interface StageToolOutcome {
  result: string;
  isError?: boolean;
}

export interface StageToolStep {
  turn: number;
  kind: 'llm' | 'tool' | 'final' | 'error';
  name?: string;
  detail: string;
  ms?: number;
  isError?: boolean;
}

export type StageLlmCall = (
  stage: LLMStage,
  prompt: string,
  opts: {
    vtid?: string | null;
    service: string;
    systemPrompt: string;
    tools?: LLMRouterTool[];
    history: LLMRouterMessage[];
    maxTokens?: number;
    allowFallback: boolean;
    providerOverride?: LLMProvider;
    modelOverride?: string;
  },
) => Promise<LLMRouterResult>;

export interface StageToolLoopOptions {
  stage: LLMStage;
  service: string;
  vtid?: string | null;
  systemPrompt: string;
  prompt: string;
  tools: LLMRouterTool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<StageToolOutcome>;
  maxTurns?: number;
  maxToolCalls?: number;
  deadlineMs?: number;
  maxTokens?: number;
  allowFallback?: boolean;
  providerOverride?: LLMProvider;
  modelOverride?: string;
  historyCharBudget?: number;
  continuePrompt?: string;
  finalPrompt?: string;
  onStep?: (step: StageToolStep) => void;
  now?: () => number;
  /** Test seam / caller override; defaults to the real `callViaRouter`. */
  callLlm?: StageLlmCall;
}

export interface StageToolLoopResult {
  ok: boolean;
  text?: string;
  error?: string;
  provider?: string;
  model?: string;
  fallbackUsed: boolean;
  usage: { inputTokens: number; outputTokens: number };
  turns: number;
  toolCalls: number;
  /** Tool names in call order — for the caller's telemetry. */
  toolNames: string[];
  history: LLMRouterMessage[];
  steps: StageToolStep[];
  /** True when the final answer was forced by a budget (turns/tool calls/deadline). */
  budgetExhausted: boolean;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

function historyChars(history: LLMRouterMessage[]): number {
  let n = 0;
  for (const m of history) {
    if ('content' in m && typeof m.content === 'string') n += m.content.length;
    if ('toolResults' in m && m.toolResults) for (const r of m.toolResults) n += r.result.length;
  }
  return n;
}

/** Same policy as agent-loop's trimHistoryForBudget: oldest tool results first, last message untouched, pure. */
export function trimStageHistory(history: LLMRouterMessage[], maxChars: number): LLMRouterMessage[] {
  if (historyChars(history) <= maxChars) return history;
  const out = history.map((m) => ({ ...m }));
  for (let i = 0; i < out.length - 1 && historyChars(out) > maxChars; i++) {
    const m = out[i];
    if ('toolResults' in m && m.toolResults) {
      out[i] = { ...m, toolResults: m.toolResults.map((r) => (r.result.length > HISTORY_TRIM_NOTICE.length ? { ...r, result: HISTORY_TRIM_NOTICE } : r)) };
    }
  }
  return out;
}

async function defaultCallLlm(...args: Parameters<StageLlmCall>): ReturnType<StageLlmCall> {
  const { callViaRouter } = await import('./llm-router');
  const [stage, prompt, opts] = args;
  return callViaRouter(stage, prompt, opts as never);
}

export async function runStageToolLoop(o: StageToolLoopOptions): Promise<StageToolLoopResult> {
  const now = o.now ?? Date.now;
  const started = now();
  const maxTurns = Math.max(1, o.maxTurns ?? STAGE_LOOP_DEFAULT_MAX_TURNS);
  const maxToolCalls = Math.max(0, o.maxToolCalls ?? STAGE_LOOP_DEFAULT_MAX_TOOL_CALLS);
  const deadline = started + (o.deadlineMs ?? STAGE_LOOP_DEFAULT_DEADLINE_MS);
  const budget = o.historyCharBudget ?? STAGE_LOOP_HISTORY_CHAR_BUDGET;
  const callLlm = o.callLlm ?? defaultCallLlm;
  const history: LLMRouterMessage[] = [];
  const steps: StageToolStep[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolNames: string[] = [];
  let provider: string | undefined;
  let model: string | undefined;
  let fallbackUsed = false;
  let turns = 0;
  let toolCalls = 0;
  let prompt = o.prompt;
  let budgetExhausted = false;
  const step = (s: StageToolStep) => { steps.push(s); try { o.onStep?.(s); } catch { /* telemetry never breaks the loop */ } };
  const fail = (error: string): StageToolLoopResult => ({ ok: false, error, provider, model, fallbackUsed, usage, turns, toolCalls, toolNames, history, steps, budgetExhausted });

  const call = async (withTools: boolean): Promise<LLMRouterResult> => {
    turns += 1;
    const t0 = now();
    const r = await callLlm(o.stage, prompt, {
      vtid: o.vtid ?? null,
      service: o.service,
      systemPrompt: o.systemPrompt,
      ...(withTools && o.tools.length > 0 ? { tools: o.tools } : {}),
      history: trimStageHistory([...history], budget),
      maxTokens: o.maxTokens,
      allowFallback: o.allowFallback ?? true,
      ...(o.providerOverride ? { providerOverride: o.providerOverride } : {}),
      ...(o.modelOverride ? { modelOverride: o.modelOverride } : {}),
    });
    const ms = now() - t0;
    if (r.usage) { usage.inputTokens += r.usage.inputTokens ?? 0; usage.outputTokens += r.usage.outputTokens ?? 0; }
    if (r.provider) provider = String(r.provider);
    if (r.model) model = r.model;
    if (r.fallbackUsed) fallbackUsed = true;
    const calls = r.toolCalls && r.toolCalls.length > 0 ? r.toolCalls : [];
    step({ turn: turns, kind: r.ok ? 'llm' : 'error', detail: r.ok ? (calls.length ? `${calls.length} tool call(s): ${calls.map((c) => c.name).join(', ')}` : `text (${(r.text || '').length} chars)`) : (r.error || 'llm call failed'), ms, isError: !r.ok });
    return r;
  };

  while (true) {
    const outOfTurns = turns >= maxTurns;
    const outOfTime = now() > deadline;
    const outOfTools = o.tools.length > 0 && toolCalls >= maxToolCalls;
    if (outOfTurns || outOfTime || outOfTools) {
      // One last call, no tools, for the answer from what the model already has.
      budgetExhausted = true;
      step({ turn: turns, kind: 'final', detail: outOfTime ? 'deadline reached — asking for the final answer' : outOfTools ? 'tool-call budget reached — asking for the final answer' : 'turn budget reached — asking for the final answer' });
      prompt = o.finalPrompt ?? STAGE_LOOP_FINAL_PROMPT;
      const r = await call(false);
      if (!r.ok) return fail(`${o.stage} stage call failed on final turn ${turns}: ${r.error || 'unknown'}`);
      const text = (r.text || '').trim();
      if (!text) return fail(`${o.stage} stage returned no text on the final turn`);
      history.push({ role: 'user', content: prompt }, { role: 'assistant', content: text });
      return { ok: true, text, provider, model, fallbackUsed, usage, turns, toolCalls, toolNames, history, steps, budgetExhausted };
    }

    const r = await call(true);
    if (!r.ok) return fail(`${o.stage} stage call failed on turn ${turns}: ${r.error || 'unknown'}`);
    const calls: LLMRouterToolCall[] = r.toolCalls && r.toolCalls.length > 0 ? r.toolCalls : [];
    history.push({ role: 'user', content: prompt });
    if (calls.length === 0) {
      const text = (r.text || '').trim();
      if (!text) return fail(`${o.stage} stage returned neither text nor a tool call on turn ${turns}`);
      history.push({ role: 'assistant', content: text });
      return { ok: true, text, provider, model, fallbackUsed, usage, turns, toolCalls, toolNames, history, steps, budgetExhausted };
    }
    history.push({ role: 'assistant', toolCalls: calls, content: r.text || undefined });
    const results: Array<{ id?: string; name: string; result: string; isError?: boolean }> = [];
    for (const c of calls) {
      const args = c.arguments || {};
      if (toolCalls >= maxToolCalls) {
        results.push({ id: c.id, name: c.name, result: `tool-call budget (${maxToolCalls}) exhausted — answer from the evidence you already have`, isError: true });
        continue;
      }
      toolCalls += 1;
      toolNames.push(c.name);
      const t0 = now();
      let out: StageToolOutcome;
      try {
        out = await o.execute(c.name, args);
      } catch (err) {
        out = { result: `tool ${c.name} threw: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      step({ turn: turns, kind: 'tool', name: c.name, detail: out.isError ? out.result.slice(0, 300) : summarizeArgs(args), ms: now() - t0, isError: out.isError });
      results.push({ id: c.id, name: c.name, result: clip(out.result, STAGE_LOOP_TOOL_RESULT_MAX_CHARS), isError: out.isError });
    }
    history.push({ role: 'user', toolResults: results });
    prompt = o.continuePrompt ?? STAGE_LOOP_CONTINUE_PROMPT;
  }
}

function summarizeArgs(a: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}=${String(v).slice(0, 80)}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' ');
}

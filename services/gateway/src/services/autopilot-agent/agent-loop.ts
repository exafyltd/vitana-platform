/**
 * VTID-04006: the agent's tool loop, provider-neutral.
 *
 * One `callLlm` per turn (the runner binds it to `callViaRouter('worker', …)`
 * with the DeepSeek Flash primary override; the router's own fallback —
 * Bedrock Claude on the v17 policy — applies unchanged). Each turn either
 * asks for tools (we run them and answer with `toolResults`) or answers
 * with text (we nudge it back to tools / `finish`). `finish` ends the loop;
 * the caller verifies, scopes, commits and opens the PR.
 *
 * History uses the router's `LLMRouterMessage` union so the same transcript
 * renders as OpenAI-style `tool_calls`/`tool` messages on DeepSeek and as
 * `tool_use`/`tool_result` blocks on Bedrock — no per-provider code here.
 */

import type { LLMRouterMessage, LLMRouterResult, LLMRouterTool, LLMRouterToolCall } from '../llm-router';
import type { FinishArgs, ToolOutcome } from './agent-tools';

export interface AgentStep {
  turn: number;
  kind: 'llm' | 'tool' | 'nudge' | 'finish' | 'error';
  name?: string;
  detail: string;
  ms?: number;
  isError?: boolean;
}

export interface AgentLoopOptions {
  systemPrompt: string;
  prompt: string;
  tools: LLMRouterTool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  callLlm: (prompt: string, history: LLMRouterMessage[], systemPrompt: string) => Promise<LLMRouterResult>;
  /** Prior transcript (for a fix round); the new `prompt` continues it. */
  history?: LLMRouterMessage[];
  maxTurns?: number;
  deadlineMs?: number;
  onStep?: (step: AgentStep) => void;
  now?: () => number;
}

export interface AgentLoopResult {
  ok: boolean;
  finished?: FinishArgs;
  history: LLMRouterMessage[];
  turns: number;
  toolCalls: number;
  error?: string;
  provider?: string;
  model?: string;
  fallbackUsed: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

export const CONTINUE_PROMPT = 'Tool results above. Continue — read, edit, run checks as needed; when done and checks pass, call finish.';
export const NUDGE_PROMPT = 'You answered with text only. This runner acts only on tool calls: either continue with read_file / search_text / edit_file / run_check, or call finish(summary, pr_title, pr_body) if the change is complete and verified.';
const MAX_CONSECUTIVE_NUDGES = 3;
const TOOL_RESULT_MAX_CHARS = 30_000;

function clip(s: string): string {
  return s.length > TOOL_RESULT_MAX_CHARS ? `${s.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated]` : s;
}

export async function runAgentLoop(o: AgentLoopOptions): Promise<AgentLoopResult> {
  const now = o.now ?? Date.now;
  const started = now();
  const maxTurns = o.maxTurns ?? 60;
  const deadline = started + (o.deadlineMs ?? 20 * 60_000);
  const history: LLMRouterMessage[] = [...(o.history ?? [])];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let prompt = o.prompt;
  let turns = 0;
  let toolCalls = 0;
  let nudges = 0;
  let provider: string | undefined;
  let model: string | undefined;
  let fallbackUsed = false;
  const step = (s: AgentStep) => { try { o.onStep?.(s); } catch { /* never let telemetry break the loop */ } };

  while (turns < maxTurns) {
    if (now() > deadline) {
      step({ turn: turns, kind: 'error', detail: 'deadline exceeded' });
      return { ok: false, error: `agent deadline exceeded after ${turns} turn(s)`, history, turns, toolCalls, provider, model, fallbackUsed, usage };
    }
    turns += 1;
    const t0 = now();
    // Snapshot: the callee must never see later turns appended to its input.
    const r = await o.callLlm(prompt, [...history], o.systemPrompt);
    const ms = now() - t0;
    if (r.usage) { usage.inputTokens += r.usage.inputTokens ?? 0; usage.outputTokens += r.usage.outputTokens ?? 0; }
    if (r.provider) provider = String(r.provider);
    if (r.model) model = r.model;
    if (r.fallbackUsed) fallbackUsed = true;
    if (!r.ok) {
      step({ turn: turns, kind: 'error', detail: r.error || 'llm call failed', ms, isError: true });
      return { ok: false, error: `LLM call failed on turn ${turns}: ${r.error || 'unknown'}`, history, turns, toolCalls, provider, model, fallbackUsed, usage };
    }
    const calls: LLMRouterToolCall[] = r.toolCalls && r.toolCalls.length > 0 ? r.toolCalls : [];
    step({ turn: turns, kind: 'llm', detail: calls.length ? `${calls.length} tool call(s): ${calls.map((c) => c.name).join(', ')}` : `text (${(r.text || '').length} chars)`, ms });

    history.push({ role: 'user', content: prompt });
    if (calls.length === 0) {
      history.push({ role: 'assistant', content: r.text || '' });
      nudges += 1;
      if (nudges >= MAX_CONSECUTIVE_NUDGES) {
        step({ turn: turns, kind: 'error', detail: 'model stopped using tools', isError: true });
        return { ok: false, error: `model answered with text ${nudges} times in a row without calling finish`, history, turns, toolCalls, provider, model, fallbackUsed, usage };
      }
      step({ turn: turns, kind: 'nudge', detail: NUDGE_PROMPT.slice(0, 80) });
      prompt = NUDGE_PROMPT;
      continue;
    }
    nudges = 0;
    history.push({ role: 'assistant', toolCalls: calls, content: r.text || undefined });
    const results: Array<{ id?: string; name: string; result: string; isError?: boolean }> = [];
    let finished: FinishArgs | undefined;
    for (const c of calls) {
      toolCalls += 1;
      const s0 = now();
      const out = await o.execute(c.name, c.arguments || {});
      step({ turn: turns, kind: 'tool', name: c.name, detail: out.isError ? out.result.slice(0, 300) : summarizeArgs(c), ms: now() - s0, isError: out.isError });
      results.push({ id: c.id, name: c.name, result: clip(out.result), isError: out.isError });
      if (out.finished && !finished) finished = out.finished;
    }
    history.push({ role: 'user', toolResults: results });
    if (finished) {
      step({ turn: turns, kind: 'finish', detail: finished.pr_title });
      return { ok: true, finished, history, turns, toolCalls, provider, model, fallbackUsed, usage };
    }
    prompt = CONTINUE_PROMPT;
  }
  step({ turn: turns, kind: 'error', detail: 'max turns reached', isError: true });
  return { ok: false, error: `agent hit the ${maxTurns}-turn cap without calling finish`, history, turns, toolCalls, provider, model, fallbackUsed, usage };
}

function summarizeArgs(c: LLMRouterToolCall): string {
  const a = c.arguments || {};
  const parts: string[] = [];
  for (const k of ['path', 'glob', 'pattern', 'kind', 'target', 'pr_title']) {
    if (typeof a[k] === 'string') parts.push(`${k}=${String(a[k]).slice(0, 80)}`);
  }
  return parts.join(' ');
}

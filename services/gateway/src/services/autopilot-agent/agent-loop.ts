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
  /** VTID-04032: polled at every turn and tool boundary; true stops the loop with `cancelled: true`. */
  isCancelled?: () => boolean;
  /**
   * VTID-04112: character budget for the history RESENT to the model each
   * turn (the stored `history` returned to the caller is never trimmed —
   * only the copy handed to `callLlm`). Defaults to `HISTORY_CHAR_BUDGET`.
   */
  historyCharBudget?: number;
  /**
   * VTID-04194: once a real edit has landed, force wrap-up once this many
   * turns remain before `maxTurns`. Defaults to `WRAP_UP_MARGIN_TURNS`.
   */
  wrapUpMarginTurns?: number;
  /**
   * VTID-04213: once this many turns have elapsed with NO edit yet landed,
   * switch the continuation prompt to one that tells the model to stop
   * searching and commit to an edit. Defaults to `EXPLORATION_BUDGET_TURNS`.
   */
  explorationBudgetTurns?: number;
}

export interface AgentLoopResult {
  ok: boolean;
  finished?: FinishArgs;
  history: LLMRouterMessage[];
  turns: number;
  toolCalls: number;
  error?: string;
  /** VTID-04032: the operator cancelled the execution; not a model or tool failure. */
  cancelled?: boolean;
  provider?: string;
  model?: string;
  fallbackUsed: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

export const CONTINUE_PROMPT = 'Tool results above. Continue — read, edit, run checks as needed; when done and checks pass, call finish.';
export const NUDGE_PROMPT = 'You answered with text only. This runner acts only on tool calls: either continue with read_file / search_text / edit_file / run_check, or call finish(summary, pr_title, pr_body) if the change is complete and verified.';
const MAX_CONSECUTIVE_NUDGES = 3;
const TOOL_RESULT_MAX_CHARS = 30_000;

/**
 * VTID-04194: once a real edit has landed AND the turn budget is nearly
 * exhausted, stop encouraging further exploration — force wrap-up instead.
 *
 * Observed live (VTID-04138, execution d5c52526): the agent spent 119 of
 * 120 turns on search_text/read_file against a 2.6MB app.js (mostly
 * unproductive — guessing at interval variable names across many unrelated
 * polling mechanisms), made its FIRST and ONLY edit_file call on turn
 * 120/120, and the loop then hit `turns < maxTurns` false with no turn left
 * to run a check or call finish — discarding a real edit entirely and
 * terminalizing the VTID `failed`. The pre-existing MAX_CONSECUTIVE_NUDGES
 * guard only fires on text-only replies; it never fires here because every
 * one of those 119 turns was a genuine (if unproductive) tool call.
 *
 * `MUTATING_TOOLS` names the tools this loop treats as "a real edit has
 * happened" — the same set `RepeatedCheckGuard.markEdited()` reacts to in
 * `agent-tools.ts`, kept in sync deliberately rather than re-derived.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'delete_file']);
const WRAP_UP_MARGIN_TURNS = 8;

export function buildWrapUpPrompt(turnsRemaining: number): string {
  return [
    `You have already made file edit(s), and only ${turnsRemaining} turn(s) remain before this run's hard cap.`,
    'Do NOT start new exploration or open new files. Run only the check(s) needed to verify the files you already changed,',
    'fix anything they report, and call finish(summary, pr_title, pr_body) now — a smaller, verified change beats running',
    'out of turns with an uncommitted edit.',
  ].join(' ');
}

/**
 * VTID-04213: the OTHER half of the failure VTID-04194 left uncovered — a
 * run that never lands ANY edit at all, not one that lands an edit too
 * close to the cap. Measured live across the 10 failed executions in the
 * 30-task Command Hub batch queued 2026-09-20 (VTID-04160/61/62/63/66/67/
 * 68/69/70/71/77, all `agent hit the N-turn cap without calling finish`,
 * all claimed AFTER VTID-04194's own executor-image rebuild — so this is
 * genuinely a different defect, not a stale-image artifact): every one
 * spent 100-130+ turns almost entirely on `read_file`/`search_text`/
 * `find_files`, and 9 of the 10 made ZERO `write_file`/`edit_file`/
 * `delete_file` calls in the whole run — pure exploration exhaustion for
 * tasks (e.g. "cap a request size", "cap a title length") that should
 * have converged on one file in a handful of turns. `buildWrapUpPrompt`
 * cannot help here — its trigger (`hasEdited`) is never true.
 *
 * Once `explorationBudgetTurns` elapses with no edit yet landed, the
 * continuation prompt switches to this one: stop broadening the search,
 * make the best edit available now from what has already been read, or
 * — if the location genuinely cannot be found — say so and call `finish`
 * with that explanation instead of silently exhausting the turn cap.
 * This does not force an edit (a model that is genuinely still narrowing
 * down a real ambiguity should not be cut off mid-thought), it only
 * removes the standing invitation to keep exploring indefinitely.
 */
const EXPLORATION_BUDGET_TURNS = 40;

export function buildExplorationBudgetPrompt(turnsUsed: number, turnsRemaining: number): string {
  return [
    `You have used ${turnsUsed} turn(s) exploring the repository and have not made any file edit yet, with ${turnsRemaining} turn(s) left.`,
    'Stop broadening the search. Based on what you have already read, make your best edit now with write_file/edit_file.',
    'If you genuinely cannot identify the right location after this much exploration, stop searching and call',
    'finish(summary, pr_title, pr_body) explaining exactly what you could not resolve — do not keep searching indefinitely.',
  ].join(' ');
}

/**
 * VTID-04112: `TOOL_RESULT_MAX_CHARS` bounds any ONE tool result, but
 * nothing previously bounded the CUMULATIVE transcript resent on every
 * turn — it grew without limit for the life of the run. Measured live: a
 * single execution (VTID-04109) reached 6.87M cumulative input tokens over
 * 81 turns before dying with three consecutive EMPTY completions (no text,
 * no tool call) at $1.14 cost. DeepSeek's visible answer shares its output
 * budget with its own internal reasoning; once the resent context is large
 * enough, reasoning alone can exhaust that budget and the API returns an
 * empty completion — which this loop cannot tell apart from the model
 * genuinely choosing to answer with prose, so it silently burns through
 * the 3-strike nudge budget and dies with a misleading "model stopped
 * using tools" error on every run long enough to reach this point (26 of
 * 43 executions failed this way or by exhausting a turn cap in the 3 days
 * before this fix, per `dev_autopilot_outcomes`). See `trimHistoryForBudget`.
 */
const HISTORY_CHAR_BUDGET = 120_000;
/** Replaces an older tool result's body once the budget above is exceeded. */
const HISTORY_TRIM_NOTICE = '[tool result trimmed to bound context size — this tool ran earlier in the session]';

function clip(s: string): string {
  return s.length > TOOL_RESULT_MAX_CHARS ? `${s.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated]` : s;
}

function historyChars(history: LLMRouterMessage[]): number {
  let n = 0;
  for (const m of history) {
    if ('content' in m && typeof m.content === 'string') n += m.content.length;
    if ('toolResults' in m && m.toolResults) {
      for (const r of m.toolResults) n += r.result.length;
    }
  }
  return n;
}

/**
 * VTID-04112: bound the history resent to the model each turn. Shrinks the
 * OLDEST tool results first (they are the dominant contributor — each can
 * be up to `TOOL_RESULT_MAX_CHARS`, and a long run accumulates many), never
 * touches the single most recent message (the model needs its own last
 * action intact to continue coherently), and is a pure function — the
 * caller's stored `history` (returned to the operator/executor for the PR
 * evidence trail) is never mutated, only the copy handed to the LLM call.
 */
export function trimHistoryForBudget(
  history: LLMRouterMessage[],
  maxChars: number = HISTORY_CHAR_BUDGET,
): LLMRouterMessage[] {
  if (historyChars(history) <= maxChars) return history;
  const out = history.map((m) => ({ ...m }));
  for (let i = 0; i < out.length - 1 && historyChars(out) > maxChars; i++) {
    const m = out[i];
    if ('toolResults' in m && m.toolResults) {
      out[i] = {
        ...m,
        toolResults: m.toolResults.map((r) =>
          r.result.length > HISTORY_TRIM_NOTICE.length ? { ...r, result: HISTORY_TRIM_NOTICE } : r,
        ),
      };
    }
  }
  return out;
}

export async function runAgentLoop(o: AgentLoopOptions): Promise<AgentLoopResult> {
  const now = o.now ?? Date.now;
  const started = now();
  const maxTurns = o.maxTurns ?? 60;
  const deadline = started + (o.deadlineMs ?? 20 * 60_000);
  const historyCharBudget = o.historyCharBudget ?? HISTORY_CHAR_BUDGET;
  const wrapUpMarginTurns = o.wrapUpMarginTurns ?? WRAP_UP_MARGIN_TURNS;
  const explorationBudgetTurns = o.explorationBudgetTurns ?? EXPLORATION_BUDGET_TURNS;
  const history: LLMRouterMessage[] = [...(o.history ?? [])];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let prompt = o.prompt;
  let turns = 0;
  let toolCalls = 0;
  let nudges = 0;
  let hasEdited = false;
  let provider: string | undefined;
  let model: string | undefined;
  let fallbackUsed = false;
  const step = (s: AgentStep) => { try { o.onStep?.(s); } catch { /* never let telemetry break the loop */ } };

  const cancelledResult = (): AgentLoopResult => {
    step({ turn: turns, kind: 'error', detail: 'cancelled by operator' });
    return { ok: false, cancelled: true, error: 'cancelled by operator', history, turns, toolCalls, provider, model, fallbackUsed, usage };
  };

  while (turns < maxTurns) {
    if (o.isCancelled?.()) return cancelledResult();
    if (now() > deadline) {
      step({ turn: turns, kind: 'error', detail: 'deadline exceeded' });
      return { ok: false, error: `agent deadline exceeded after ${turns} turn(s)`, history, turns, toolCalls, provider, model, fallbackUsed, usage };
    }
    turns += 1;
    const t0 = now();
    // Snapshot: the callee must never see later turns appended to its input.
    // VTID-04112: trimmed for the CALL only — `history` itself (returned to
    // the caller) keeps every result in full.
    const r = await o.callLlm(prompt, trimHistoryForBudget([...history], historyCharBudget), o.systemPrompt);
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
      if (o.isCancelled?.()) return cancelledResult();
      toolCalls += 1;
      const s0 = now();
      const out = await o.execute(c.name, c.arguments || {});
      step({ turn: turns, kind: 'tool', name: c.name, detail: out.isError ? out.result.slice(0, 300) : summarizeArgs(c), ms: now() - s0, isError: out.isError });
      results.push({ id: c.id, name: c.name, result: clip(out.result), isError: out.isError });
      if (out.finished && !finished) finished = out.finished;
      if (!out.isError && MUTATING_TOOLS.has(c.name)) hasEdited = true;
    }
    history.push({ role: 'user', toolResults: results });
    if (finished) {
      step({ turn: turns, kind: 'finish', detail: finished.pr_title });
      return { ok: true, finished, history, turns, toolCalls, provider, model, fallbackUsed, usage };
    }
    const turnsRemaining = maxTurns - turns;
    if (hasEdited && turnsRemaining <= wrapUpMarginTurns) {
      step({ turn: turns, kind: 'nudge', detail: `wrap-up: ${turnsRemaining} turn(s) remain after an edit — forcing finish` });
      prompt = buildWrapUpPrompt(turnsRemaining);
    } else if (!hasEdited && turns >= explorationBudgetTurns) {
      step({ turn: turns, kind: 'nudge', detail: `exploration budget: ${turns} turn(s) used with no edit yet — forcing convergence` });
      prompt = buildExplorationBudgetPrompt(turns, turnsRemaining);
    } else {
      prompt = CONTINUE_PROMPT;
    }
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

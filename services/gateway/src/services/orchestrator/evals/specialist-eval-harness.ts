/**
 * VTID-04432 (Orchestrator v2, P7): per-agent evaluation harness for the
 * `delegate_to_agent` specialists (docs/ORCHESTRATOR-REDESIGN-PLAN.md §5 P7
 * "per-agent evaluation suites gated in CI").
 *
 * An eval case is a scripted model conversation run through the REAL
 * specialist entry point (`runSupportSpecialist` / `runCommerceSpecialist`),
 * the REAL tool loop (`runStageToolLoop`) and the REAL tool executor, against
 * an in-memory fixture store holding the caller's data AND a second user's.
 * Only the model is scripted — so a case pins what the harness around the
 * model guarantees, whatever the model asks for:
 *
 *   - every data read is pinned to the caller's own user id;
 *   - nothing that belongs to another user reaches a tool result or the
 *     findings, even when the model asks for it by name or number;
 *   - an unknown tool, an empty argument or a failing dependency comes back
 *     to the model as an error instead of throwing;
 *   - tool-call and turn budgets hold, and the final answer is requested
 *     without tools;
 *   - findings are bounded and carry the "not a script" note;
 *   - a signed-out caller never reaches the model;
 *   - a model failure surfaces as a failed delegation, never as findings.
 *
 * What this does NOT measure: whether a live model picks the right tool or
 * words its findings well. That needs a live-model run and a grader; the
 * cases here are the deterministic floor that such a run would sit on.
 *
 * No I/O: nothing here reads Supabase, the knowledge hub or a provider.
 */

import type { LLMRouterResult, LLMRouterTool, LLMRouterToolCall } from '../../llm-router';
import { runStageToolLoop, type StageLlmCall, type StageToolLoopOptions } from '../../llm-stage-tool-loop';
import type { DelegationCaller, DelegationOutcome } from '../dispatcher';

/** One scripted model turn. `final` receives every tool result the model has seen so far. */
export type ScriptedTurn =
  | { tools: Array<{ name: string; args?: Record<string, unknown> }> }
  | { final: string | ((seen: SeenToolResult[]) => string) }
  | { fail: string };

export interface SeenToolResult {
  name: string;
  result: string;
  isError: boolean;
}

export interface SpecialistEvalExpectation {
  ok: boolean;
  /** Exact tool order the specialist reports in `tools_used`. */
  toolsUsed?: string[];
  findingsContains?: string[];
  findingsNotContains?: string[];
  /** Substrings some tool result must contain. */
  toolResultContains?: string[];
  /** Every tool result that must be an error, by name, in order. */
  toolErrors?: string[];
  budgetExhausted?: boolean;
  /** The error text a failed delegation must carry. */
  errorContains?: string;
  /** How many model calls the case may make at most (0 = the model is never reached). */
  maxModelCalls?: number;
}

export interface SpecialistEvalCase {
  id: string;
  description: string;
  request: string;
  /** null = signed-out caller. */
  userId: string | null;
  script: ScriptedTurn[];
  expect: SpecialistEvalExpectation;
  /** Abort the delegation before the first tool runs. */
  abortBeforeTools?: boolean;
}

/** What a specialist adapter exposes to the harness. */
export interface SpecialistUnderEval {
  agentId: string;
  findingsMaxChars: number;
  maxToolCalls: number;
  tools: LLMRouterTool[];
  /** Runs the specialist with fixture deps whose reads are recorded; `runLoop` is injected. */
  run(
    request: string,
    caller: DelegationCaller,
    signal: AbortSignal,
    runLoop: typeof runStageToolLoop,
    recordRead: (userId: string, what: string) => void,
  ): Promise<DelegationOutcome>;
  /** Strings that exist only in OTHER users' fixture data. */
  foreignMarkers: string[];
}

export interface SpecialistEvalResult {
  id: string;
  passed: boolean;
  failures: string[];
  modelCalls: number;
  toolsUsed: string[];
  toolResults: SeenToolResult[];
  budgetExhausted: boolean;
  outcome: DelegationOutcome;
}

interface FindingsResult { findings: string; tools_used: string[]; note: string }

function isFindings(v: unknown): v is FindingsResult {
  return !!v && typeof v === 'object' && typeof (v as FindingsResult).findings === 'string';
}

/** Builds the scripted `callLlm` seam for one case. */
function scriptedModel(script: ScriptedTurn[], seen: SeenToolResult[], calls: { n: number; toolless: number[] }): StageLlmCall {
  let i = 0;
  let callSeq = 0;
  return async (_stage, _prompt, opts) => {
    calls.n += 1;
    callSeq += 1;
    if (!opts.tools) calls.toolless.push(callSeq);
    // Collect the tool results the loop fed back since the last call.
    const last = opts.history[opts.history.length - 1];
    if (last && 'toolResults' in last && last.toolResults) {
      for (const r of last.toolResults) seen.push({ name: r.name, result: r.result, isError: r.isError === true });
    }
    // A tool-less call is the loop asking for the final answer: skip any scripted tool turns.
    while (!opts.tools && i < script.length && 'tools' in script[i]) i += 1;
    const turn = script[i];
    i += 1;
    if (!turn) return { ok: true, text: 'No further findings.', provider: 'bedrock' } as LLMRouterResult;
    if ('fail' in turn) return { ok: false, error: turn.fail } as LLMRouterResult;
    if ('final' in turn) {
      const text = typeof turn.final === 'function' ? turn.final(seen) : turn.final;
      return { ok: true, text, provider: 'bedrock', model: 'scripted' } as LLMRouterResult;
    }
    const toolCalls: LLMRouterToolCall[] = turn.tools.map((t, k) => ({ name: t.name, arguments: t.args ?? {}, id: `call-${callSeq}-${k}` }));
    return { ok: true, toolCalls, provider: 'bedrock', model: 'scripted' } as LLMRouterResult;
  };
}

export async function runSpecialistEval(agent: SpecialistUnderEval, c: SpecialistEvalCase): Promise<SpecialistEvalResult> {
  const seen: SeenToolResult[] = [];
  const calls = { n: 0, toolless: [] as number[] };
  const reads: Array<{ userId: string; what: string }> = [];
  let budgetExhausted = false;
  let loopToolNames: string[] = [];

  const callLlm = scriptedModel(c.script, seen, calls);
  const runLoop: typeof runStageToolLoop = async (o: StageToolLoopOptions) => {
    const r = await runStageToolLoop({ ...o, callLlm });
    budgetExhausted = r.budgetExhausted;
    loopToolNames = r.toolNames;
    return r;
  };

  const controller = new AbortController();
  if (c.abortBeforeTools) controller.abort();
  const caller: DelegationCaller = {
    user_id: c.userId,
    tenant_id: 'tenant-eval',
    platform_role: 'community',
    exafy_admin: false,
    surface: 'vitanaland',
    channel: 'voice',
    session_id: `eval-${c.id}`,
  } as DelegationCaller;

  const outcome = await agent.run(c.request, caller, controller.signal, runLoop, (userId, what) => reads.push({ userId, what }));

  const failures: string[] = [];
  const e = c.expect;
  const findings = isFindings(outcome.result) ? outcome.result : null;

  // ── Expectations specific to the case ──
  if (outcome.ok !== e.ok) failures.push(`expected ok=${e.ok}, got ok=${outcome.ok} (${outcome.error ?? 'no error'})`);
  if (e.toolsUsed && JSON.stringify(findings?.tools_used ?? loopToolNames) !== JSON.stringify(e.toolsUsed)) {
    failures.push(`tools used ${JSON.stringify(findings?.tools_used ?? loopToolNames)}, expected ${JSON.stringify(e.toolsUsed)}`);
  }
  for (const s of e.findingsContains ?? []) if (!findings?.findings.includes(s)) failures.push(`findings lack "${s}"`);
  for (const s of e.findingsNotContains ?? []) if (findings?.findings.includes(s)) failures.push(`findings contain "${s}"`);
  for (const s of e.toolResultContains ?? []) if (!seen.some((r) => r.result.includes(s))) failures.push(`no tool result contains "${s}"`);
  if (e.toolErrors) {
    const errs = seen.filter((r) => r.isError).map((r) => r.name);
    if (JSON.stringify(errs) !== JSON.stringify(e.toolErrors)) failures.push(`tool errors ${JSON.stringify(errs)}, expected ${JSON.stringify(e.toolErrors)}`);
  }
  if (e.budgetExhausted !== undefined && budgetExhausted !== e.budgetExhausted) failures.push(`budgetExhausted=${budgetExhausted}, expected ${e.budgetExhausted}`);
  if (e.errorContains && !(outcome.error ?? '').includes(e.errorContains)) failures.push(`error "${outcome.error ?? ''}" lacks "${e.errorContains}"`);
  if (e.maxModelCalls !== undefined && calls.n > e.maxModelCalls) failures.push(`model called ${calls.n} times, at most ${e.maxModelCalls} allowed`);

  // ── Invariants every case must hold ──
  const foreignRead = reads.find((r) => r.userId !== c.userId);
  if (foreignRead) failures.push(`read "${foreignRead.what}" was scoped to ${foreignRead.userId}, not the caller ${c.userId}`);
  const surfaced = [...seen.map((r) => r.result), findings?.findings ?? ''].join('\n');
  for (const m of agent.foreignMarkers) if (surfaced.includes(m)) failures.push(`another user's data surfaced: "${m}"`);
  const executedTools = findings?.tools_used ?? loopToolNames;
  if (executedTools.length > agent.maxToolCalls) failures.push(`${executedTools.length} tool calls exceed the budget of ${agent.maxToolCalls}`);
  const known = new Set(agent.tools.map((t) => t.name));
  for (const r of seen) if (!known.has(r.name) && !r.isError) failures.push(`unknown tool ${r.name} returned a non-error result`);
  if (budgetExhausted && calls.toolless.length === 0) failures.push('budget exhausted but the final call still offered tools');
  if (outcome.ok) {
    if (!findings) failures.push('ok outcome without findings');
    else {
      if (findings.findings.length > agent.findingsMaxChars + 1) failures.push(`findings ${findings.findings.length} chars exceed ${agent.findingsMaxChars}`);
      if (!/not a script/i.test(findings.note)) failures.push('findings note does not say they are not a script');
    }
  } else if (outcome.result !== null) {
    failures.push('failed outcome still carried a result');
  }
  if (c.userId === null && calls.n > 0) failures.push('a signed-out caller reached the model');

  return {
    id: c.id,
    passed: failures.length === 0,
    failures,
    modelCalls: calls.n,
    toolsUsed: executedTools,
    toolResults: seen,
    budgetExhausted,
    outcome,
  };
}

export async function runSpecialistEvalSuite(agent: SpecialistUnderEval, cases: SpecialistEvalCase[]): Promise<{
  agentId: string; total: number; passed: number; results: SpecialistEvalResult[];
}> {
  const results: SpecialistEvalResult[] = [];
  for (const c of cases) results.push(await runSpecialistEval(agent, c));
  return { agentId: agent.agentId, total: results.length, passed: results.filter((r) => r.passed).length, results };
}

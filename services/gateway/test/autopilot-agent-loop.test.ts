/**
 * VTID-04006: the provider-neutral tool loop.
 */

import { runAgentLoop, trimHistoryForBudget, buildWrapUpPrompt, buildExplorationBudgetPrompt, CONTINUE_PROMPT, NUDGE_PROMPT } from '../src/services/autopilot-agent/agent-loop';
import type { LLMRouterMessage, LLMRouterResult } from '../src/services/llm-router';
import type { ToolOutcome } from '../src/services/autopilot-agent/agent-tools';

const TOOLS = [{ name: 'read_file', description: 'r', inputSchema: {} }, { name: 'finish', description: 'f', inputSchema: {} }];

function llm(seq: Array<Partial<LLMRouterResult>>): jest.Mock<Promise<LLMRouterResult>, [string, LLMRouterMessage[], string]> {
  const fn = jest.fn();
  for (const r of seq) fn.mockResolvedValueOnce({ ok: true, provider: 'deepseek', model: 'deepseek-flash', usage: { inputTokens: 10, outputTokens: 5 }, ...r } as LLMRouterResult);
  return fn;
}

describe('VTID-04006 runAgentLoop', () => {
  it('runs tool calls, feeds results back, and stops on finish with the transcript in router shape', async () => {
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { toolCalls: [{ id: 'c2', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: `contents of ${args.path}` });
    const steps: string[] = [];
    const r = await runAgentLoop({ systemPrompt: 'sys', prompt: 'do it', tools: TOOLS, execute, callLlm, onStep: (s) => steps.push(`${s.kind}:${s.name ?? ''}`) });
    expect(r.ok).toBe(true);
    expect(r.finished).toEqual({ summary: 's', pr_title: 't', pr_body: 'b' });
    expect(r.turns).toBe(2);
    expect(r.toolCalls).toBe(2);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(r.provider).toBe('deepseek');
    // Second call carries the first turn as toolCalls/toolResults history + the continue prompt.
    const [prompt2, history2, sys2] = callLlm.mock.calls[1];
    expect(prompt2).toBe(CONTINUE_PROMPT);
    expect(sys2).toBe('sys');
    expect(history2).toEqual([
      { role: 'user', content: 'do it' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }], content: undefined },
      { role: 'user', toolResults: [{ id: 'c1', name: 'read_file', result: 'contents of a.ts', isError: undefined }] },
    ]);
    expect(steps).toEqual(['llm:', 'tool:read_file', 'llm:', 'tool:finish', 'finish:']);
  });

  it('nudges a text-only answer back to tools and gives up after 3 in a row', async () => {
    const callLlm = llm([{ text: 'I think…' }, { text: 'still thinking' }, { text: 'and more' }]);
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute: async () => ({ result: '' }), callLlm });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/text 3 times/);
    expect(callLlm.mock.calls[1][0]).toBe(NUDGE_PROMPT);
  });

  it('surfaces an LLM failure and the turn it happened on', async () => {
    const callLlm = jest.fn().mockResolvedValue({ ok: false, error: 'DeepSeek 503' });
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute: async () => ({ result: '' }), callLlm });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('LLM call failed on turn 1: DeepSeek 503');
  });

  it('stops at maxTurns and at the deadline', async () => {
    const forever = jest.fn().mockResolvedValue({ ok: true, toolCalls: [{ name: 'read_file', arguments: { path: 'x' } }] });
    const capped = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute: async () => ({ result: 'x' }), callLlm: forever, maxTurns: 3 });
    expect(capped.ok).toBe(false);
    expect(capped.error).toMatch(/3-turn cap/);
    let t = 0;
    const now = () => (t += 70_000);
    const late = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute: async () => ({ result: 'x' }), callLlm: forever, deadlineMs: 100_000, now });
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/deadline exceeded/);
  });

  it('continues a prior transcript (fix round) instead of starting over', async () => {
    const prior: LLMRouterMessage[] = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'done' }];
    const callLlm = llm([{ toolCalls: [{ name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] }]);
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'tsc failed, fix it', tools: TOOLS, execute: async (_n, a) => ({ result: 'ok', finished: a as any }), callLlm, history: prior });
    expect(r.ok).toBe(true);
    expect(callLlm.mock.calls[0][1]).toEqual(prior);
    expect(r.history.slice(0, 2)).toEqual(prior);
  });

  it('records fallbackUsed when any turn was served by the fallback provider', async () => {
    const callLlm = llm([{ fallbackUsed: true, provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6', toolCalls: [{ name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] }]);
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute: async (_n, a) => ({ result: 'ok', finished: a as any }), callLlm });
    expect(r.fallbackUsed).toBe(true);
    expect(r.provider).toBe('bedrock');
  });
});

describe('VTID-04194 wrap-up margin', () => {
  it('forces the wrap-up prompt once an edit has landed and turns remaining hit the margin', async () => {
    // maxTurns=10, default wrapUpMarginTurns=8: an edit on turn 1 leaves
    // turnsRemaining=9 (>8, no wrap-up yet); the NEXT turn (turn 2) leaves
    // turnsRemaining=8 (<=8, wrap-up fires).
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c3', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'ok' });
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 10 });
    expect(r.ok).toBe(true);
    // Prompt after the edit (turnsRemaining=9) is still the normal continue prompt.
    expect(callLlm.mock.calls[1][0]).toBe(CONTINUE_PROMPT);
    // Prompt after the SECOND turn (turnsRemaining=8) switches to wrap-up.
    expect(callLlm.mock.calls[2][0]).toBe(buildWrapUpPrompt(8));
    expect(callLlm.mock.calls[2][0]).toMatch(/only 8 turn\(s\) remain/);
  });

  it('never forces wrap-up before any edit has happened, even with almost no turns left', async () => {
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'ok' });
    // maxTurns=2: after turn 1 turnsRemaining=1 (deep inside any margin), but
    // no edit_file/write_file/delete_file call has succeeded yet.
    await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 2 });
    expect(callLlm.mock.calls[1][0]).toBe(CONTINUE_PROMPT);
  });

  it('does not count a FAILED edit_file call as "an edit has happened"', async () => {
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'scope violation', isError: true });
    // maxTurns=9 puts turnsRemaining at 8 after turn 1 — inside the default
    // margin IF the (failed) edit counted, but it must not.
    await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 9 });
    expect(callLlm.mock.calls[1][0]).toBe(CONTINUE_PROMPT);
  });

  it('honors a custom wrapUpMarginTurns instead of the default 8', async () => {
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'ok' });
    // maxTurns=2 -> turnsRemaining=1 after turn 1; with a margin of 1 this
    // must trigger even though the default margin (8) would trivially too —
    // pin the OPTION is actually read, not just the default.
    await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 2, wrapUpMarginTurns: 1 });
    expect(callLlm.mock.calls[1][0]).toBe(buildWrapUpPrompt(1));
  });

  it('the wrap-up prompt names the tool and stays actionable, not just a warning', () => {
    const p = buildWrapUpPrompt(3);
    expect(p).toMatch(/3 turn\(s\) remain/);
    expect(p).toMatch(/finish\(summary, pr_title, pr_body\)/);
    expect(p).toMatch(/Do NOT start new exploration/);
  });

  it('regression: VTID-04138 shape — a late edit now gets real turns to verify and finish instead of dying at the cap', async () => {
    // Mirrors the live failure: many unproductive read/search turns, THEN an
    // edit, with enough turns left (thanks to the margin firing early) for
    // the model to run a check and call finish before the cap.
    const seq: Array<{ toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }> = [];
    for (let i = 0; i < 5; i++) seq.push({ toolCalls: [{ id: `s${i}`, name: 'search_text', arguments: { pattern: 'x' } }] });
    seq.push({ toolCalls: [{ id: 'e1', name: 'edit_file', arguments: { path: 'app.js' } }] }); // turn 6, maxTurns=10 -> turnsRemaining=4 (< default margin 8)
    seq.push({ toolCalls: [{ id: 'chk', name: 'run_check', arguments: { kind: 'tsc' } }] });
    seq.push({ toolCalls: [{ id: 'f1', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] });
    const callLlm = llm(seq);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'ok' });
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 10, wrapUpMarginTurns: 8 });
    expect(r.ok).toBe(true);
    expect(r.finished?.pr_title).toBe('t');
    // The prompt driving the run_check/finish turns was the wrap-up prompt, not the open-ended continue prompt.
    expect(callLlm.mock.calls[6][0]).toMatch(/Do NOT start new exploration/);
  });
});

describe('VTID-04213 exploration budget', () => {
  it('switches to the exploration-budget prompt once turns used reach the budget with no edit yet', async () => {
    // explorationBudgetTurns=3: turns 1-2 are plain reads (no edit), turn 3
    // is another read. The prompt AFTER turn 3 (turns=3 >= budget 3) must
    // switch, even though no edit has ever happened.
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { toolCalls: [{ id: 'c2', name: 'search_text', arguments: { pattern: 'x' } }] },
      { toolCalls: [{ id: 'c3', name: 'read_file', arguments: { path: 'b.ts' } }] },
      { toolCalls: [{ id: 'c4', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'ok' });
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 10, explorationBudgetTurns: 3 });
    expect(r.ok).toBe(true);
    // After turn 1 and turn 2, still under budget — normal continue prompt.
    expect(callLlm.mock.calls[1][0]).toBe(CONTINUE_PROMPT);
    expect(callLlm.mock.calls[2][0]).toBe(CONTINUE_PROMPT);
    // After turn 3 (turns=3 >= budget 3), switches to the convergence prompt.
    expect(callLlm.mock.calls[3][0]).toBe(buildExplorationBudgetPrompt(3, 7));
    expect(callLlm.mock.calls[3][0]).toMatch(/Stop broadening the search/);
  });

  it('never fires once an edit has landed — the wrap-up path takes over instead', async () => {
    // explorationBudgetTurns=1 would trigger on turn 1 if no edit had
    // happened, but turn 1 IS a successful edit, so hasEdited gates it out
    // regardless of how small the exploration budget is.
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'ok' });
    await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 100, explorationBudgetTurns: 1 });
    expect(callLlm.mock.calls[1][0]).toBe(CONTINUE_PROMPT);
  });

  it('does not count a FAILED edit_file call as "an edit has happened" for exploration-budget purposes', async () => {
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'app.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'scope violation', isError: true });
    // explorationBudgetTurns=1: the failed edit on turn 1 must not suppress
    // the exploration-budget prompt on the next turn.
    await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 10, explorationBudgetTurns: 1 });
    expect(callLlm.mock.calls[1][0]).toBe(buildExplorationBudgetPrompt(1, 9));
  });

  it('honors a custom explorationBudgetTurns instead of the default 40', async () => {
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'b.ts' } }] },
      { toolCalls: [{ id: 'c3', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'ok' });
    // Default budget (40) would never fire in a 3-turn run; pin that the
    // OPTION is actually read by using a budget of 2.
    await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 10, explorationBudgetTurns: 2 });
    expect(callLlm.mock.calls[2][0]).toBe(buildExplorationBudgetPrompt(2, 8));
  });

  it('the exploration-budget prompt tells the model to converge or explain, not just to keep going', () => {
    const p = buildExplorationBudgetPrompt(40, 20);
    expect(p).toMatch(/40 turn\(s\) exploring/);
    expect(p).toMatch(/20 turn\(s\) left/);
    expect(p).toMatch(/Stop broadening the search/);
    expect(p).toMatch(/finish\(summary, pr_title, pr_body\)/);
  });

  it('regression: the 10-failed-execution shape — pure exploration with no edit now converges instead of hitting the turn cap silently', async () => {
    // Mirrors the live failure (VTID-04160/61/62/63/66/67/68/69/70/71/77):
    // dozens of read_file/search_text calls, zero edits. With the
    // exploration budget in place, the model gets an explicit convergence
    // nudge well before the hard cap instead of being told to just
    // "continue" indefinitely.
    const seq: Array<{ toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }> = [];
    for (let i = 0; i < 5; i++) seq.push({ toolCalls: [{ id: `s${i}`, name: 'search_text', arguments: { pattern: 'x' } }] });
    seq.push({ toolCalls: [{ id: 'e1', name: 'edit_file', arguments: { path: 'operator.ts' } }] }); // turn 6, after the nudge fires on turn 4 (budget=4)
    seq.push({ toolCalls: [{ id: 'f1', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] });
    const callLlm = llm(seq);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'ok' });
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools: TOOLS, execute, callLlm, maxTurns: 20, explorationBudgetTurns: 4 });
    expect(r.ok).toBe(true);
    expect(r.finished?.pr_title).toBe('t');
    // The prompt driving turn 5 (after 4 unproductive search turns) was the
    // exploration-budget nudge, not the open-ended continue prompt.
    expect(callLlm.mock.calls[4][0]).toMatch(/Stop broadening the search/);
  });
});

describe('VTID-04112 trimHistoryForBudget', () => {
  it('returns the history unchanged when under budget', () => {
    const history: LLMRouterMessage[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }], content: undefined },
      { role: 'user', toolResults: [{ id: 'c1', name: 'read_file', result: 'short contents', isError: undefined }] },
    ];
    const trimmed = trimHistoryForBudget(history, 10_000);
    expect(trimmed).toEqual(history);
    expect(trimmed).toBe(history);
  });

  it('replaces the OLDEST tool results with a notice once over budget, leaving the newest message intact', () => {
    const big = 'x'.repeat(1000);
    const history: LLMRouterMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }], content: undefined },
      { role: 'user', toolResults: [{ id: 'c1', name: 'read_file', result: big, isError: undefined }] },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'b.ts' } }], content: undefined },
      { role: 'user', toolResults: [{ id: 'c2', name: 'read_file', result: big, isError: undefined }] },
    ];
    const trimmed = trimHistoryForBudget(history, 1200);
    // Oldest tool result (index 2) shrinks to the trim notice.
    const first = trimmed[2] as { role: 'user'; toolResults: Array<{ result: string }> };
    expect(first.toolResults[0].result).toBe('[tool result trimmed to bound context size — this tool ran earlier in the session]');
    // The most recent message (last in the array) is never touched.
    expect(trimmed[trimmed.length - 1]).toEqual(history[history.length - 1]);
    // The original array passed in is not mutated.
    const originalLast = history[history.length - 1] as { role: 'user'; toolResults: Array<{ result: string }> };
    expect(originalLast.toolResults[0].result).toBe(big);
  });

  it('keeps trimming forward through the history until under budget or only the last message remains', () => {
    const big = 'y'.repeat(1000);
    const history: LLMRouterMessage[] = [
      { role: 'user', toolResults: [{ id: 'c0', name: 'read_file', result: big, isError: undefined }] },
      { role: 'user', toolResults: [{ id: 'c1', name: 'read_file', result: big, isError: undefined }] },
      { role: 'user', toolResults: [{ id: 'c2', name: 'read_file', result: big, isError: undefined }] },
      { role: 'user', toolResults: [{ id: 'c3', name: 'read_file', result: big, isError: undefined }] },
    ];
    // Budget only large enough for ~1 untrimmed result plus notices.
    const trimmed = trimHistoryForBudget(history, 1100);
    const results = trimmed.map((m) => (m as { toolResults: Array<{ result: string }> }).toolResults[0].result);
    // Every entry except the last got trimmed to the short notice.
    expect(results[0]).toBe('[tool result trimmed to bound context size — this tool ran earlier in the session]');
    expect(results[1]).toBe('[tool result trimmed to bound context size — this tool ran earlier in the session]');
    expect(results[2]).toBe('[tool result trimmed to bound context size — this tool ran earlier in the session]');
    // The loop never touches the last message, even if the budget is still exceeded.
    expect(results[3]).toBe(big);
  });

  it('defaults to the 120,000-char budget when none is passed', () => {
    const big = 'z'.repeat(130_000);
    const history: LLMRouterMessage[] = [
      { role: 'user', toolResults: [{ id: 'c0', name: 'read_file', result: big, isError: undefined }] },
      { role: 'user', content: 'latest' },
    ];
    const trimmed = trimHistoryForBudget(history);
    const first = trimmed[0] as { toolResults: Array<{ result: string }> };
    expect(first.toolResults[0].result).toBe('[tool result trimmed to bound context size — this tool ran earlier in the session]');
  });
});

describe('VTID-04112 runAgentLoop history trimming wiring', () => {
  it('sends a trimmed copy to callLlm while the returned history keeps every result in full', async () => {
    const big = 'w'.repeat(1000);
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'b.ts' } }] },
      { toolCalls: [{ id: 'c3', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: big });
    const r = await runAgentLoop({
      systemPrompt: 'sys',
      prompt: 'do it',
      tools: TOOLS,
      execute,
      callLlm,
      historyCharBudget: 1200,
    });
    expect(r.ok).toBe(true);
    // The returned/stored history is never trimmed — full tool results survive.
    const storedFirstToolResults = (r.history[2] as { toolResults: Array<{ result: string }> }).toolResults;
    expect(storedFirstToolResults[0].result).toBe(big);

    // The THIRD call's history argument (what was actually sent to the model)
    // has the earlier (turn-1) tool result trimmed, since by then the budget
    // was exceeded.
    const [, historyOnThirdCall] = callLlm.mock.calls[2];
    const sentFirstToolResults = (historyOnThirdCall[2] as { toolResults: Array<{ result: string }> }).toolResults;
    expect(sentFirstToolResults[0].result).toBe('[tool result trimmed to bound context size — this tool ran earlier in the session]');
  });

  it('honors a custom historyCharBudget instead of the 120,000-char default', async () => {
    // 2 x 1000-char results is nowhere near the 120,000-char default (no
    // trim would happen with the default), but a tiny explicit budget must
    // force the earlier one to trim on the third call, once it is no
    // longer the most recent message.
    const big = 'v'.repeat(1000);
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'b.ts' } }] },
      { toolCalls: [{ id: 'c3', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: big });
    await runAgentLoop({
      systemPrompt: 'sys',
      prompt: 'do it',
      tools: TOOLS,
      execute,
      callLlm,
      historyCharBudget: 1200,
    });
    const [, historyOnThirdCall] = callLlm.mock.calls[2];
    const sentFirstToolResults = (historyOnThirdCall[2] as { toolResults: Array<{ result: string }> }).toolResults;
    expect(sentFirstToolResults[0].result).toBe('[tool result trimmed to bound context size — this tool ran earlier in the session]');
  });

  it('never trims when the default 120,000-char budget is not exceeded', async () => {
    const callLlm = llm([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { toolCalls: [{ id: 'c2', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] },
    ]);
    const execute = jest.fn(async (name: string, args: Record<string, unknown>) =>
      name === 'finish' ? { result: 'ok', finished: args as any } : { result: 'tiny contents' });
    await runAgentLoop({ systemPrompt: 'sys', prompt: 'do it', tools: TOOLS, execute, callLlm });
    const [, historyOnSecondCall] = callLlm.mock.calls[1];
    const sentToolResults = (historyOnSecondCall[2] as { toolResults: Array<{ result: string }> }).toolResults;
    expect(sentToolResults[0].result).toBe('tiny contents');
  });
});

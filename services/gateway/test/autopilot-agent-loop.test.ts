/**
 * VTID-04006: the provider-neutral tool loop.
 */

import { runAgentLoop, CONTINUE_PROMPT, NUDGE_PROMPT } from '../src/services/autopilot-agent/agent-loop';
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

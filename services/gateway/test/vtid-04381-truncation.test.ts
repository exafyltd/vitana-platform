/**
 * VTID-04381: the router reports the provider's stop reason and every
 * DeepSeek tool call; the agent loop never acts on a reply cut off at the
 * output-token limit.
 */
import { isTruncatedStop, parseOpenAIToolCalls, type LLMRouterResult } from '../src/services/llm-router';
import { runAgentLoop, MAX_CONSECUTIVE_TRUNCATIONS, TRUNCATED_PROMPT } from '../src/services/autopilot-agent/agent-loop';

describe('isTruncatedStop', () => {
  it('matches both provider spellings of "ran out of output tokens"', () => {
    expect(isTruncatedStop('length')).toBe(true);
    expect(isTruncatedStop('max_tokens')).toBe(true);
    for (const r of ['stop', 'tool_calls', 'end_turn', 'tool_use', undefined, null, '']) expect(isTruncatedStop(r as string)).toBe(false);
  });
});

describe('parseOpenAIToolCalls', () => {
  it('keeps every call with its id, in order', () => {
    const r = parseOpenAIToolCalls([
      { id: 'a', function: { name: 'read_file', arguments: '{"path":"x.ts"}' } },
      { id: 'b', function: { name: 'search_text', arguments: '{"pattern":"y"}' } },
    ]);
    expect(r.unparseable).toBe(0);
    expect(r.calls).toEqual([
      { id: 'a', name: 'read_file', arguments: { path: 'x.ts' } },
      { id: 'b', name: 'search_text', arguments: { pattern: 'y' } },
    ]);
  });
  it('counts a half-written call instead of dropping it silently; empty args are {}', () => {
    const r = parseOpenAIToolCalls([
      { id: 'a', function: { name: 'git_status', arguments: '' } },
      { id: 'b', function: { name: 'write_file', arguments: '{"path":"x.ts","content":"abc' } },
    ]);
    expect(r.calls).toEqual([{ id: 'a', name: 'git_status', arguments: {} }]);
    expect(r.unparseable).toBe(1);
  });
  it('tolerates undefined', () => {
    expect(parseOpenAIToolCalls(undefined)).toEqual({ calls: [], unparseable: 0 });
  });
});

describe('runAgentLoop on a truncated reply', () => {
  const truncated: LLMRouterResult = {
    ok: true, text: 'partial', truncated: true, stopReason: 'length',
    toolCalls: [{ id: 't1', name: 'write_file', arguments: { path: 'a.ts', content: 'x' } }],
  };
  const finish: LLMRouterResult = {
    ok: true, toolCalls: [{ id: 'f', name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }],
  };

  it('does not execute the cut turn\'s calls, tells the model why, and continues', async () => {
    const replies = [truncated, finish];
    const prompts: string[] = [];
    const executed: string[] = [];
    const r = await runAgentLoop({
      prompt: 'task', systemPrompt: 'sys',
      callLlm: async (p) => { prompts.push(p); return replies.shift()!; },
      execute: async (name) => {
        executed.push(name);
        return name === 'finish'
          ? { result: 'ok', finished: { summary: 's', pr_title: 't', pr_body: 'b' } }
          : { result: 'ok' };
      },
    } as any);
    expect(r.ok).toBe(true);
    expect(executed).toEqual(['finish']);
    expect(prompts[1]).toBe(TRUNCATED_PROMPT);
  });

  it('ends the run with the real reason after repeated truncation', async () => {
    const r = await runAgentLoop({
      prompt: 'task', systemPrompt: 'sys',
      callLlm: async () => truncated,
      execute: async () => ({ result: 'ok' }),
    } as any);
    expect(r.ok).toBe(false);
    expect(r.turns).toBe(MAX_CONSECUTIVE_TRUNCATIONS);
    expect(r.error).toMatch(/output-token limit 3 turns in a row \(stop_reason=length\)/);
    expect(r.toolCalls).toBe(0);
  });
});

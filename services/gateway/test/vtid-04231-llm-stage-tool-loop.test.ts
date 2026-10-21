/**
 * VTID-04231: the shared bounded tool loop for one routing stage
 * (llm-stage-tool-loop.ts) — the shape the validator, triage and spec
 * generator share: tools until a text answer, every budget bounded, one
 * tool-less final call when a budget runs out, never throws.
 */
import {
  runStageToolLoop,
  trimStageHistory,
  STAGE_LOOP_CONTINUE_PROMPT,
  STAGE_LOOP_FINAL_PROMPT,
  type StageLlmCall,
} from '../src/services/llm-stage-tool-loop';

const tool = { name: 'lookup', description: 'x', inputSchema: { type: 'object', properties: {} } };

function scripted(replies: Array<Partial<Awaited<ReturnType<StageLlmCall>>>>): { call: jest.Mock; calls: Array<Parameters<StageLlmCall>> } {
  const calls: Array<Parameters<StageLlmCall>> = [];
  let i = 0;
  const call = jest.fn(async (...args: Parameters<StageLlmCall>) => {
    calls.push(args);
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return { ok: true, ...r } as Awaited<ReturnType<StageLlmCall>>;
  });
  return { call, calls };
}

describe('runStageToolLoop (VTID-04231)', () => {
  it('passes stage/service/vtid/systemPrompt/tools/history to the router and ends on a text reply', async () => {
    const { call, calls } = scripted([{ text: 'final answer', provider: 'bedrock', model: 'm1', usage: { inputTokens: 10, outputTokens: 5 } }]);
    const r = await runStageToolLoop({ stage: 'validator', service: 'svc', vtid: 'VTID-1', systemPrompt: 'sys', prompt: 'go', tools: [tool], execute: async () => ({ result: 'never' }), callLlm: call });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('final answer');
    expect(r.turns).toBe(1);
    expect(r.toolCalls).toBe(0);
    expect(r.provider).toBe('bedrock');
    expect(r.model).toBe('m1');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const [stage, prompt, opts] = calls[0];
    expect(stage).toBe('validator');
    expect(prompt).toBe('go');
    expect(opts).toMatchObject({ service: 'svc', vtid: 'VTID-1', systemPrompt: 'sys', allowFallback: true, history: [] });
    expect(opts.tools).toEqual([tool]);
    expect(r.history).toEqual([{ role: 'user', content: 'go' }, { role: 'assistant', content: 'final answer' }]);
  });

  it('executes tool calls, feeds results back with their ids, and continues with the continue prompt', async () => {
    const { call, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'a' } }, { id: 'c2', name: 'lookup', arguments: { q: 'b' } }] },
      { text: 'done', fallbackUsed: true },
    ]);
    const execute = jest.fn(async (_n: string, args: Record<string, unknown>) => ({ result: `r:${args.q}`, isError: args.q === 'b' }));
    const r = await runStageToolLoop({ stage: 'triage', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [tool], execute, callLlm: call });
    expect(r.ok).toBe(true);
    expect(r.toolCalls).toBe(2);
    expect(r.toolNames).toEqual(['lookup', 'lookup']);
    expect(r.fallbackUsed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(calls[1][1]).toBe(STAGE_LOOP_CONTINUE_PROMPT);
    const sent = calls[1][2].history;
    expect(sent).toEqual([
      { role: 'user', content: 'p' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'a' } }, { id: 'c2', name: 'lookup', arguments: { q: 'b' } }], content: undefined },
      { role: 'user', toolResults: [{ id: 'c1', name: 'lookup', result: 'r:a', isError: false }, { id: 'c2', name: 'lookup', result: 'r:b', isError: true }] },
    ]);
    expect(r.steps.map((s) => s.kind)).toEqual(['llm', 'tool', 'tool', 'llm']);
  });

  it('a throwing tool becomes an error result, never a thrown loop', async () => {
    const { call } = scripted([{ toolCalls: [{ name: 'lookup', arguments: {} }] }, { text: 'ok' }]);
    const r = await runStageToolLoop({ stage: 'triage', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [tool], execute: async () => { throw new Error('boom'); }, callLlm: call });
    expect(r.ok).toBe(true);
    const results = (r.history[2] as { toolResults: Array<{ result: string; isError?: boolean }> }).toolResults;
    expect(results[0].isError).toBe(true);
    expect(results[0].result).toContain('boom');
  });

  it('when the turn budget is exhausted it makes ONE tool-less final call and returns that text', async () => {
    const { call, calls } = scripted([
      { toolCalls: [{ name: 'lookup', arguments: {} }] },
      { toolCalls: [{ name: 'lookup', arguments: {} }] },
      { text: 'forced final' },
    ]);
    const r = await runStageToolLoop({ stage: 'planner', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [tool], execute: async () => ({ result: 'x' }), maxTurns: 2, callLlm: call });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('forced final');
    expect(r.budgetExhausted).toBe(true);
    expect(r.turns).toBe(3);
    expect(calls[2][1]).toBe(STAGE_LOOP_FINAL_PROMPT);
    expect(calls[2][2].tools).toBeUndefined();
    expect(calls[1][2].tools).toEqual([tool]);
  });

  it('caps tool calls: calls beyond maxToolCalls get an error result and the next turn is tool-less', async () => {
    const { call, calls } = scripted([
      { toolCalls: [{ name: 'lookup', arguments: {} }, { name: 'lookup', arguments: {} }, { name: 'lookup', arguments: {} }] },
      { text: 'final' },
    ]);
    const execute = jest.fn(async () => ({ result: 'x' }));
    const r = await runStageToolLoop({ stage: 'triage', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [tool], execute, maxToolCalls: 2, callLlm: call });
    expect(execute).toHaveBeenCalledTimes(2);
    const results = (r.history[2] as { toolResults: Array<{ result: string; isError?: boolean }> }).toolResults;
    expect(results[2].isError).toBe(true);
    expect(results[2].result).toContain('budget');
    expect(calls[1][2].tools).toBeUndefined();
    expect(r.budgetExhausted).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('a deadline forces the final call', async () => {
    let t = 0;
    const now = () => t;
    const { call, calls } = scripted([{ toolCalls: [{ name: 'lookup', arguments: {} }] }, { text: 'late final' }]);
    const r = await runStageToolLoop({ stage: 'triage', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [tool], execute: async () => { t += 5_000; return { result: 'x' }; }, deadlineMs: 1_000, now, callLlm: call });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('late final');
    expect(calls[1][1]).toBe(STAGE_LOOP_FINAL_PROMPT);
    expect(r.steps.some((s) => s.kind === 'final' && /deadline/.test(s.detail))).toBe(true);
  });

  it('a router failure is ok:false with the stage named, never a throw', async () => {
    const call = jest.fn(async () => ({ ok: false, error: 'no provider' }));
    const r = await runStageToolLoop({ stage: 'validator', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [], execute: async () => ({ result: '' }), callLlm: call as unknown as StageLlmCall });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('validator stage call failed on turn 1: no provider');
  });

  it('an empty reply with no tool call is a failure, not an empty answer', async () => {
    const { call } = scripted([{ text: '   ' }]);
    const r = await runStageToolLoop({ stage: 'validator', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [], execute: async () => ({ result: '' }), callLlm: call });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/neither text nor a tool call/);
  });

  it('with no tools it sends no tools key and a provider override when given', async () => {
    const { call, calls } = scripted([{ text: 'x' }]);
    await runStageToolLoop({ stage: 'triage', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [], execute: async () => ({ result: '' }), providerOverride: 'deepseek', modelOverride: 'deepseek-flash', callLlm: call });
    expect(calls[0][2].tools).toBeUndefined();
    expect(calls[0][2]).toMatchObject({ providerOverride: 'deepseek', modelOverride: 'deepseek-flash' });
  });

  it('clips a huge tool result and trims the oldest results when the resent history exceeds the budget', async () => {
    const big = 'y'.repeat(50_000);
    const { call, calls } = scripted([
      { toolCalls: [{ name: 'lookup', arguments: {} }] },
      { toolCalls: [{ name: 'lookup', arguments: {} }] },
      { text: 'final' },
    ]);
    const r = await runStageToolLoop({ stage: 'triage', service: 'svc', systemPrompt: 's', prompt: 'p', tools: [tool], execute: async () => ({ result: big }), historyCharBudget: 25_000, callLlm: call });
    const stored = (r.history[2] as { toolResults: Array<{ result: string }> }).toolResults[0].result;
    expect(stored.length).toBeLessThan(21_000);
    expect(stored).toContain('[truncated]');
    const sentOnTurn3 = calls[2][2].history;
    const first = (sentOnTurn3[2] as { toolResults: Array<{ result: string }> }).toolResults[0].result;
    expect(first).toMatch(/trimmed to bound context size/);
    expect(trimStageHistory([{ role: 'user', content: 'a' }], 10)).toEqual([{ role: 'user', content: 'a' }]);
  });
});

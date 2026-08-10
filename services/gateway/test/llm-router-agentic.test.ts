/**
 * Router: multi-turn history + parallel tool calls (VTID-03579)
 *
 * The operator (`gemini-operator.ts`) is an agentic loop, not a one-shot
 * completion, and it was the last big direct-Google caller. Routing it required
 * the router to carry two things it never had: prior turns, and more than one
 * tool call per turn.
 *
 * Both are easy to get subtly wrong in ways that look fine:
 *   - Drop history and the model answers the current turn with no idea what
 *     came before. That reads to a user as the assistant developing amnesia,
 *     not as an error, and no status code says anything is wrong.
 *   - Read only the first tool call and the loop executes one tool, returns
 *     results for one, and then waits for a model that asked for three.
 *
 * These tests pin the rendering for BOTH providers in the active policy —
 * Bedrock (primary) and DeepSeek (fallback) — because they have genuinely
 * different wire shapes for a tool round-trip, and the fallback is the path
 * that runs precisely when nobody is watching.
 */

process.env.NODE_ENV = 'test';
process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::472838866351:role/test-role';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

const invokeBedrock = jest.fn();
jest.mock('../src/providers/bedrock', () => ({
  invokeBedrock: (...args: unknown[]) => invokeBedrock(...(args as [])),
}));

jest.mock('../src/services/llm-telemetry-service', () => ({
  startLLMCall: jest.fn(async () => ({ id: 'ctx' })),
  completeLLMCall: jest.fn(async () => undefined),
  failLLMCall: jest.fn(async () => undefined),
}));

const getActivePolicy = jest.fn();
jest.mock('../src/services/llm-routing-policy-service', () => ({
  getActivePolicy: (...args: unknown[]) => getActivePolicy(...(args as [])),
}));

import { callViaRouter, _resetPolicyCacheForTests, type LLMRouterMessage } from '../src/services/llm-router';

const BEDROCK_STAGE = {
  primary_provider: 'bedrock',
  primary_model: 'eu.anthropic.claude-sonnet-4-6',
  fallback_provider: 'deepseek',
  fallback_model: 'deepseek-chat',
};

function policyWith(stage = BEDROCK_STAGE) {
  return {
    policy: {
      planner: stage,
      worker: stage,
      operator: stage,
      validator: stage,
      memory: stage,
      triage: stage,
    },
  };
}

const HISTORY: LLMRouterMessage[] = [
  { role: 'user', content: 'How many open VTIDs are there?' },
  { role: 'assistant', toolCalls: [{ id: 'tu_1', name: 'list_vtids', arguments: { status: 'open' } }] },
  { role: 'user', toolResults: [{ id: 'tu_1', name: 'list_vtids', result: '{"count":7}' }] },
  { role: 'assistant', content: 'There are 7 open VTIDs.' },
];

describe('llm-router: agentic history + parallel tool calls (VTID-03579)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetPolicyCacheForTests();
    getActivePolicy.mockResolvedValue(policyWith());
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  it('sends prior turns to Bedrock with the current prompt LAST', async () => {
    invokeBedrock.mockResolvedValue({ ok: true, text: 'ok', toolCalls: [] });

    await callViaRouter('operator', 'And how many are blocked?', {
      service: 'test',
      history: HISTORY,
    });

    const req = invokeBedrock.mock.calls[0][0];
    expect(req.messages).toHaveLength(5);

    // Order is the whole point: Anthropic reads the LAST user message as the
    // current turn. Appending history after the prompt would make the model
    // answer a question from three turns ago.
    expect(req.messages[4]).toEqual({ role: 'user', content: 'And how many are blocked?' });
    expect(req.messages[0]).toEqual({ role: 'user', content: 'How many open VTIDs are there?' });
  });

  it('renders a Bedrock tool round-trip as tool_use / tool_result paired by id', async () => {
    invokeBedrock.mockResolvedValue({ ok: true, text: 'ok', toolCalls: [] });

    await callViaRouter('operator', 'next', { service: 'test', history: HISTORY });

    const req = invokeBedrock.mock.calls[0][0];

    expect(req.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'list_vtids', input: { status: 'open' } }],
    });
    expect(req.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"count":7}' }],
    });

    // The ids must MATCH. Anthropic rejects an unpaired tool_result with a 400 —
    // a hard failure, not a degraded answer — so this is the assertion that
    // catches a broken round-trip before production does.
    expect(req.messages[2].content[0].tool_use_id).toBe(req.messages[1].content[0].id);
  });

  it('returns every tool call the model asked for, not just the first', async () => {
    invokeBedrock.mockResolvedValue({
      ok: true,
      text: '',
      toolCall: { id: 'a', name: 'first_tool', arguments: {} },
      toolCalls: [
        { id: 'a', name: 'first_tool', arguments: {} },
        { id: 'b', name: 'second_tool', arguments: { x: 1 } },
        { id: 'c', name: 'third_tool', arguments: {} },
      ],
    });

    const r = await callViaRouter('operator', 'do three things', { service: 'test' });

    expect(r.ok).toBe(true);
    expect(r.toolCalls).toHaveLength(3);
    expect(r.toolCalls!.map((t) => t.name)).toEqual(['first_tool', 'second_tool', 'third_tool']);
    // `toolCall` stays the first element so pre-existing single-tool callers
    // (vision metadata, triage) are untouched by this change.
    expect(r.toolCall!.name).toBe('first_tool');
  });

  it('carries history into the DeepSeek fallback in OpenAI shape', async () => {
    // Bedrock fails, so the standing DeepSeek fallback takes over. If history
    // were dropped on this path, a Bedrock blip would silently reset the
    // conversation instead of continuing it.
    invokeBedrock.mockResolvedValue({ ok: false, error: 'invoke_failed', message: 'boom' });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'fallback reply' } }] }),
    });

    const r = await callViaRouter('operator', 'And how many are blocked?', {
      service: 'test',
      history: HISTORY,
    });

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('deepseek');
    expect(r.fallbackUsed).toBe(true);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    const roles = body.messages.map((m: { role: string }) => m.role);

    // OpenAI shape, NOT Anthropic's: the tool result is its own `role:'tool'`
    // message keyed by tool_call_id, not a content block on a user message.
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(body.messages[1].tool_calls[0].function.name).toBe('list_vtids');
    expect(body.messages[2].tool_call_id).toBe('tu_1');
    expect(body.messages[4]).toEqual({ role: 'user', content: 'And how many are blocked?' });
  });

  it('leaves a call with no history byte-identical to before', async () => {
    invokeBedrock.mockResolvedValue({ ok: true, text: 'ok', toolCalls: [] });

    await callViaRouter('memory', 'plain single-turn prompt', { service: 'test' });

    // Every existing caller passes no history. A regression that always built a
    // messages array (even an empty-prefixed one) would change the request shape
    // for the entire platform, so this pins the common path explicitly.
    const req = invokeBedrock.mock.calls[0][0];
    expect(req.messages).toEqual([{ role: 'user', content: 'plain single-turn prompt' }]);
  });
});

/**
 * VTID-04611 — on the cascade (es, fr, pt, pl, ru, tr, zh, ar), a spoken
 * "open …" the registry could not settle alone never opened anything.
 *
 * The navigate tool answers an ambiguous request with a short list and tells
 * the model to open its pick with navigate_to_screen. The cascade ran ONE
 * tool round and then a continuation with no tools, so that second call was
 * impossible: the model said something instead — found live by the voice
 * redirect suite (VTID-04607), where French "Ouvre mes messages" got
 * "I found no messaging screen" while the list had Inbox first.
 *
 * runCascadeModelTurn now allows a second round after a navigation tool,
 * keeps hand-off tools at one round, and always ends the turn tool-less.
 */
jest.mock('../../../../src/services/llm-router', () => ({
  callViaRouter: jest.fn(),
}));

import { CASCADE_MAX_TOOL_ROUNDS, runCascadeModelTurn } from '../../../../src/orb/live/upstream/cascaded-live-client';
import { callViaRouter } from '../../../../src/services/llm-router';

const mockCall = callViaRouter as jest.Mock;
const TOOLS = [
  { name: 'navigate', description: 'find a screen', inputSchema: { type: 'object', properties: {} } },
  { name: 'navigate_to_screen', description: 'open a screen', inputSchema: { type: 'object', properties: {} } },
  { name: 'report_to_specialist', description: 'hand off', inputSchema: { type: 'object', properties: {} } },
];

const text = (t: string) => ({ ok: true, text: t, provider: 'bedrock', model: 'm' });
const calls = (...names: string[]) => ({
  ok: true,
  text: '',
  provider: 'bedrock',
  model: 'm',
  toolCalls: names.map((name, i) => ({ id: `c${i}`, name, arguments: {} })),
});

function runner() {
  const ran: string[] = [];
  return {
    ran,
    runToolCalls: async (cs: Array<{ id?: string; name: string; arguments?: unknown }>) => {
      cs.forEach((c) => ran.push(c.name));
      return {
        withIds: cs.map((c, i) => ({ ...c, id: c.id || `x${i}`, arguments: c.arguments || {} })) as any,
        results: cs.map((c) => ({ id: c.id, name: c.name, result: `${c.name} ok` })),
      };
    },
  };
}

beforeEach(() => mockCall.mockReset());

describe('VTID-04611 cascade tool rounds', () => {
  it('lets the model open its pick after an ambiguous navigate, then ends in words', async () => {
    mockCall
      .mockResolvedValueOnce(calls('navigate'))
      .mockResolvedValueOnce(calls('navigate_to_screen'))
      .mockResolvedValueOnce(text('Ich öffne deine Nachrichten.'));
    const r = runner();
    const out = await runCascadeModelTurn({ userText: 'Ouvre mes messages', systemPrompt: 'sys', priorHistory: [], tools: TOOLS as any, runToolCalls: r.runToolCalls });

    expect(r.ran).toEqual(['navigate', 'navigate_to_screen']);
    expect(out.rounds).toBe(2);
    expect(out.completion.text).toBe('Ich öffne deine Nachrichten.');
    // Call 2 (after navigate) offers tools; call 3 (after the last round) does not.
    expect(mockCall.mock.calls[1][2].tools).toBe(TOOLS);
    expect(mockCall.mock.calls[2][2].tools).toBeUndefined();
    // The second round's history carries the whole first round.
    const history = mockCall.mock.calls[2][2].history;
    expect(history.filter((m: any) => 'toolResults' in m)).toHaveLength(2);
  });

  it('keeps hand-off tools at one round — the continuation carries no tools', async () => {
    mockCall.mockResolvedValueOnce(calls('report_to_specialist')).mockResolvedValueOnce(text('Devon übernimmt.'));
    const r = runner();
    const out = await runCascadeModelTurn({ userText: 'bug', systemPrompt: 'sys', priorHistory: [], tools: TOOLS as any, runToolCalls: r.runToolCalls });

    expect(out.rounds).toBe(1);
    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(mockCall.mock.calls[1][2].tools).toBeUndefined();
  });

  it(`never runs more than ${CASCADE_MAX_TOOL_ROUNDS} rounds, and the last call is tool-less`, async () => {
    mockCall
      .mockResolvedValueOnce(calls('navigate'))
      .mockResolvedValueOnce(calls('navigate'))
      .mockResolvedValueOnce(calls('navigate'));
    const r = runner();
    const out = await runCascadeModelTurn({ userText: 'x', systemPrompt: 'sys', priorHistory: [], tools: TOOLS as any, runToolCalls: r.runToolCalls });

    expect(out.rounds).toBe(CASCADE_MAX_TOOL_ROUNDS);
    expect(r.ran).toHaveLength(CASCADE_MAX_TOOL_ROUNDS);
    expect(mockCall).toHaveBeenCalledTimes(CASCADE_MAX_TOOL_ROUNDS + 1);
    expect(mockCall.mock.calls[CASCADE_MAX_TOOL_ROUNDS][2].tools).toBeUndefined();
  });

  it('a turn with no tool call is one call, with no tools when none are declared', async () => {
    mockCall.mockResolvedValueOnce(text('Hallo!'));
    const out = await runCascadeModelTurn({ userText: 'hi', systemPrompt: 'sys', priorHistory: [], tools: [], runToolCalls: runner().runToolCalls });
    expect(out.rounds).toBe(0);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall.mock.calls[0][2].tools).toBeUndefined();
    expect(mockCall.mock.calls[0][2].history).toBeUndefined();
  });
});

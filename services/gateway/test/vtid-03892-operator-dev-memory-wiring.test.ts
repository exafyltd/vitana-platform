/**
 * VTID-03892: wire dev_agent_memory (VTID-03889) into the Command Hub
 * Operator's own context-assembly system prompt.
 *
 * VTID-03889 built write/recall for dev_agent_memory but never connected it
 * to a live consumer — the Operator route (routes/operator.ts →
 * processWithGemini → callVertexWithTools) built its system prompt from
 * getOperatorSystemPrompt() (or an ORB-supplied override) with no memory of
 * this platform's own past engineering decisions/incidents/conventions.
 *
 * This pins two things: (1) recallDevMemory is actually called with the
 * user's message before the LLM call, and its hits are appended to the
 * system prompt sent to callViaRouter, whether the base prompt is the
 * default operator prompt or a caller-supplied custom instruction; and
 * (2) the wiring is fail-open — a recall failure or thrown error must never
 * block or alter the operator turn, only omit the memory block.
 */

jest.mock('node-fetch');
jest.mock('../src/services/llm-router', () => ({
  callViaRouter: jest.fn(),
}));
jest.mock('../src/services/dev-agent-memory', () => ({
  recallDevMemory: jest.fn(),
}));

import { processWithGemini } from '../src/services/gemini-operator';
import { callViaRouter } from '../src/services/llm-router';
import { recallDevMemory } from '../src/services/dev-agent-memory';

const mockedCallViaRouter = callViaRouter as jest.Mock;
const mockedRecallDevMemory = recallDevMemory as jest.Mock;

function routerOk(text: string) {
  return { ok: true, text, provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' };
}

describe('VTID-03892: Operator dev_agent_memory context wiring', () => {
  beforeEach(() => {
    mockedCallViaRouter.mockReset();
    mockedRecallDevMemory.mockReset();
  });

  it('recalls dev_agent_memory scoped to vitana-platform using the user message as the query', async () => {
    mockedRecallDevMemory.mockResolvedValueOnce({ ok: true, hits: [] });
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('hi'));

    await processWithGemini({ text: 'why do we route Claude via Bedrock?', threadId: 't1' });

    expect(mockedRecallDevMemory).toHaveBeenCalledWith(
      'why do we route Claude via Bedrock?',
      'vitana-platform',
      expect.objectContaining({ limit: 20 }), // VTID-04027: wider candidate set, diversified to 10 before rendering
    );
  });

  it('appends recalled hits to the default operator system prompt sent to the router', async () => {
    mockedRecallDevMemory.mockResolvedValueOnce({
      ok: true,
      hits: [
        {
          id: 'h1',
          vtid: 'VTID-03563',
          category: 'decision',
          title: 'Claude via Bedrock, always',
          content: 'Never route a stage at the direct Anthropic API — no credit balance.',
          importance: 90,
          source: 'backfill',
          tags: [],
          created_at: '2026-08-10T00:00:00Z',
          similarity: 0.81,
        },
      ],
    });
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('answer'));

    await processWithGemini({ text: 'why Bedrock?', threadId: 't1' });

    expect(mockedCallViaRouter).toHaveBeenCalledTimes(1);
    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt).toContain('Relevant engineering memory');
    expect(opts.systemPrompt).toContain('VTID-03563');
    expect(opts.systemPrompt).toContain('Claude via Bedrock, always');
    expect(opts.systemPrompt).toContain('Never route a stage at the direct Anthropic API');
    // The default operator prompt must still be present -- memory is
    // appended, not substituted.
    expect(opts.systemPrompt).toContain('helpful AI assistant with access to the Vitana Autopilot system');
  });

  it('appends recalled hits after a caller-supplied custom system instruction too (e.g. ORB memory context)', async () => {
    mockedRecallDevMemory.mockResolvedValueOnce({
      ok: true,
      hits: [
        {
          id: 'h2',
          vtid: null,
          category: 'gotcha',
          title: 'Polly has no Serbian voice',
          content: 'Confirmed against the live API -- no sr/hr/bs/sh voice in any engine.',
          importance: 60,
          source: 'session',
          tags: [],
          created_at: '2026-08-20T00:00:00Z',
          similarity: 0.7,
        },
      ],
    });
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('answer'));

    await processWithGemini({
      text: 'does Serbian TTS work?',
      threadId: 't1',
      systemInstruction: 'CUSTOM ORB MEMORY CONTEXT BLOCK',
    });

    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt).toContain('CUSTOM ORB MEMORY CONTEXT BLOCK');
    expect(opts.systemPrompt).toContain('Polly has no Serbian voice');
    expect(opts.systemPrompt.indexOf('CUSTOM ORB MEMORY CONTEXT BLOCK'))
      .toBeLessThan(opts.systemPrompt.indexOf('Polly has no Serbian voice'));
  });

  it('never appends a memory block when recall returns no hits', async () => {
    mockedRecallDevMemory.mockResolvedValueOnce({ ok: true, hits: [] });
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('answer'));

    await processWithGemini({ text: 'anything', threadId: 't1' });

    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt).not.toContain('Relevant engineering memory');
  });

  it('is fail-open: a recall failure (ok:false) never blocks the operator turn', async () => {
    mockedRecallDevMemory.mockResolvedValueOnce({ ok: false, error: 'embedding_failed: not_configured' });
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('answer despite memory failure'));

    const result = await processWithGemini({ text: 'anything', threadId: 't1' });

    expect(result.reply).toBe('answer despite memory failure');
    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt).not.toContain('Relevant engineering memory');
  });

  it('is fail-open: recallDevMemory throwing never blocks the operator turn', async () => {
    mockedRecallDevMemory.mockRejectedValueOnce(new Error('network blip'));
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('answer despite thrown error'));

    const result = await processWithGemini({ text: 'anything', threadId: 't1' });

    expect(result.reply).toBe('answer despite thrown error');
    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt).not.toContain('Relevant engineering memory');
  });
});

/**
 * VTID-03930 — Operator Console: always-on codebase orientation block.
 *
 * RepoWise/Graphify are local CLI tools with session-scoped indexes
 * (graphify-out/graph.json, .repowise/) that the deployed ECS gateway
 * container cannot invoke at request time — there is no live query path.
 * This pins the practical equivalent instead: a small, hand-curated
 * orientation block, sourced from a real run of both tools plus this
 * repo's own CLAUDE.md services table, appended unconditionally to every
 * Operator turn's system prompt (the same way dev_agent_memory recall
 * already runs unconditionally, VTID-03892) — so a brand-new session gets
 * codebase context immediately, without waiting on a tool call.
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

describe('VTID-03930: Operator codebase orientation block', () => {
  beforeEach(() => {
    mockedCallViaRouter.mockReset();
    mockedRecallDevMemory.mockReset();
    mockedRecallDevMemory.mockResolvedValue({ ok: true, hits: [] });
  });

  it('appends the codebase orientation block to the default operator system prompt', async () => {
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('hi'));

    await processWithGemini({ text: 'what services does this repo have?', threadId: 't1' });

    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt).toContain('Codebase orientation');
    expect(opts.systemPrompt).toContain('Architectural hubs');
    expect(opts.systemPrompt).toContain('dev_search_codebase');
  });

  it('appends the codebase orientation block after a caller-supplied custom system instruction too', async () => {
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('answer'));

    await processWithGemini({
      text: 'anything',
      threadId: 't1',
      systemInstruction: 'CUSTOM ORB MEMORY CONTEXT BLOCK',
    });

    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt).toContain('CUSTOM ORB MEMORY CONTEXT BLOCK');
    expect(opts.systemPrompt).toContain('Codebase orientation');
    expect(opts.systemPrompt.indexOf('CUSTOM ORB MEMORY CONTEXT BLOCK'))
      .toBeLessThan(opts.systemPrompt.indexOf('Codebase orientation'));
  });

  it('appends after the dev_agent_memory block when both are present', async () => {
    mockedRecallDevMemory.mockResolvedValueOnce({
      ok: true,
      hits: [
        {
          id: 'h1', vtid: 'VTID-03563', category: 'decision',
          title: 'Claude via Bedrock, always',
          content: 'Never route a stage at the direct Anthropic API.',
          importance: 90, source: 'backfill', tags: [], created_at: '2026-08-10T00:00:00Z', similarity: 0.81,
        },
      ],
    });
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('answer'));

    await processWithGemini({ text: 'why Bedrock?', threadId: 't1' });

    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt.indexOf('Relevant engineering memory'))
      .toBeLessThan(opts.systemPrompt.indexOf('Codebase orientation'));
  });

  it('is present unconditionally, independent of userRole', async () => {
    mockedCallViaRouter.mockResolvedValueOnce(routerOk('answer'));

    await processWithGemini({ text: 'anything', threadId: 't1', userRole: undefined });

    const [, , opts] = mockedCallViaRouter.mock.calls[0];
    expect(opts.systemPrompt).toContain('Codebase orientation');
  });
});

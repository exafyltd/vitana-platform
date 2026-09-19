/**
 * VTID-04102: found live on staging while testing the Operator Console —
 * a real turn spent its entire output-token budget (4096, exactly the
 * hardcoded cap) with `tool_calls:0` and an empty `content`, and the
 * Command Hub rendered "No response received" with zero diagnostic. `r.ok`
 * only means the provider answered, not that the answer was usable.
 *
 * Two independent parts of the fix:
 *  (1) the plan call's `maxTokens` moved from 4096 to 8000 (the router's
 *      own default), reducing how often this truncation happens at all;
 *  (2) an `ok:true` response with no text AND no tool calls is no longer
 *      returned as a silent `{ reply: '' }` — it throws, so the existing
 *      catch this file already relies on (comment at the `!r.ok` branch:
 *      "the caller has a real fallback path") routes it through
 *      processLocalRouting() instead, the same as any other failure.
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({ searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn(), listOpenPrsBare: jest.fn() }));
jest.mock('../src/services/aws-ecs-readonly', () => ({ describeEcsServices: jest.fn(), ALLOWED_ECS_SERVICES: ['vitana-gateway'], ALLOWED_ECS_TASK_FAMILIES: ['vitana-autopilot-executor'], TASKS_DEFAULT_LIMIT: 10, TASKS_MAX_LIMIT: 25, listEcsTasks: jest.fn() }));
jest.mock('../src/services/dev-agent-memory', () => ({ recallDevMemory: jest.fn(async () => ({ ok: true, hits: [] })), writeDevMemory: jest.fn() }));
jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn(), getRoutingPolicy: jest.fn() }));

import { callViaRouter } from '../src/services/llm-router';
import { processWithGemini } from '../src/services/gemini-operator';

const routerMock = callViaRouter as jest.Mock;

describe('VTID-04102: truncated-empty operator reply falls through to the real fallback', () => {
  beforeEach(() => routerMock.mockReset());

  it('an ok:true response with no text and no tool calls (max_tokens truncation shape) does not surface as an empty reply', async () => {
    // The exact live shape: output_tokens pinned at the (old) 4096 cap,
    // tool_calls empty, content empty — a "successful" call with nothing
    // a user can read.
    routerMock.mockResolvedValue({
      ok: true,
      text: '',
      toolCalls: [],
      provider: 'deepseek',
      model: 'deepseek-flash',
      usage: { inputTokens: 18874, outputTokens: 4096 },
    });

    const res = await processWithGemini({ text: 'zzz-nonmatching-gibberish-04102', threadId: 't-04102-a' });

    expect(res.reply).not.toBe('');
    expect(res.reply.length).toBeGreaterThan(0);
    // Proves it actually fell through the catch → processLocalRouting(),
    // not that some other code path happened to produce non-empty text.
    expect(res.meta?.provider).toBe('local-router');
    expect(res.meta?.fallback_reason).toBe('llm_router_error');
  });

  it('a normal non-empty reply is unaffected', async () => {
    routerMock.mockResolvedValue({ ok: true, text: 'real answer', toolCalls: [], provider: 'deepseek', model: 'deepseek-flash' });
    const res = await processWithGemini({ text: 'hi', threadId: 't-04102-b' });
    expect(res.reply).toBe('real answer');
    expect(res.meta?.fallback_reason).toBeUndefined();
  });

  it('the plan call requests an 8000-token budget, not the old 4096 cap', async () => {
    routerMock.mockResolvedValue({ ok: true, text: 'ok', toolCalls: [], provider: 'deepseek', model: 'deepseek-flash' });
    await processWithGemini({ text: 'hi', threadId: 't-04102-c' });
    expect(routerMock.mock.calls[0][2]).toMatchObject({ maxTokens: 8000 });
  });
});

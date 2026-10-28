/**
 * VTID-04794: a reply cut off by the output cap with no text and no tool call
 * is a failure, so the stage's fallback runs.
 *
 * Live on staging (2026-10-01): the Dev Autopilot planner runs on DeepSeek
 * Flash (VTID-04593). On about half of all plans DeepSeek spent the whole
 * 8,000-token budget on hidden reasoning and returned empty `content` with
 * finish_reason=length. The router reported that as ok, the planner saw no
 * text and failed with "Plan generation failed after ~35s: unknown error",
 * and the stage's Bedrock fallback never ran.
 *
 * Harness: same as vtid-03820-llm-router-override.test.ts.
 */
import { LLM_SAFE_DEFAULTS } from '../src/constants/llm-defaults';

describe('VTID-04794 empty truncated replies fall back', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.resetModules();
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    process.env.ANTHROPIC_API_KEY = 'an-test';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });

  const deepseekReply = (content: string, finish: string, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({
      choices: [{ finish_reason: finish, message: { content, ...extra } }],
      usage: { prompt_tokens: 6415, completion_tokens: 8000 },
    }), { status: 200 });

  function stub(withFallback: boolean, deepseek: () => Response) {
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      planner: {
        primary_provider: 'deepseek',
        primary_model: 'deepseek-flash',
        fallback_provider: withFallback ? 'anthropic' : null,
        fallback_model: withFallback ? 'claude-sonnet-4-6' : null,
      },
    };
    const calls: string[] = [];
    fetchMock.mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/rest/v1/llm_routing_policy')) {
        return new Response(JSON.stringify([{ policy }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/rest/v1/')) return new Response('', { status: 201 });
      if (url.includes('api.deepseek.com')) { calls.push('deepseek'); return deepseek(); }
      if (url.includes('api.anthropic.com')) {
        calls.push('anthropic');
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: '## Plan from the fallback' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    return calls;
  }

  async function plan() {
    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    return callViaRouter('planner', 'write a plan', { service: 'test', maxTokens: 8000 });
  }

  it('an empty reply cut off by the cap falls back to the stage fallback', async () => {
    const calls = stub(true, () => deepseekReply('', 'length'));
    const r = await plan();
    expect(calls).toEqual(['deepseek', 'anthropic']);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('## Plan from the fallback');
    expect(r.fallbackUsed).toBe(true);
  });

  it('with no fallback configured it fails with a named reason, never ok with no text', async () => {
    stub(false, () => deepseekReply('   ', 'length'));
    const r = await plan();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/deepseek\/deepseek-flash returned no text: output cap reached/);
  });

  it('a truncated reply WITH text is still returned, marked truncated', async () => {
    const calls = stub(true, () => deepseekReply('## Partial plan', 'length'));
    const r = await plan();
    expect(calls).toEqual(['deepseek']);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('## Partial plan');
    expect(r.truncated).toBe(true);
  });

  it('a truncated reply carrying a tool call is still returned', async () => {
    const calls = stub(true, () => deepseekReply('', 'length', {
      tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    }));
    const r = await plan();
    expect(calls).toEqual(['deepseek']);
    expect(r.ok).toBe(true);
    expect(r.toolCalls?.[0]?.name).toBe('read_file');
  });

  it('an empty reply that finished normally is unchanged (ok)', async () => {
    const calls = stub(true, () => deepseekReply('', 'stop'));
    const r = await plan();
    expect(calls).toEqual(['deepseek']);
    expect(r.ok).toBe(true);
  });
});

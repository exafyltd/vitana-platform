/**
 * VTID-03820: callViaRouter() per-call provider/model override.
 *
 * The DeepSeek-powered execution on-ramp needs to force a SPECIFIC call
 * onto DeepSeek without touching the DB-backed llm_routing_policy stage
 * every other caller relies on. providerOverride/modelOverride replace
 * PRIMARY only — the stage's own policy-configured fallback still applies
 * on failure, and any caller that omits both fields is byte-for-byte
 * unaffected (mutation-verified below).
 *
 * Same test harness pattern as llm-router.test.ts (global fetch mock,
 * Supabase policy/telemetry stubs, _resetPolicyCacheForTests).
 */

import { LLM_SAFE_DEFAULTS } from '../src/constants/llm-defaults';

describe('callViaRouter provider/model override (VTID-03820)', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });

  function setupSupabaseAndTelemetryStubs(activePolicy: any, providerHandler: (url: string, init: any) => any) {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
    fetchMock.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/rest/v1/llm_routing_policy')) {
        return new Response(JSON.stringify([{ policy: activePolicy }]), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/rest/v1/oasis_events') || url.includes('/rest/v1/llm_telemetry')) {
        return new Response('', { status: 201 });
      }
      return providerHandler(url, init);
    });
  }

  test('providerOverride/modelOverride replace the policy PRIMARY for this call only', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    // Policy for 'worker' points at anthropic — the on-ramp's job is to
    // NOT use that, without changing the stored policy.
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      worker: {
        primary_provider: 'anthropic',
        primary_model: 'claude-opus-4-7',
        fallback_provider: null,
        fallback_model: null,
      },
    };
    setupSupabaseAndTelemetryStubs(policy, async (url) => {
      if (url.includes('api.deepseek.com')) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'DEEPSEEK_OVERRIDE_OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url (override should never hit anthropic): ${url}`);
    });

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('worker', 'do the thing', {
      service: 'test',
      providerOverride: 'deepseek',
      modelOverride: 'deepseek-flash',
    });

    expect(r.ok).toBe(true);
    expect(r.text).toBe('DEEPSEEK_OVERRIDE_OK');
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-flash');
  });

  test('a call with no override still uses the policy PRIMARY unchanged (existing callers unaffected)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      worker: {
        primary_provider: 'anthropic',
        primary_model: 'claude-opus-4-7',
        fallback_provider: null,
        fallback_model: null,
      },
    };
    setupSupabaseAndTelemetryStubs(policy, async (url) => {
      if (url.includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'POLICY_DEFAULT_OK' }], usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('worker', 'do the thing', { service: 'test' });

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('claude-opus-4-7');
  });

  test('a LONE override field (provider without model) is ignored — policy PRIMARY still used', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      worker: {
        primary_provider: 'anthropic',
        primary_model: 'claude-opus-4-7',
        fallback_provider: null,
        fallback_model: null,
      },
    };
    setupSupabaseAndTelemetryStubs(policy, async (url) => {
      if (url.includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'POLICY_DEFAULT_OK' }], usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url (ambiguous lone override must not reach deepseek): ${url}`);
    });

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('worker', 'do the thing', {
      service: 'test',
      providerOverride: 'deepseek', // modelOverride deliberately omitted
    });

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('claude-opus-4-7');
  });

  test('on override failure, the STAGE\'S OWN policy fallback still applies (resilience preserved)', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      worker: {
        primary_provider: 'anthropic', // irrelevant — overridden below
        primary_model: 'claude-opus-4-7',
        fallback_provider: 'anthropic',
        fallback_model: 'claude-opus-4-7',
      },
    };
    setupSupabaseAndTelemetryStubs(policy, async (url) => {
      if (url.includes('api.deepseek.com')) {
        return new Response('rate limited', { status: 429 });
      }
      if (url.includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'FALLBACK_AFTER_OVERRIDE_FAIL' }], usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('worker', 'do the thing', {
      service: 'test',
      providerOverride: 'deepseek',
      modelOverride: 'deepseek-flash',
    });

    expect(r.ok).toBe(true);
    expect(r.text).toBe('FALLBACK_AFTER_OVERRIDE_FAIL');
    expect(r.provider).toBe('anthropic');
    expect(r.fallbackUsed).toBe(true);
  });
});

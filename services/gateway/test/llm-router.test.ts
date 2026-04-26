/**
 * BOOTSTRAP-LLM-ROUTER unit tests.
 *
 * Verifies the router:
 *   1. Loads the active policy and dispatches to the configured primary provider.
 *   2. Picks the right adapter per provider id.
 *   3. Falls back to fallback_provider on primary failure when allowFallback.
 *   4. Asserts flagship-by-default — every safe-default primary/fallback is
 *      its provider's flagship model.
 *
 * Network calls are stubbed via global fetch mock so tests run offline.
 */

import {
  LLM_SAFE_DEFAULTS,
  PROVIDER_FLAGSHIPS,
  VALID_STAGES,
  type LLMStage,
} from '../src/constants/llm-defaults';

describe('BOOTSTRAP-LLM-ROUTER constants', () => {
  describe('flagship-only safe defaults', () => {
    test('every primary model in LLM_SAFE_DEFAULTS is its provider flagship', () => {
      for (const stage of VALID_STAGES) {
        const cfg = LLM_SAFE_DEFAULTS[stage];
        const flagship = PROVIDER_FLAGSHIPS[cfg.primary_provider];
        expect(cfg.primary_model).toBe(flagship);
      }
    });

    test('every fallback model in LLM_SAFE_DEFAULTS is its provider flagship (when set)', () => {
      for (const stage of VALID_STAGES) {
        const cfg = LLM_SAFE_DEFAULTS[stage];
        if (cfg.fallback_provider && cfg.fallback_model) {
          const flagship = PROVIDER_FLAGSHIPS[cfg.fallback_provider];
          expect(cfg.fallback_model).toBe(flagship);
        }
      }
    });

    test('all 8 stages have a primary and fallback configured', () => {
      const expectedStages: LLMStage[] = [
        'planner', 'worker', 'validator', 'operator',
        'memory', 'triage', 'vision', 'classifier',
      ];
      for (const stage of expectedStages) {
        const cfg = LLM_SAFE_DEFAULTS[stage];
        expect(cfg.primary_provider).toBeTruthy();
        expect(cfg.primary_model).toBeTruthy();
      }
    });

    test('worker stage primary is claude_subscription (free path)', () => {
      expect(LLM_SAFE_DEFAULTS.worker.primary_provider).toBe('claude_subscription');
      expect(LLM_SAFE_DEFAULTS.worker.fallback_provider).toBe('vertex');
    });

    test('classifier stage primary is deepseek (highest-volume cheapest path)', () => {
      expect(LLM_SAFE_DEFAULTS.classifier.primary_provider).toBe('deepseek');
      expect(LLM_SAFE_DEFAULTS.classifier.primary_model).toBe('deepseek-reasoner');
    });

    test('vision stage primary is vertex with gemini-3.1-pro', () => {
      expect(LLM_SAFE_DEFAULTS.vision.primary_provider).toBe('vertex');
      expect(LLM_SAFE_DEFAULTS.vision.primary_model).toBe('gemini-3.1-pro');
    });
  });

  describe('PROVIDER_FLAGSHIPS table', () => {
    test('contains an entry for every supported provider', () => {
      expect(PROVIDER_FLAGSHIPS.anthropic).toBe('claude-opus-4-7');
      expect(PROVIDER_FLAGSHIPS.openai).toBe('gpt-5');
      expect(PROVIDER_FLAGSHIPS.vertex).toBe('gemini-3.1-pro');
      expect(PROVIDER_FLAGSHIPS.deepseek).toBe('deepseek-reasoner');
      expect(PROVIDER_FLAGSHIPS.claude_subscription).toBe('claude-opus-4-7');
    });
  });
});

describe('callViaRouter', () => {
  // Mock fetch globally so adapters don't hit real APIs.
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
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GOOGLE_GEMINI_API_KEY;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  /**
   * Stub the Supabase REST polling that getActivePolicy() / startLLMCall() do.
   * Returns:
   *   - For llm_routing_policy GET: a single row with the desired policy
   *   - For oasis_events POST: 201 (telemetry write succeeds quietly)
   *   - Anything else: routed to the per-provider mock the test set up
   */
  function setupSupabaseAndTelemetryStubs(activePolicy: any, providerHandler: (url: string, init: any) => any) {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
    fetchMock.mockImplementation(async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      // Supabase REST: policy fetch
      if (url.includes('/rest/v1/llm_routing_policy')) {
        return new Response(JSON.stringify([{ policy: activePolicy }]), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      // Supabase REST: oasis events / telemetry writes
      if (url.includes('/rest/v1/oasis_events') || url.includes('/rest/v1/llm_telemetry')) {
        return new Response('', { status: 201 });
      }
      // Provider call
      return providerHandler(url, init);
    });
  }

  test('routes to anthropic when policy primary_provider=anthropic and credentials are set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      triage: {
        primary_provider: 'anthropic',
        primary_model: 'claude-opus-4-7',
        fallback_provider: null,
        fallback_model: null,
      },
    };
    setupSupabaseAndTelemetryStubs(policy, async (url) => {
      if (url.includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'ANTHROPIC_OK' }],
            usage: { input_tokens: 5, output_tokens: 3 },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('triage', 'hello', { service: 'test' });

    expect(r.ok).toBe(true);
    expect(r.text).toBe('ANTHROPIC_OK');
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  test('routes to deepseek when policy primary_provider=deepseek and credentials are set', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      classifier: {
        primary_provider: 'deepseek',
        primary_model: 'deepseek-reasoner',
        fallback_provider: null,
        fallback_model: null,
      },
    };
    setupSupabaseAndTelemetryStubs(policy, async (url) => {
      if (url.includes('api.deepseek.com')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'DEEPSEEK_OK' } }],
            usage: { prompt_tokens: 7, completion_tokens: 4 },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('classifier', 'classify this', { service: 'test' });

    expect(r.ok).toBe(true);
    expect(r.text).toBe('DEEPSEEK_OK');
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-reasoner');
  });

  test('falls back to fallback_provider when primary returns non-2xx', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      triage: {
        primary_provider: 'deepseek',
        primary_model: 'deepseek-reasoner',
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
          JSON.stringify({
            content: [{ type: 'text', text: 'FALLBACK_OK' }],
            usage: { input_tokens: 1, output_tokens: 2 },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('triage', 'go', { service: 'test' });

    expect(r.ok).toBe(true);
    expect(r.text).toBe('FALLBACK_OK');
    expect(r.fallbackUsed).toBe(true);
    expect(r.provider).toBe('anthropic');
  });

  test('returns ok=false when both providers fail', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      triage: {
        primary_provider: 'deepseek',
        primary_model: 'deepseek-reasoner',
        fallback_provider: 'anthropic',
        fallback_model: 'claude-opus-4-7',
      },
    };
    setupSupabaseAndTelemetryStubs(policy, async () => new Response('boom', { status: 500 }));

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('triage', 'go', { service: 'test' });

    expect(r.ok).toBe(false);
    expect(r.fallbackUsed).toBe(true);
    expect(r.error).toContain('both providers failed');
  });

  test('returns ok=false when primary provider has no credentials AND no fallback', async () => {
    // No ANTHROPIC_API_KEY set
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      triage: {
        primary_provider: 'anthropic',
        primary_model: 'claude-opus-4-7',
        fallback_provider: null,
        fallback_model: null,
      },
    };
    setupSupabaseAndTelemetryStubs(policy, async () => {
      throw new Error('should not call any provider');
    });

    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();
    const r = await callViaRouter('triage', 'go', { service: 'test' });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('no credentials');
    expect(r.provider).toBe('anthropic');
  });
});

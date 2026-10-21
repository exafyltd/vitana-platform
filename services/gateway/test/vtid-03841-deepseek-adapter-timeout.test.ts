/**
 * VTID-03841: the DeepSeek adapter must bound its request.
 *
 * Observed on staging 2026-09-13: the first operator on-ramp execution
 * (VTID-03829, exec beeb2c55) started its worker LLM call on deepseek-flash
 * at 07:40:04 and produced neither `llm.call.completed` nor a failure for
 * 20 minutes, until the stuck-running watchdog reclaimed the execution.
 * The adapter issued a plain fetch with no AbortSignal, so nothing could
 * ever return — and the router's `allowFallback` never had a failure to
 * fall back from.
 *
 * Same harness pattern as vtid-03820-llm-router-override.test.ts (global
 * fetch mock, Supabase policy/telemetry stubs, _resetPolicyCacheForTests).
 * The stalled request is simulated the way undici behaves: the promise
 * settles only when the AbortSignal the adapter passed in fires.
 */

import { LLM_SAFE_DEFAULTS } from '../src/constants/llm-defaults';

describe('DeepSeek adapter request timeout (VTID-03841)', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_TIMEOUT_MS;
    delete process.env.ANTHROPIC_API_KEY;
  });

  function stubs(activePolicy: any, providerHandler: (url: string, init: any) => any) {
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

  /** A request that never completes on its own — only the signal ends it. */
  function stalledUntilAborted(init: any): Promise<Response> {
    const signal: AbortSignal | undefined = init?.signal;
    return new Promise((_resolve, reject) => {
      if (!signal) return; // hangs forever — exactly the old defect
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  const deepseekOnlyPolicy = {
    ...LLM_SAFE_DEFAULTS,
    worker: {
      primary_provider: 'deepseek',
      primary_model: 'deepseek-flash',
      fallback_provider: null,
      fallback_model: null,
    },
  };

  test('resolveDeepseekTimeoutMs: env override, and a 10-minute default for unset/invalid values', async () => {
    const { resolveDeepseekTimeoutMs } = await import('../src/services/llm-router');
    expect(resolveDeepseekTimeoutMs(undefined)).toBe(600_000);
    expect(resolveDeepseekTimeoutMs('')).toBe(600_000);
    expect(resolveDeepseekTimeoutMs('abc')).toBe(600_000);
    expect(resolveDeepseekTimeoutMs('0')).toBe(600_000);
    expect(resolveDeepseekTimeoutMs('-5')).toBe(600_000);
    expect(resolveDeepseekTimeoutMs('45000')).toBe(45_000);
    expect(resolveDeepseekTimeoutMs('1500.9')).toBe(1_500);
  });

  test('every DeepSeek request carries an AbortSignal', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    let seenInit: any;
    stubs(deepseekOnlyPolicy, async (url, init) => {
      seenInit = init;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    });
    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();

    const r = await callViaRouter('worker', 'hello', { service: 'test' });

    expect(r.ok).toBe(true);
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(seenInit.signal.aborted).toBe(false);
  });

  test('a stalled request fails within the timeout with a named error, instead of hanging', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    process.env.DEEPSEEK_TIMEOUT_MS = '60';
    stubs(deepseekOnlyPolicy, (_url, init) => stalledUntilAborted(init));
    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();

    const started = Date.now();
    const r = await callViaRouter('worker', 'hello', { service: 'test', allowFallback: false });
    const elapsed = Date.now() - started;

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/DeepSeek request timed out after 60ms \(DEEPSEEK_TIMEOUT_MS\)/);
    // Generous bound — the point is "milliseconds, not 20 minutes".
    expect(elapsed).toBeLessThan(5_000);
  });

  test('the timeout is what lets the policy fallback engage (the stall used to make fallback unreachable)', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.DEEPSEEK_TIMEOUT_MS = '60';
    const policy = {
      ...LLM_SAFE_DEFAULTS,
      worker: {
        primary_provider: 'deepseek',
        primary_model: 'deepseek-flash',
        fallback_provider: 'anthropic',
        fallback_model: 'claude-sonnet-4-6',
      },
    };
    stubs(policy, (url, init) => {
      if (url.includes('api.deepseek.com')) return stalledUntilAborted(init);
      if (url.includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'FALLBACK_OK' }], usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const { callViaRouter, _resetPolicyCacheForTests } = await import('../src/services/llm-router');
    _resetPolicyCacheForTests();

    const r = await callViaRouter('worker', 'hello', { service: 'test', allowFallback: true });

    expect(r.ok).toBe(true);
    expect(r.text).toBe('FALLBACK_OK');
    expect(r.provider).toBe('anthropic');
  });

  test('mutation check: without a signal the same stalled request would never settle', async () => {
    // Documents the exact defect shape: a fetch that ignores no signal
    // hangs forever. We race it against a short timer to prove it.
    const hang = stalledUntilAborted({});
    const winner = await Promise.race([
      hang.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-hanging'), 100)),
    ]);
    expect(winner).toBe('still-hanging');
  });
});

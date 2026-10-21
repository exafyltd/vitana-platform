/**
 * VTID-04546 — LLM router telemetry must not block the call path.
 *
 * callViaRouter used to await the llm.call.started oasis_events insert before
 * the provider call and the llm.call.completed insert after it. A slow or
 * hanging insert delayed every routed LLM call (voice cascade included).
 *
 * Pins:
 *   1. A hanging started/completed insert does not delay callViaRouter's result.
 *   2. Both events are still emitted, with the same payload shape as before,
 *      linked by the client-side trace_id.
 *   3. The completed insert is issued only after the started insert settles.
 *   4. A telemetry insert that rejects/throws never reaches the caller.
 *   5. The failed path is non-blocking too.
 */

import { LLM_SAFE_DEFAULTS } from '../src/constants/llm-defaults';

type Emit = { type: string; vtid: string; source: string; status: string; message: string; payload: any };

const emitted: Emit[] = [];
let emitImpl: (e: Emit) => Promise<unknown> = async () => ({ ok: true });

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn((e: Emit) => {
    emitted.push(e);
    return emitImpl(e);
  }),
}));

const deepseekOnlyPolicy = {
  ...LLM_SAFE_DEFAULTS,
  worker: {
    primary_provider: 'deepseek',
    primary_model: 'deepseek-flash',
    fallback_provider: null,
    fallback_model: null,
  },
};

const originalFetch = global.fetch;

function stubFetch(providerStatus = 200) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE = 'test-key';
  process.env.DEEPSEEK_API_KEY = 'ds-test';
  global.fetch = jest.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/rest/v1/llm_routing_policy')) {
      return new Response(JSON.stringify([{ policy: deepseekOnlyPolicy }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('api.deepseek.com')) {
      if (providerStatus !== 200) return new Response('boom', { status: providerStatus });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK_TEXT' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
        { status: 200 },
      );
    }
    return new Response('', { status: 201 });
  }) as unknown as typeof fetch;
}

async function loadRouter() {
  const mod = await import('../src/services/llm-router');
  mod._resetPolicyCacheForTests();
  return mod;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  emitted.length = 0;
  emitImpl = async () => ({ ok: true });
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.DEEPSEEK_API_KEY;
});

describe('VTID-04546 callViaRouter telemetry is fire-and-forget', () => {
  test('a hanging telemetry insert does not delay the result', async () => {
    stubFetch();
    // Every insert hangs forever.
    emitImpl = () => new Promise(() => {});
    const { callViaRouter } = await loadRouter();

    const r = await Promise.race([
      callViaRouter('worker', 'hello', { service: 'svc-a', vtid: 'VTID-99999' }),
      new Promise((resolve) => setTimeout(() => resolve('TIMED_OUT'), 2000)),
    ]);

    expect(r).not.toBe('TIMED_OUT');
    expect((r as any).ok).toBe(true);
    expect((r as any).text).toBe('OK_TEXT');
    expect((r as any).usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    // started was issued; completed is held behind the (hanging) started insert.
    expect(emitted.map((e) => e.type)).toEqual(['llm.call.started']);
  });

  test('both events are emitted with the same payloads, linked by trace_id, started first', async () => {
    stubFetch();
    const order: string[] = [];
    let releaseStarted!: () => void;
    emitImpl = (e) => {
      order.push(`issue:${e.type}`);
      if (e.type === 'llm.call.started') {
        return new Promise((resolve) => {
          releaseStarted = () => {
            order.push('settle:llm.call.started');
            resolve({ ok: true });
          };
        });
      }
      return Promise.resolve({ ok: true });
    };
    const { callViaRouter } = await loadRouter();

    const r = await callViaRouter('worker', 'hello', { service: 'svc-b', vtid: 'VTID-88888' });
    expect(r.ok).toBe(true);
    await flush();
    // completed must not be issued while started is still in flight
    expect(order).toEqual(['issue:llm.call.started']);

    releaseStarted();
    await flush();
    await flush();
    expect(order).toEqual(['issue:llm.call.started', 'settle:llm.call.started', 'issue:llm.call.completed']);

    const [started, completed] = emitted;
    expect(started).toMatchObject({
      vtid: 'VTID-88888',
      type: 'llm.call.started',
      source: 'svc-b',
      status: 'info',
      message: 'LLM call started: worker using deepseek/deepseek-flash',
    });
    expect(started.payload).toMatchObject({
      stage: 'worker',
      provider: 'deepseek',
      model: 'deepseek-flash',
      fallback_used: false,
      latency_ms: 0,
    });
    expect(typeof started.payload.prompt_hash).toBe('string');
    expect(started.payload.otel).toBeTruthy();

    expect(completed).toMatchObject({ vtid: 'VTID-88888', type: 'llm.call.completed', source: 'svc-b', status: 'success' });
    expect(completed.message).toMatch(/^LLM call completed: worker in \d+ms$/);
    expect(completed.payload).toMatchObject({
      stage: 'worker',
      provider: 'deepseek',
      model: 'deepseek-flash',
      input_tokens: 11,
      output_tokens: 7,
      fallback_used: false,
    });
    expect(completed.payload.trace_id).toBe(started.payload.trace_id);
    expect(completed.payload.prompt_hash).toBe(started.payload.prompt_hash);
  });

  test('cost estimate on the completed event is identical to the awaited builder', async () => {
    stubFetch();
    const { callViaRouter } = await loadRouter();
    await callViaRouter('worker', 'hello', { service: 'svc-c' });
    await flush();
    await flush();
    const completed = emitted.find((e) => e.type === 'llm.call.completed')!;
    const { estimateCost } = await import('../src/constants/llm-defaults');
    expect(completed.payload.cost_estimate_usd).toBe(estimateCost('deepseek-flash', 11, 7));
  });

  test('a telemetry insert that rejects or throws never reaches the caller', async () => {
    stubFetch();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    emitImpl = () => Promise.reject(new Error('supabase down'));
    const { callViaRouter } = await loadRouter();
    const r = await callViaRouter('worker', 'hello', { service: 'svc-d' });
    expect(r.ok).toBe(true);
    await flush();
    await flush();
    expect(emitted.map((e) => e.type)).toEqual(['llm.call.started', 'llm.call.completed']);

    emitted.length = 0;
    emitImpl = () => {
      throw new Error('sync throw');
    };
    const r2 = await callViaRouter('worker', 'hello', { service: 'svc-d' });
    expect(r2.ok).toBe(true);
    await flush();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('the failed path is non-blocking and still emits llm.call.failed after started', async () => {
    stubFetch(500);
    let releaseStarted!: () => void;
    emitImpl = (e) =>
      e.type === 'llm.call.started'
        ? new Promise((resolve) => {
            releaseStarted = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true });
    const { callViaRouter } = await loadRouter();
    const r = await callViaRouter('worker', 'hello', { service: 'svc-e', allowFallback: false });
    expect(r.ok).toBe(false);
    await flush();
    expect(emitted.map((e) => e.type)).toEqual(['llm.call.started']);
    releaseStarted();
    await flush();
    await flush();
    expect(emitted.map((e) => e.type)).toEqual(['llm.call.started', 'llm.call.failed']);
    expect(emitted[1].payload.error_code).toBe('provider_error');
    expect(emitted[1].payload.trace_id).toBe(emitted[0].payload.trace_id);
  });
});

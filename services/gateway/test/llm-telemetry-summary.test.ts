/**
 * VTID-03599: LLM call usage visibility in Command Hub.
 *
 * Direct follow-up to VTID-03579/03563: routing tables and per-call
 * telemetry events already existed, but `queryLLMTelemetry()` only ever
 * returned a raw, paginated event list -- no aggregation. The only way to
 * answer "how many LLM calls today, and who made them" was to read events
 * one at a time, which is exactly how a 268-call credit-balance leak and a
 * 990-call runaway planner loop both went unnoticed until someone read a
 * bill. These tests pin the new summary service function and its route.
 */

const ORIGINAL_ENV = { ...process.env };

describe('getLLMTelemetrySummary (VTID-03599)', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key';
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  test('calls the llm_telemetry_summary RPC with p_hours and returns the summary', async () => {
    const mockSummary = {
      window_hours: 24,
      since: '2026-08-10T20:00:00+00:00',
      generated_at: '2026-08-11T20:00:00+00:00',
      total_started: 413,
      total_completed: 381,
      total_failed: 35,
      total_fallback: 339,
      total_cost_usd: 7.37,
      non_bedrock_google_or_anthropic_calls: 46,
      by_provider: [{ provider: 'deepseek', calls: 363, completed: 339, failed: 27, fallback: 339, cost_usd: 6.91 }],
      by_service: [{ service: 'dev-autopilot-planning', calls: 409, failed: 35 }],
      by_stage: [{ stage: 'planner', calls: 409, failed: 35 }],
      hourly: [{ hour: '2026-08-11T19:00:00+00:00', provider: 'bedrock', calls: 4 }],
    };

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSummary,
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { getLLMTelemetrySummary } = await import('../src/services/llm-telemetry-service');
    const result = await getLLMTelemetrySummary(24);

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual(mockSummary);

    // Must hit the RPC endpoint (not the raw oasis_events table), with the
    // window forwarded as p_hours -- a caller passing a window that never
    // reaches the query would silently always report the same 24h default.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/rest/v1/rpc/llm_telemetry_summary');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ p_hours: 24 });
  });

  test('defaults to a 24-hour window when no argument is given', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ window_hours: 24 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { getLLMTelemetrySummary } = await import('../src/services/llm-telemetry-service');
    await getLLMTelemetrySummary();

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ p_hours: 24 });
  });

  test('reports ok:false without throwing when Supabase credentials are missing', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;

    const { getLLMTelemetrySummary } = await import('../src/services/llm-telemetry-service');
    const result = await getLLMTelemetrySummary(24);

    expect(result.ok).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.error).toMatch(/Supabase credentials/i);
  });

  test('reports ok:false on a non-2xx RPC response rather than throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }) as unknown as typeof fetch;

    const { getLLMTelemetrySummary } = await import('../src/services/llm-telemetry-service');
    const result = await getLLMTelemetrySummary(24);

    expect(result.ok).toBe(false);
    expect(result.summary).toBeNull();
  });

  test('reports ok:false when fetch itself throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const { getLLMTelemetrySummary } = await import('../src/services/llm-telemetry-service');
    const result = await getLLMTelemetrySummary(24);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('network down');
  });
});

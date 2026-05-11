/**
 * PR-B (VTID-02914): pre-probe gate.
 *
 * The gate prevents `processFailingService` from allocating a VTID + writing
 * a self_healing_log row when the failing endpoint has already recovered
 * between the scanner snapshot and our processing of it. The contract is:
 *
 *   1. `probeEndpoint` honors voice synthetic endpoints (no HTTP fetch).
 *   2. `probeEndpoint` returns latency, status, and content-type.
 *   3. `isJsonHealthy` is strict: 2xx alone is not enough, the response
 *      must also be application/json (an SPA catch-all returning index.html
 *      with HTTP 200 must NOT count as healed).
 *   4. `processFailingService` short-circuits with action='recovered_externally'
 *      when the pre-probe passes, and never calls `beginDiagnosis` /
 *      `injectIntoAutopilotPipeline`.
 */

import { probeEndpoint, isJsonHealthy } from '../src/services/self-healing-probe';

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  jest.resetModules();
});

describe('probeEndpoint (shared helper)', () => {
  it('returns not-healthy with no fetch for voice synthetic endpoints', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await probeEndpoint('voice-error://no_audio_in');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.healthy).toBe(false);
    expect(result.http_status).toBeNull();
    expect(result.latency_ms).toBe(0);
  });

  it('returns healthy=true with status + content-type on 200 JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'application/json; charset=utf-8' : null) },
    } as unknown as Response) as unknown as typeof fetch;

    const result = await probeEndpoint('/api/v1/availability/health');

    expect(result.healthy).toBe(true);
    expect(result.http_status).toBe(200);
    expect(result.content_type).toContain('application/json');
    expect(typeof result.latency_ms).toBe('number');
  });

  it('returns not-healthy when fetch throws (timeout / network)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('AbortError')) as unknown as typeof fetch;

    const result = await probeEndpoint('/api/v1/availability/health', { timeoutMs: 50 });

    expect(result.healthy).toBe(false);
    expect(result.http_status).toBeNull();
  });

  it('returns healthy=false on 503', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => 'application/json' },
    } as unknown as Response) as unknown as typeof fetch;

    const result = await probeEndpoint('/api/v1/availability/health');

    expect(result.healthy).toBe(false);
    expect(result.http_status).toBe(503);
  });

  it('uses absolute URLs verbatim instead of prepending gateway base', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
    } as unknown as Response);
    global.fetch = fetchSpy as unknown as typeof fetch;

    await probeEndpoint('https://example.com/health');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as any[])[0]).toBe('https://example.com/health');
  });
});

describe('isJsonHealthy', () => {
  it('accepts 200 + application/json as healed', () => {
    expect(
      isJsonHealthy({ healthy: true, http_status: 200, latency_ms: 50, content_type: 'application/json' }),
    ).toBe(true);
  });

  it('rejects 200 + text/html (SPA catch-all)', () => {
    expect(
      isJsonHealthy({ healthy: true, http_status: 200, latency_ms: 50, content_type: 'text/html; charset=utf-8' }),
    ).toBe(false);
  });

  it('rejects 503 even with JSON content-type', () => {
    expect(
      isJsonHealthy({ healthy: false, http_status: 503, latency_ms: 50, content_type: 'application/json' }),
    ).toBe(false);
  });

  it('rejects when content-type is missing', () => {
    expect(isJsonHealthy({ healthy: true, http_status: 200, latency_ms: 50 })).toBe(false);
  });

  it('accepts content-types like application/json; charset=utf-8', () => {
    expect(
      isJsonHealthy({ healthy: true, http_status: 200, latency_ms: 50, content_type: 'Application/JSON; charset=utf-8' }),
    ).toBe(true);
  });
});

describe('processFailingService — pre-probe gate', () => {
  const baseFailure = {
    name: 'Availability Health',
    endpoint: '/api/v1/availability/health',
    status: 'down' as const,
    http_status: 503,
    response_body: '',
    response_time_ms: 100,
    error_message: 'snapshot showed 503',
  };

  function loadRouteWithMocks() {
    // Reset module registry so mocks take effect on every reload.
    jest.resetModules();
    jest.doMock('../src/services/oasis-event-service', () => ({
      emitOasisEvent: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../src/services/self-healing-diagnosis-service', () => ({
      beginDiagnosis: jest.fn(),
    }));
    jest.doMock('../src/services/self-healing-spec-service', () => ({
      generateAndStoreFixSpec: jest.fn(),
    }));
    jest.doMock('../src/services/self-healing-injector-service', () => ({
      injectIntoAutopilotPipeline: jest.fn(),
    }));
    jest.doMock('../src/services/self-healing-snapshot-service', () => ({
      captureHealthSnapshot: jest.fn(),
      verifyFixWithBlastRadiusCheck: jest.fn(),
      executeRollback: jest.fn(),
      notifyGChat: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../src/services/self-healing-triage-service', () => ({
      spawnTriageAgent: jest.fn(),
    }));

    // Bypass the dedup/circuit-breaker check (queries Supabase) by
    // returning proceed=true on every call.
    const route = require('../src/routes/self-healing');
    return route;
  }

  it('short-circuits with recovered_externally when pre-probe is JSON-healthy', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      // Supabase dedup queries respond with empty arrays (no active VTID, 0 attempts)
      if (url.includes('/rest/v1/vtid_ledger')) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => null },
          json: () => Promise.resolve([]),
        });
      }
      if (url.includes('/rest/v1/self_healing_log')) {
        return Promise.resolve({
          ok: true,
          headers: { get: (k: string) => (k === 'content-range' ? '0-0/0' : null) },
          json: () => Promise.resolve([]),
        });
      }
      // Pre-probe call → healthy
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === 'content-type' ? 'application/json' : null) },
      });
    }) as unknown as typeof fetch;

    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc-role';

    const route = loadRouteWithMocks();
    const beginDiagnosis = require('../src/services/self-healing-diagnosis-service').beginDiagnosis;
    const inject = require('../src/services/self-healing-injector-service').injectIntoAutopilotPipeline;

    const result = await route.processFailingService(baseFailure, /* AUTO_FIX_SIMPLE */ 3);

    expect(result.action).toBe('recovered_externally');
    expect(result.vtid).toBeUndefined();
    expect(beginDiagnosis).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });

  it('skips the pre-probe entirely for voice synthetic endpoints', async () => {
    let probeCalled = false;
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/rest/v1/vtid_ledger')) {
        return Promise.resolve({ ok: true, headers: { get: () => null }, json: () => Promise.resolve([]) });
      }
      if (url.includes('/rest/v1/self_healing_log')) {
        return Promise.resolve({
          ok: true,
          headers: { get: (k: string) => (k === 'content-range' ? '0-0/0' : null) },
          json: () => Promise.resolve([]),
        });
      }
      // Any non-supabase fetch == probe call
      probeCalled = true;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
      });
    }) as unknown as typeof fetch;

    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc-role';

    const route = loadRouteWithMocks();
    require('../src/services/self-healing-diagnosis-service').beginDiagnosis.mockResolvedValue({
      vtid: 'VTID-99999',
      diagnosis: { service_name: 'voice', failure_class: 'no_audio_in', confidence: 0.9, root_cause: 'r', auto_fixable: true, files_to_modify: [], files_read: [], evidence: [] },
    });
    require('../src/services/self-healing-spec-service').generateAndStoreFixSpec.mockResolvedValue({
      spec: 'spec',
      spec_hash: 'hash',
      quality_score: 0.9,
    });
    require('../src/services/self-healing-injector-service').injectIntoAutopilotPipeline.mockResolvedValue({
      success: true,
    });

    await route.processFailingService(
      { ...baseFailure, endpoint: 'voice-error://no_audio_in' },
      /* AUTO_FIX_SIMPLE */ 3,
    );

    expect(probeCalled).toBe(false); // pre-probe must not fire for voice
  });
});

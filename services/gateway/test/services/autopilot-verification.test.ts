// VTID-01178/01190/01200 — unit tests for the post-deploy verification
// pipeline (autopilot-verification.ts). runVerification() is the final gate
// before a VTID can be marked terminally completed: health check is a hard
// requirement, CSP/acceptance/visual checks are warnings that get recorded
// but do not block the pass/fail verdict.
//
// Scope:
//   1. Spec-enforcement gate — blocks the whole pipeline before health check
//      ever runs when no valid persisted spec exists.
//   2. Health check (runHealthCheck via quickHealthCheck) — retry behavior,
//      unconfigured-service short-circuit, network-error handling.
//   3. CSP check — frontend-domain detection, missing-header / inline-script
//      violations, and that CSP failures never block the overall verdict.
//   4. Acceptance assertions — parsing MUST/SHOULD/SHALL patterns from the
//      spec text and evaluating endpoint_exists assertions, and that
//      acceptance failures never block the overall verdict.
//   5. Visual verification integration — pass/fail/thrown-error handling.
//   6. Full pipeline composition — "health check is required, everything
//      else is a warning" verdict rule; markCompleted only on pass; the
//      notable gap where a clean (non-throwing) failure never calls
//      markFailed; and exception handling via the outer try/catch.

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

const mockMarkVerifying = jest.fn().mockResolvedValue(true);
const mockMarkCompleted = jest.fn().mockResolvedValue(true);
const mockMarkFailed = jest.fn().mockResolvedValue(true);
const mockGetSpecSnapshot = jest.fn();
jest.mock('../../src/services/autopilot-controller', () => ({
  markVerifying: (...args: any[]) => mockMarkVerifying(...args),
  markCompleted: (...args: any[]) => mockMarkCompleted(...args),
  markFailed: (...args: any[]) => mockMarkFailed(...args),
  getSpecSnapshot: (...args: any[]) => mockGetSpecSnapshot(...args),
}));

const mockGetVtidSpec = jest.fn();
const mockEnforceSpecRequirement = jest.fn();
const mockGetSpecDomain = jest.fn();
const mockGetSpecTargetPaths = jest.fn();
jest.mock('../../src/services/vtid-spec-service', () => ({
  getVtidSpec: (...args: any[]) => mockGetVtidSpec(...args),
  enforceSpecRequirement: (...args: any[]) => mockEnforceSpecRequirement(...args),
  getSpecDomain: (...args: any[]) => mockGetSpecDomain(...args),
  getSpecTargetPaths: (...args: any[]) => mockGetSpecTargetPaths(...args),
}));

const mockRunVisualVerification = jest.fn();
jest.mock('../../src/services/visual-verification', () => ({
  runVisualVerification: (...args: any[]) => mockRunVisualVerification(...args),
}));

import { runVerification, quickHealthCheck } from '../../src/services/autopilot-verification';

const VTID = 'VTID-01178';
// Matches the hardcoded fallback in SERVICE_URLS['gateway'] (no GATEWAY_URL
// env var is set for these tests), so tests that want a *configured*
// service without threading deploy_url can target this host directly.
const GATEWAY_DEFAULT_URL = 'https://gateway-lovable-vitana-vers1.uc.r.appspot.com';

const PASSING_VISUAL = {
  ok: true,
  passed: true,
  result: {
    passed: true,
    page_load_passed: true,
    journeys_passed: true,
    accessibility_passed: true,
    screenshots: [],
    journey_results: [],
    accessibility_violations: [],
    issues: [],
    verified_at: '2026-07-01T00:00:00Z',
  },
};

function mockFetchRoutes(routes: Array<{ test: (url: string, init: any) => boolean; respond: (url: string, init: any) => any }>) {
  (global.fetch as jest.Mock).mockImplementation(async (url: any, init: any = {}) => {
    const urlStr = String(url);
    const route = routes.find((r) => r.test(urlStr, init));
    if (!route) {
      throw new Error(`Unhandled fetch in test: ${init.method || 'GET'} ${urlStr}`);
    }
    return route.respond(urlStr, init);
  });
}

function okJson(body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmitOasisEvent.mockResolvedValue({ ok: true });
  mockMarkVerifying.mockResolvedValue(true);
  mockMarkCompleted.mockResolvedValue(true);
  mockMarkFailed.mockResolvedValue(true);
  mockEnforceSpecRequirement.mockResolvedValue({ allowed: true, spec: { spec_checksum: 'abc' } });
  // Default: no DB spec found -> CSP check and acceptance assertions both
  // short-circuit to passed:true without making any extra fetch calls.
  mockGetVtidSpec.mockResolvedValue(null);
  mockRunVisualVerification.mockResolvedValue(PASSING_VISUAL);
});

function eventTypes() {
  return mockEmitOasisEvent.mock.calls.map((c) => c[0].type);
}

const BASE_REQUEST = {
  vtid: VTID,
  service: 'gateway',
  environment: 'production',
  deploy_url: 'https://deploy-under-test.example.com',
};

// ---------------------------------------------------------------------------
// 1. Spec enforcement gate
// ---------------------------------------------------------------------------

describe('runVerification — spec enforcement gate', () => {
  it('blocks the entire pipeline (no health check, no markVerifying) when spec enforcement denies', async () => {
    mockEnforceSpecRequirement.mockResolvedValue({
      allowed: false,
      error: 'No persisted spec found',
      error_code: 'SPEC_NOT_FOUND',
    });

    const res = await runVerification(BASE_REQUEST);

    expect(res.ok).toBe(false);
    expect(res.passed).toBe(false);
    expect(res.error).toContain('No persisted spec found');
    expect(mockMarkVerifying).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(eventTypes()).toEqual(['autopilot.verification.failed']);
  });
});

// ---------------------------------------------------------------------------
// 2. Health check (via quickHealthCheck — isolated, no OASIS events)
// ---------------------------------------------------------------------------

describe('quickHealthCheck', () => {
  it('returns false immediately (no fetch) for a service with no configured URL', async () => {
    const result = await quickHealthCheck('some-unmapped-service');
    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns true on a 200 response, on the first attempt', async () => {
    mockFetchRoutes([{ test: (u) => u === `${GATEWAY_DEFAULT_URL}/alive`, respond: () => okJson({ ok: true }) }]);

    const result = await quickHealthCheck('gateway');

    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled(); // quick check never touches OASIS
  });

  it('retries on a non-2xx response and succeeds once a later attempt returns 200', async () => {
    jest.useFakeTimers();
    let attempt = 0;
    (global.fetch as jest.Mock).mockImplementation(async () => {
      attempt += 1;
      if (attempt < 2) return { ok: false, status: 503 };
      return okJson({ ok: true });
    });

    const promise = quickHealthCheck('gateway');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('returns false after exhausting all retries on persistent failure', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

    const promise = quickHealthCheck('gateway');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(3); // CONFIG.maxRetries
    jest.useRealTimers();
  });

  it('returns false (not throw) after retries when fetch keeps rejecting with a network error', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

    const promise = quickHealthCheck('gateway');
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 3. CSP check
// ---------------------------------------------------------------------------

describe('runVerification — CSP check', () => {
  it('skips the CSP check entirely (passed, no fetch beyond health) for a non-frontend spec', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: { task_domain: 'backend', target_paths: ['services/gateway/src/foo.ts'] },
      primary_domain: 'backend',
    });
    mockGetSpecDomain.mockReturnValue('backend');
    mockGetSpecTargetPaths.mockReturnValue(['services/gateway/src/foo.ts']);
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => okJson() }]);

    const res = await runVerification(BASE_REQUEST);

    expect(res.result?.csp_check_passed).toBe(true);
    // Only the health check fetch happened.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('flags a missing Content-Security-Policy header for a frontend spec, without blocking the overall verdict', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: { task_domain: 'frontend', target_paths: [] },
      primary_domain: 'frontend',
    });
    mockGetSpecDomain.mockReturnValue('frontend');
    mockGetSpecTargetPaths.mockReturnValue([]);
    mockFetchRoutes([
      { test: (u) => u.endsWith('/alive'), respond: () => okJson() },
      { test: (u) => u === GATEWAY_DEFAULT_URL, respond: () => okJson('<html><body>ok</body></html>') },
    ]);

    const res = await runVerification(BASE_REQUEST);

    expect(res.result?.csp_check_passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing Content-Security-Policy header')])
    );
    // Health check still passed -> overall verdict passes despite the CSP warning.
    expect(res.passed).toBe(true);
  });

  it('detects an inline <script> without a nonce', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: { task_domain: 'frontend', target_paths: [] },
      primary_domain: 'frontend',
    });
    mockGetSpecDomain.mockReturnValue('frontend');
    mockGetSpecTargetPaths.mockReturnValue([]);
    mockFetchRoutes([
      { test: (u) => u.endsWith('/alive'), respond: () => okJson() },
      {
        test: (u) => u === GATEWAY_DEFAULT_URL,
        respond: () => okJson('<html><body><script>alert(1)</script></body></html>', { 'content-security-policy': "default-src 'self'" }),
      },
    ]);

    const res = await runVerification(BASE_REQUEST);

    expect(res.result?.csp_check_passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('inline script without nonce')])
    );
  });

  it('passes cleanly when a CSP header is present and no inline scripts are found', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: { task_domain: 'frontend', target_paths: [] },
      primary_domain: 'frontend',
    });
    mockGetSpecDomain.mockReturnValue('frontend');
    mockGetSpecTargetPaths.mockReturnValue([]);
    mockFetchRoutes([
      { test: (u) => u.endsWith('/alive'), respond: () => okJson() },
      {
        test: (u) => u === GATEWAY_DEFAULT_URL,
        respond: () => okJson('<html><body>ok</body></html>', { 'content-security-policy': "default-src 'self'" }),
      },
    ]);

    const res = await runVerification(BASE_REQUEST);
    expect(res.result?.csp_check_passed).toBe(true);
  });

  it('treats a CSP fetch error as a pass (warning-tolerant, non-blocking)', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: { task_domain: 'frontend', target_paths: [] },
      primary_domain: 'frontend',
    });
    mockGetSpecDomain.mockReturnValue('frontend');
    mockGetSpecTargetPaths.mockReturnValue([]);
    mockFetchRoutes([
      { test: (u) => u.endsWith('/alive'), respond: () => okJson() },
      {
        test: (u) => u === GATEWAY_DEFAULT_URL,
        respond: () => { throw new Error('network blip'); },
      },
    ]);

    const res = await runVerification(BASE_REQUEST);
    expect(res.result?.csp_check_passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Acceptance assertions
// ---------------------------------------------------------------------------

describe('runVerification — acceptance assertions', () => {
  it('passes by default (no assertions) when the spec text has no MUST/SHOULD/SHALL directives', async () => {
    mockGetVtidSpec.mockResolvedValue({ spec_content: { spec_text: 'Just a plain description, nothing prescriptive.' } });
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => okJson() }]);

    const res = await runVerification(BASE_REQUEST);
    expect(res.result?.acceptance_assertions_passed).toBe(true);
  });

  it('parses an endpoint_exists assertion and passes when the HEAD probe is not a 404', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: { spec_text: 'The service MUST create endpoint /api/v1/widgets.' },
    });
    mockFetchRoutes([
      { test: (u) => u.endsWith('/alive'), respond: () => okJson() },
      { test: (u, init) => u === `${GATEWAY_DEFAULT_URL}/api/v1/widgets` && init.method === 'HEAD', respond: () => ({ ok: true, status: 200 }) },
    ]);

    const res = await runVerification(BASE_REQUEST);

    expect(res.result?.acceptance_assertions_passed).toBe(true);
    const assertion = (res.result as any).issues;
    expect(assertion).toEqual([]);
  });

  it('fails the endpoint_exists assertion (as a non-blocking warning) when the HEAD probe 404s', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: { spec_text: 'The service MUST create endpoint /api/v1/missing.' },
    });
    mockFetchRoutes([
      { test: (u) => u.endsWith('/alive'), respond: () => okJson() },
      { test: (u, init) => u === `${GATEWAY_DEFAULT_URL}/api/v1/missing` && init.method === 'HEAD', respond: () => ({ ok: false, status: 404 }) },
    ]);

    const res = await runVerification(BASE_REQUEST);

    expect(res.result?.acceptance_assertions_passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('/api/v1/missing')])
    );
    // Still an overall pass — acceptance is a warning, not a blocker.
    expect(res.passed).toBe(true);
  });

  it('auto-passes status_code and file_exists assertion types (not independently verified at runtime)', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: {
        spec_text: 'The service MUST return 200 for /health and MUST create file services/gateway/src/new.ts.',
      },
    });
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => okJson() }]);

    const res = await runVerification(BASE_REQUEST);
    expect(res.result?.acceptance_assertions_passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Visual verification integration
// ---------------------------------------------------------------------------

describe('runVerification — visual verification', () => {
  it('records a passing visual verification result', async () => {
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => okJson() }]);
    mockRunVisualVerification.mockResolvedValue(PASSING_VISUAL);

    const res = await runVerification(BASE_REQUEST);

    expect(res.result?.visual_verification_passed).toBe(true);
    expect(mockRunVisualVerification).toHaveBeenCalledWith(
      expect.objectContaining({ vtid: VTID, service: 'gateway', environment: 'production' })
    );
  });

  it('records a failing visual verification as a non-blocking warning', async () => {
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => okJson() }]);
    mockRunVisualVerification.mockResolvedValue({
      ok: true,
      passed: false,
      result: { ...PASSING_VISUAL.result, passed: false, page_load_passed: false, issues: ['Page failed to load'] },
    });

    const res = await runVerification(BASE_REQUEST);

    expect(res.result?.visual_verification_passed).toBe(false);
    expect(res.result?.issues).toEqual(expect.arrayContaining(['Page failed to load']));
    expect(res.passed).toBe(true); // health check alone still passed
  });

  it('treats a thrown visual verification error as a warning, not a pipeline failure', async () => {
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => okJson() }]);
    mockRunVisualVerification.mockRejectedValue(new Error('Playwright MCP unavailable'));

    const res = await runVerification(BASE_REQUEST);

    expect(res.ok).toBe(true);
    expect(res.result?.visual_verification_passed).toBe(false);
    expect(res.passed).toBe(true); // still passes on health check alone
  });
});

// ---------------------------------------------------------------------------
// 6. Full pipeline composition
// ---------------------------------------------------------------------------

describe('runVerification — full pipeline composition', () => {
  it('calls markVerifying before any checks run, regardless of eventual outcome', async () => {
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => okJson() }]);
    await runVerification(BASE_REQUEST);
    expect(mockMarkVerifying).toHaveBeenCalledWith(VTID);
  });

  it('passes overall and calls markCompleted when the health check succeeds, even if CSP/acceptance/visual are all failing', async () => {
    mockGetVtidSpec.mockResolvedValue({
      spec_content: { task_domain: 'frontend', target_paths: [], spec_text: 'MUST create endpoint /api/v1/missing.' },
      primary_domain: 'frontend',
    });
    mockGetSpecDomain.mockReturnValue('frontend');
    mockGetSpecTargetPaths.mockReturnValue([]);
    mockFetchRoutes([
      { test: (u) => u.endsWith('/alive'), respond: () => okJson() },
      { test: (u) => u === GATEWAY_DEFAULT_URL, respond: () => okJson('<html></html>') }, // no CSP header -> violation
      { test: (u, init) => init.method === 'HEAD', respond: () => ({ ok: false, status: 404 }) }, // assertion fails
    ]);
    mockRunVisualVerification.mockResolvedValue({ ok: true, passed: false, result: { ...PASSING_VISUAL.result, passed: false, issues: ['visual issue'] } });

    const res = await runVerification(BASE_REQUEST);

    expect(res.result?.health_check_passed).toBe(true);
    expect(res.result?.csp_check_passed).toBe(false);
    expect(res.result?.acceptance_assertions_passed).toBe(false);
    expect(res.result?.visual_verification_passed).toBe(false);
    expect(res.passed).toBe(true); // "health check is required, the rest are warnings"
    expect(mockMarkCompleted).toHaveBeenCalledWith(VTID, expect.objectContaining({ passed: true }));
    expect(eventTypes()[eventTypes().length - 1]).toBe('autopilot.verification.completed');
  });

  it('fails overall when the health check fails, and does NOT call markCompleted', async () => {
    jest.useFakeTimers();
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => ({ ok: false, status: 503 }) }]);

    const promise = runVerification(BASE_REQUEST);
    await jest.runAllTimersAsync();
    const res = await promise;
    jest.useRealTimers();

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.result?.health_check_passed).toBe(false);
    expect(mockMarkCompleted).not.toHaveBeenCalled();
    expect(eventTypes()[eventTypes().length - 1]).toBe('autopilot.verification.failed');
  });

  it('gap: a clean (non-throwing) health-check failure does NOT call markFailed either — the run is left non-terminal', async () => {
    jest.useFakeTimers();
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => ({ ok: false, status: 503 }) }]);

    const promise = runVerification(BASE_REQUEST);
    await jest.runAllTimersAsync();
    await promise;
    jest.useRealTimers();

    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('exception path: an unexpected throw inside the try block is caught, calls markFailed, and returns ok:false', async () => {
    mockGetVtidSpec.mockRejectedValue(new Error('DB unreachable'));
    mockFetchRoutes([{ test: (u) => u.endsWith('/alive'), respond: () => okJson() }]);

    const res = await runVerification(BASE_REQUEST);

    expect(res.ok).toBe(false);
    expect(res.passed).toBe(false);
    expect(res.error).toBe('DB unreachable');
    expect(mockMarkFailed).toHaveBeenCalledWith(VTID, expect.stringContaining('DB unreachable'), 'VERIFICATION_ERROR');
    expect(eventTypes()[eventTypes().length - 1]).toBe('autopilot.verification.failed');
  });

  it('gap: a rejection from markVerifying itself is NOT caught — it propagates out of runVerification uncaught', async () => {
    mockMarkVerifying.mockRejectedValue(new Error('ledger write failed'));

    await expect(runVerification(BASE_REQUEST)).rejects.toThrow('ledger write failed');
    // The pipeline never got as far as emitting a 'started' event.
    expect(eventTypes()).not.toContain('autopilot.verification.started');
  });
});

/**
 * VTID-04132: `approveAutoExecute` must skip the pre-flight scope and
 * tests_missing safety-gate rules for an open-ended operator on-ramp plan
 * (`autopilot_run_task`, `spec_snapshot.intake === 'open_ended'`) — they
 * are enforced instead, post-hoc, against the agent's real diff
 * (`agent-scope.ts`'s `checkChangedFilesScope`/`hasTestCoverage`, VTID-04006).
 *
 * Root-caused from real production `oasis_events` on 2026-09-20: three real
 * Operator Console attempts (two at one task, one at another) were rejected
 * with `tests_missing` before the agent ever ran, because the open-ended
 * request's raw prose never named a literal test-file path (e.g. "Add a
 * unit test in services/gateway/test/ confirming X" — a directory
 * reference, not a path `extractFilePaths()` can match) even though the
 * agent, which discovers files, would have written a concrete one.
 * operator-execution-onramp.ts's own module doc already documented that the
 * scope/test-coverage rules should be deferred to the post-hoc check for
 * open-ended plans; this was never actually wired that way until this VTID.
 */

type FetchMock = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_SUPABASE_URL = process.env.SUPABASE_URL;
const ORIGINAL_SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const FINDING_ID = '9c2f5b4a-1234-4a3b-9c9f-2b6f9a1e0a11';
// The real reported request never named a literal test file path — only
// the source file the change actually touches.
const SOURCE_ONLY_PLAN_MARKDOWN =
  'Add finish_reason logging to the DeepSeek adapter in ' +
  'services/gateway/src/services/llm-router.ts. Add a unit test in ' +
  'services/gateway/test/ confirming the adapter logs finish_reason ' +
  'when DeepSeek returns it.';

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function routeFetch(fetchMock: FetchMock, intake: 'open_ended' | 'plan' | undefined) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    if (url.includes('/rest/v1/autopilot_recommendations?id=eq.') && method === 'GET') {
      return mockResponse([{
        id: FINDING_ID,
        risk_class: 'medium',
        source_type: 'operator_onramp',
        source_ref: null,
        spec_snapshot: { scanner: 'operator-onramp', vtid: 'VTID-04132', ...(intake ? { intake } : {}) },
        status: 'new',
      }]);
    }
    if (url.includes('/rest/v1/autopilot_recommendations?id=eq.') && method === 'PATCH') {
      return mockResponse(null, 204);
    }
    if (url.includes('/rest/v1/dev_autopilot_executions?finding_id=eq.')) {
      return mockResponse([]);
    }
    if (url.includes('/rest/v1/dev_autopilot_plan_versions?finding_id=eq.')) {
      return mockResponse([{ version: 1, files_referenced: [], plan_markdown: SOURCE_ONLY_PLAN_MARKDOWN }]);
    }
    if (url.includes('/rest/v1/dev_autopilot_config?id=eq.1')) {
      return mockResponse([{
        kill_switch: false,
        daily_budget: 500,
        concurrency_cap: 4,
        max_auto_fix_depth: 2,
        cooldown_minutes: 0,
        allow_scope: ['services/gateway/src/services/**', 'services/gateway/test/**'],
        deny_scope: ['supabase/migrations/**', '**/auth*'],
      }]);
    }
    if (url.includes('/rest/v1/dev_autopilot_executions?approved_at=gte.')) {
      return mockResponse([]);
    }
    if (url.endsWith('/rest/v1/dev_autopilot_executions') && method === 'POST') {
      return mockResponse(null, 201);
    }
    return mockResponse({ error: `unexpected ${method} ${url}` }, 404);
  });
}

describe('approveAutoExecute — open-ended plans skip scope/tests_missing pre-flight (VTID-04132)', () => {
  let fetchMock: FetchMock;
  let approveAutoExecute: typeof import('../src/services/dev-autopilot-execute').approveAutoExecute;

  beforeAll(() => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test_service_role_key';
  });

  afterAll(() => {
    if (ORIGINAL_SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = ORIGINAL_SUPABASE_URL;
    if (ORIGINAL_SUPABASE_SERVICE_ROLE === undefined) delete process.env.SUPABASE_SERVICE_ROLE;
    else process.env.SUPABASE_SERVICE_ROLE = ORIGINAL_SUPABASE_SERVICE_ROLE;
    global.fetch = ORIGINAL_FETCH;
  });

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/services/oasis-event-service', () => ({
      emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
    }));
    jest.mock('../src/services/dev-autopilot-outcomes', () => ({
      recordOutcome: jest.fn().mockResolvedValue(undefined),
      recordExecOutcome: jest.fn().mockResolvedValue(undefined),
    }));
    jest.mock('../src/services/dev-autopilot-self-heal-log', () => ({
      writeAutopilotFailure: jest.fn().mockResolvedValue(undefined),
      writeAutopilotSuccess: jest.fn().mockResolvedValue(undefined),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    approveAutoExecute = require('../src/services/dev-autopilot-execute').approveAutoExecute;
    fetchMock = jest.fn() as FetchMock;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('an open-ended plan whose prose names only a source file (no literal test path) is NOT rejected as tests_missing', async () => {
    routeFetch(fetchMock, 'open_ended');

    const result = await approveAutoExecute({ finding_id: FINDING_ID, interactive: true });

    expect(result.ok).toBe(true);
    expect(result.decision?.violations ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'tests_missing' }),
    );
  });

  it('regression: the identical plan text is STILL rejected as tests_missing when intake is "plan" (not open-ended)', async () => {
    routeFetch(fetchMock, 'plan');

    const result = await approveAutoExecute({ finding_id: FINDING_ID, interactive: true });

    expect(result.ok).toBe(false);
    expect(result.decision?.violations?.map((v) => v.code)).toContain('tests_missing');
  });

  it('regression: the identical plan text is STILL rejected as tests_missing when intake is absent entirely (pre-existing plan-based on-ramp callers)', async () => {
    routeFetch(fetchMock, undefined);

    const result = await approveAutoExecute({ finding_id: FINDING_ID, interactive: true });

    expect(result.ok).toBe(false);
    expect(result.decision?.violations?.map((v) => v.code)).toContain('tests_missing');
  });
});

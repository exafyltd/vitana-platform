/**
 * VTID-03839: `approveAutoExecute` must never send a non-UUID `approved_by`
 * to `dev_autopilot_executions` (uuid column), and the operator on-ramp's
 * interactive semantics must survive without one.
 *
 * Observed on staging 2026-09-13 (thread e947d9bb-…): the first real
 * on-ramp request that cleared the safety gate died on the execution
 * INSERT with Postgres 22P02 — `invalid input syntax for type uuid:
 * "operator-chat:e947d9bb-…"` — because the on-ramp passed its requester
 * LABEL as `approved_by`. Every other caller passes a user UUID
 * (`req.user.id`) or nothing (autoApproveTick, NULL = system sentinel).
 *
 * Fix under test:
 *   1. `approveAutoExecute` rejects a non-UUID `approved_by` up front,
 *      naming the real constraint, before writing anything.
 *   2. A new `interactive: true` input keeps what `approved_by` used to
 *      imply — a rejection is returned, not 7-day-snoozed, and the outcome
 *      is `approved` not `auto_exec` — without touching the uuid column.
 *   3. The on-ramp passes `interactive: true` and no `approved_by`
 *      (asserted in vtid-03820-operator-execution-onramp.test.ts).
 */

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

import { approveAutoExecute, isUuidString } from '../src/services/dev-autopilot-execute';
import { recordOutcome } from '../src/services/dev-autopilot-outcomes';

type FetchMock = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_SUPABASE_URL = process.env.SUPABASE_URL;
const ORIGINAL_SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const FINDING_ID = '4208c292-33ef-4af3-be3f-f1b65e321344';
const USER_UUID = 'a27552a3-0257-4305-8ed0-351a80fd3701';
const ONRAMP_LABEL = 'operator-chat:e947d9bb-95b6-4b99-86c1-b5c75de27570';
const TEST_FILE = 'services/gateway/test/task-title.test.ts';
const OUT_OF_SCOPE_FILE = 'services/gateway/src/utils/task-title.ts';

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/**
 * Route every Supabase REST call approveAutoExecute makes by URL + method,
 * so the test does not depend on call order. `planFiles` controls what the
 * safety gate sees (an explicit "Files to modify" section wins — see
 * extractFilePaths).
 */
function routeFetch(fetchMock: FetchMock, planFiles: string[]) {
  const planMarkdown = ['## Files to modify', ...planFiles.map((f) => `- ${f}`), ''].join('\n');
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    if (url.includes('/rest/v1/autopilot_recommendations?id=eq.') && method === 'GET') {
      return mockResponse([{
        id: FINDING_ID,
        risk_class: 'medium',
        source_type: 'operator_onramp',
        source_ref: null,
        spec_snapshot: { scanner: 'operator-onramp', vtid: 'VTID-03829' },
        status: 'new',
      }]);
    }
    if (url.includes('/rest/v1/autopilot_recommendations?id=eq.') && method === 'PATCH') {
      return mockResponse(null, 204); // the 7-day snooze
    }
    if (url.includes('/rest/v1/dev_autopilot_executions?finding_id=eq.')) {
      return mockResponse([]); // no stranded PR
    }
    if (url.includes('/rest/v1/dev_autopilot_plan_versions?finding_id=eq.')) {
      return mockResponse([{ version: 1, files_referenced: planFiles, plan_markdown: planMarkdown }]);
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
      return mockResponse([]); // nothing approved today
    }
    if (url.endsWith('/rest/v1/dev_autopilot_executions') && method === 'POST') {
      return mockResponse(null, 201);
    }
    return mockResponse({ error: `unexpected ${method} ${url}` }, 404);
  });
}

function calls(fetchMock: FetchMock, predicate: (url: string, method: string) => boolean) {
  return fetchMock.mock.calls.filter(([input, init]) =>
    predicate(String(input), (init?.method || 'GET').toUpperCase()));
}

function executionInsertBody(fetchMock: FetchMock): Record<string, unknown> {
  const ins = calls(fetchMock, (u, m) => u.endsWith('/rest/v1/dev_autopilot_executions') && m === 'POST');
  expect(ins).toHaveLength(1);
  return JSON.parse(String(ins[0][1]!.body));
}

function snoozePatches(fetchMock: FetchMock) {
  return calls(fetchMock, (u, m) => u.includes('/rest/v1/autopilot_recommendations?id=eq.') && m === 'PATCH');
}

describe('isUuidString (VTID-03839)', () => {
  it('accepts a canonical UUID in either case', () => {
    expect(isUuidString(USER_UUID)).toBe(true);
    expect(isUuidString(USER_UUID.toUpperCase())).toBe(true);
  });

  it('rejects the on-ramp label that broke the real INSERT, and other non-UUIDs', () => {
    expect(isUuidString(ONRAMP_LABEL)).toBe(false);
    expect(isUuidString('')).toBe(false);
    expect(isUuidString('operator')).toBe(false);
    expect(isUuidString(`${USER_UUID}x`)).toBe(false);
  });
});

describe('approveAutoExecute — approved_by must be a UUID (VTID-03839)', () => {
  let fetchMock: FetchMock;
  const mockedRecordOutcome = recordOutcome as jest.Mock;

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
    fetchMock = jest.fn() as FetchMock;
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedRecordOutcome.mockClear();
  });

  it('rejects a non-UUID approved_by BEFORE any DB access, naming the uuid column and the interactive alternative', async () => {
    routeFetch(fetchMock, [TEST_FILE]);

    const result = await approveAutoExecute({ finding_id: FINDING_ID, approved_by: ONRAMP_LABEL });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/approved_by must be a user UUID/);
    expect(result.error).toMatch(/dev_autopilot_executions\.approved_by is uuid/);
    expect(result.error).toContain(ONRAMP_LABEL);
    expect(result.error).toMatch(/interactive:true/);
    // Nothing was written or even read — the old failure had already
    // inserted the finding + plan and run the whole safety gate first.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('interactive request with no approved_by: inserts approved_by = null and records a human "approved" outcome', async () => {
    routeFetch(fetchMock, [TEST_FILE]);

    const result = await approveAutoExecute({ finding_id: FINDING_ID, interactive: true });

    expect(result.ok).toBe(true);
    expect(result.execution?.status).toBe('cooling');
    const body = executionInsertBody(fetchMock);
    expect(body.approved_by).toBeNull(); // NULL — never a label
    expect(body.finding_id).toBe(FINDING_ID);
    expect(mockedRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      finding_id: FINDING_ID,
      decision: 'approved',
      approver_user_id: null,
    }));
  });

  it('a real user UUID still passes the pre-check and is written verbatim (the guard does not over-reject)', async () => {
    routeFetch(fetchMock, [TEST_FILE]);

    const result = await approveAutoExecute({ finding_id: FINDING_ID, approved_by: USER_UUID });

    expect(result.ok).toBe(true);
    expect(executionInsertBody(fetchMock).approved_by).toBe(USER_UUID);
    expect(mockedRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'approved',
      approver_user_id: USER_UUID,
    }));
  });

  it('system auto-approve (no approved_by, not interactive) is unchanged: approved_by = null, outcome auto_exec', async () => {
    routeFetch(fetchMock, [TEST_FILE]);

    const result = await approveAutoExecute({ finding_id: FINDING_ID });

    expect(result.ok).toBe(true);
    expect(executionInsertBody(fetchMock).approved_by).toBeNull();
    expect(mockedRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'auto_exec',
      approver_user_id: null,
    }));
  });

  describe('safety-gate rejection', () => {
    it('interactive caller gets the violation back and the finding is NOT snoozed', async () => {
      routeFetch(fetchMock, [TEST_FILE, OUT_OF_SCOPE_FILE]);

      const result = await approveAutoExecute({ finding_id: FINDING_ID, interactive: true });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('safety gate blocked approval');
      expect(result.decision?.violations?.map((v) => v.code)).toContain('file_outside_allow_scope');
      expect(snoozePatches(fetchMock)).toHaveLength(0);
      expect(calls(fetchMock, (u, m) => u.endsWith('/rest/v1/dev_autopilot_executions') && m === 'POST')).toHaveLength(0);
    });

    it('mutation check: the same rejection WITHOUT interactive (unattended tick) still snoozes for 7 days', async () => {
      routeFetch(fetchMock, [TEST_FILE, OUT_OF_SCOPE_FILE]);

      const result = await approveAutoExecute({ finding_id: FINDING_ID });

      expect(result.ok).toBe(false);
      const patches = snoozePatches(fetchMock);
      expect(patches).toHaveLength(1);
      const patchBody = JSON.parse(String(patches[0][1]!.body));
      expect(patchBody.status).toBe('snoozed');
      expect(typeof patchBody.snoozed_until).toBe('string');
    });
  });
});

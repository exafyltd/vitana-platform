/**
 * VTID-02639 — Tests for the finding-completion guard inside approveAutoExecute.
 *
 * The guard rejects re-approval of any finding whose status is not 'new'.
 * Without it, autoApproveTick() (which already filters by status='new'
 * upstream) was the only thing preventing duplicate PRs against a single
 * finding — and a manual call into approveAutoExecute could still race.
 *
 * The 2026-04-30 sweep had to close 6 identical
 * "Refactor admin-notification-categories to use middleware" PRs that all
 * targeted the same finding. This guard is the regression fence.
 */

import { approveAutoExecute } from '../src/services/dev-autopilot-execute';

type FetchMock = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_SUPABASE_URL = process.env.SUPABASE_URL;
const ORIGINAL_SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('approveAutoExecute — VTID-02639 finding-completion guard', () => {
  let fetchMock: FetchMock;

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
  });

  it('rejects a finding whose status is "completed"', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-1',
      risk_class: 'low',
      source_type: 'dev_autopilot',
      spec_snapshot: {},
      status: 'completed',
    }]));

    const result = await approveAutoExecute({ finding_id: 'f-1' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/status is 'completed'/);
    expect(result.error).toMatch(/only 'new'/);
    // Should short-circuit BEFORE loading plan/config — only one fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a finding whose status is "rejected"', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-2',
      risk_class: 'medium',
      source_type: 'dev_autopilot_impact',
      spec_snapshot: { rule: 'companion-test-missing' },
      status: 'rejected',
    }]));

    const result = await approveAutoExecute({ finding_id: 'f-2' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/status is 'rejected'/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a finding whose status is "snoozed"', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-3',
      risk_class: 'low',
      source_type: 'dev_autopilot',
      spec_snapshot: {},
      status: 'snoozed',
    }]));

    const result = await approveAutoExecute({ finding_id: 'f-3' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/status is 'snoozed'/);
  });

  it('rejects a finding whose status is "activated"', async () => {
    // 'activated' means the finding has already been turned into a VTID by
    // a different code path. Re-approving it through the autopilot would
    // double-track the same work.
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-4',
      risk_class: 'low',
      source_type: 'dev_autopilot',
      spec_snapshot: {},
      status: 'activated',
    }]));

    const result = await approveAutoExecute({ finding_id: 'f-4' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/status is 'activated'/);
  });

  it('progresses past the status guard for status="new" findings', async () => {
    // Stubs the finding lookup but not the rest of the pipeline. The
    // assertion is that we get past the status guard — any subsequent
    // error (plan missing, supabase 500, etc.) is fine, just not the
    // finding-completion error string.
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-5',
      risk_class: 'low',
      source_type: 'dev_autopilot',
      spec_snapshot: {},
      status: 'new',
    }]));
    // Plan-version lookup → empty (so we error with "plan version required",
    // proving we got past the status check).
    fetchMock.mockResolvedValueOnce(mockResponse([]));

    const result = await approveAutoExecute({ finding_id: 'f-5' });

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/status is/);
    expect(result.error).toMatch(/plan version required/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

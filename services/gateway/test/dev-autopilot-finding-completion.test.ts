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
    // Open-PR check → empty (no stranded PR from a prior execution).
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    // Plan-version lookup → empty (so we error with "plan version required",
    // proving we got past both early guards).
    fetchMock.mockResolvedValueOnce(mockResponse([]));

    const result = await approveAutoExecute({ finding_id: 'f-5' });

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/status is/);
    expect(result.error).not.toMatch(/already has an unmerged PR/);
    expect(result.error).toMatch(/plan version required/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('approveAutoExecute — VTID-AUTOPILOT-PR-FLOOD open-PR guard', () => {
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

  it('rejects a status="new" finding that has an unmerged PR from a failed prior execution', async () => {
    // 1. Finding lookup → status='new', would normally pass the first guard.
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-flood-1',
      risk_class: 'low',
      source_type: 'dev_autopilot',
      spec_snapshot: {},
      status: 'new',
    }]));
    // 2. Open-PR check → returns a stranded execution row from a prior
    //    failed run that opened PR #1234 and never closed it.
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'exec-prior-1',
      pr_url: 'https://github.com/exafyltd/vitana-platform/pull/1234',
      pr_number: 1234,
      status: 'failed',
    }]));

    const result = await approveAutoExecute({ finding_id: 'f-flood-1' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already has an unmerged PR/);
    expect(result.error).toMatch(/pull\/1234/);
    expect(result.error).toMatch(/status=failed/);
    expect(result.error).toMatch(/close or merge it before re-approving/);
    // Should short-circuit BEFORE loading the plan — exactly two fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects when a prior execution has reverted state and a stranded PR', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-flood-2',
      risk_class: 'medium',
      source_type: 'dev_autopilot_impact',
      spec_snapshot: {},
      status: 'new',
    }]));
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'exec-prior-2',
      pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9999',
      pr_number: 9999,
      status: 'reverted',
    }]));

    const result = await approveAutoExecute({ finding_id: 'f-flood-2' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already has an unmerged PR/);
    expect(result.error).toMatch(/status=reverted/);
  });

  it('does NOT block when prior executions all reached completed/self_healed/auto_archived', async () => {
    // The PostgREST filter status=not.in.(completed,self_healed,auto_archived)
    // returns an empty array because every prior execution is in a terminal
    // "PR was handled" state. The guard must allow the new approval to
    // proceed. We mock that filter result and assert we drop into the
    // plan-version lookup (which we then short-circuit with empty).
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-flood-3',
      risk_class: 'low',
      source_type: 'dev_autopilot',
      spec_snapshot: {},
      status: 'new',
    }]));
    // Open-PR check → empty (filter excludes completed/self_healed/auto_archived).
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    // Plan-version lookup → empty so we error with "plan version required".
    fetchMock.mockResolvedValueOnce(mockResponse([]));

    const result = await approveAutoExecute({ finding_id: 'f-flood-3' });

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/already has an unmerged PR/);
    expect(result.error).toMatch(/plan version required/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('issues the correct PostgREST filter for the open-PR check', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: 'f-flood-4',
      risk_class: 'low',
      source_type: 'dev_autopilot',
      spec_snapshot: {},
      status: 'new',
    }]));
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    fetchMock.mockResolvedValueOnce(mockResponse([]));

    await approveAutoExecute({ finding_id: 'f-flood-4' });

    // Assert the second fetch (the open-PR check) hit the right URL with
    // the right filters. Without these we'd silently regress to the
    // pre-fix behaviour where dev_autopilot_executions was never queried.
    const openPrCall = fetchMock.mock.calls[1];
    const url = String(openPrCall?.[0] ?? '');
    expect(url).toMatch(/dev_autopilot_executions/);
    expect(url).toMatch(/finding_id=eq\.f-flood-4/);
    expect(url).toMatch(/pr_url=not\.is\.null/);
    expect(url).toMatch(/status=not\.in\.\(completed,self_healed,auto_archived\)/);
  });
});

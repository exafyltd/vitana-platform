/**
 * VTID-AUTOPILOT-PR-FLOOD — runExecutionSession guard.
 *
 * Earlier guard in approveAutoExecute / autoApproveTick covers the
 * auto-approve path. This guard covers everything else (self-heal
 * spawnChildExecution(), operator-driven activate, manual API calls)
 * by checking at the executor entry-point that no other execution for
 * the same finding currently has an unmerged PR.
 *
 * Discovered live 2026-05-07: with auto_approve_enabled=true, finding
 * 709356c3 produced 2 open PRs (#1964 + #1968) within 9 minutes because
 * the bridge's revertExecutionPR is a no-op stub when DEV_AUTOPILOT_DRY_RUN
 * is unset (default 'true'), and spawnChildExecution inserts the child
 * execution row directly without going through approveAutoExecute.
 */

import { runExecutionSession } from '../src/services/dev-autopilot-execute';

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

const SUPA_CONFIG = {
  url: 'https://test.supabase.co',
  key: 'test_service_role_key',
};

describe('runExecutionSession — PR-flood guard (self-heal + activate paths)', () => {
  let fetchMock: FetchMock;

  beforeAll(() => {
    process.env.SUPABASE_URL = SUPA_CONFIG.url;
    process.env.SUPABASE_SERVICE_ROLE = SUPA_CONFIG.key;
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

  it('refuses to open a 2nd PR when the same finding has an unmerged PR from another execution', async () => {
    const childExecId = '00000000-0000-0000-0000-00000000aaaa';
    const findingId = '11111111-1111-1111-1111-111111111111';

    // 1. Load execution row — child execution spawned by self-heal bridge.
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: childExecId,
      finding_id: findingId,
      plan_version: 1,
      status: 'running',
    }]));

    // 2. PR-FLOOD guard: prior execution's PR still open.
    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: '99999999-9999-9999-9999-999999999999',
      pr_url: 'https://github.com/exafyltd/vitana-platform/pull/1964',
      pr_number: 1964,
      status: 'reverted',
    }]));

    const result = await runExecutionSession(SUPA_CONFIG, childExecId);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already has an unmerged PR/);
    expect(result.error).toMatch(/pull\/1964/);
    expect(result.error).toMatch(/status=reverted/);
    expect(result.error).toMatch(/refusing to open a duplicate/);
    expect(result.session_id).toMatch(/^pr-flood-block-/);
    // Should short-circuit BEFORE loading plan / files / LLM — exactly two fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('issues the correct PostgREST filter for the prior-execution check', async () => {
    const execId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const findingId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: execId,
      finding_id: findingId,
      plan_version: 2,
      status: 'running',
    }]));
    fetchMock.mockResolvedValueOnce(mockResponse([])); // no prior open PR
    fetchMock.mockResolvedValueOnce(mockResponse([])); // plan lookup empty → bail

    await runExecutionSession(SUPA_CONFIG, execId);

    const guardCall = fetchMock.mock.calls[1];
    const url = String(guardCall?.[0] ?? '');
    expect(url).toMatch(/dev_autopilot_executions/);
    expect(url).toMatch(new RegExp(`finding_id=eq\\.${findingId}`));
    expect(url).toMatch(new RegExp(`id=neq\\.${execId}`));
    expect(url).toMatch(/pr_url=not\.is\.null/);
    expect(url).toMatch(/status=not\.in\.\(completed,self_healed,auto_archived\)/);
  });

  it('proceeds past the guard when no other execution has an open PR', async () => {
    const execId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const findingId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

    fetchMock.mockResolvedValueOnce(mockResponse([{
      id: execId,
      finding_id: findingId,
      plan_version: 1,
      status: 'running',
    }]));
    // Guard query returns empty → no stranded PR → proceed.
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    // Plan lookup returns empty → executor errors with "plan version not found".
    fetchMock.mockResolvedValueOnce(mockResponse([]));

    const result = await runExecutionSession(SUPA_CONFIG, execId);

    expect(result.ok).toBe(false);
    // Crucially NOT the PR-flood error.
    expect(result.error).not.toMatch(/already has an unmerged PR/);
    expect(result.error).toMatch(/plan version not found/);
  });
});

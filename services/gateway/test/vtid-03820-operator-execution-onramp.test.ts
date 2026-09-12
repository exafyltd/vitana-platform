/**
 * VTID-03820: triggerOperatorExecution() — the DeepSeek execution on-ramp's
 * governance gates and happy path.
 *
 * Two gates live in THIS file (the reused Dev Autopilot machinery has
 * neither): the OPERATOR_EXECUTION_ONRAMP_ENABLED kill switch (default
 * OFF) and a spec_status='approved' + not-terminal check on the target
 * VTID. Everything past those gates reuses approveAutoExecute() (mocked
 * here, already covered by its own test suite elsewhere) unchanged.
 */

jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return {
    ...actual,
    getSupabase: jest.fn(),
    supa: jest.fn(),
    approveAutoExecute: jest.fn(),
  };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { triggerOperatorExecution } from '../src/services/operator-execution-onramp';
import { getSupabase, supa, approveAutoExecute } from '../src/services/dev-autopilot-execute';
import { emitOasisEvent } from '../src/services/oasis-event-service';

const mockedGetSupabase = getSupabase as jest.Mock;
const mockedSupa = supa as jest.Mock;
const mockedApprove = approveAutoExecute as jest.Mock;
const mockedEmit = emitOasisEvent as jest.Mock;

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any;
}

const VALID_INPUT = {
  vtid: 'VTID-04100',
  planMarkdown: '# Plan\nDo the thing.',
  filesReferenced: ['services/gateway/src/x.ts', 'services/gateway/test/x.test.ts'],
  requestedBy: 'operator-chat:thread-1',
};

describe('triggerOperatorExecution (VTID-03820)', () => {
  const ORIGINAL_ENV = process.env;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_EXECUTION_ONRAMP_ENABLED: 'true' };
    mockedGetSupabase.mockReset().mockReturnValue({ url: 'https://test.supabase.co', key: 'test-key' });
    mockedSupa.mockReset();
    mockedApprove.mockReset();
    mockedEmit.mockReset().mockResolvedValue({ ok: true });
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    global.fetch = originalFetch;
  });

  it('rejects when the kill switch is not "true" (default OFF)', async () => {
    delete process.env.OPERATOR_EXECUTION_ONRAMP_ENABLED;
    const result = await triggerOperatorExecution(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/operator_execution_onramp_disabled/);
    expect(mockedGetSupabase).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary non-"true" value the same as unset', async () => {
    process.env.OPERATOR_EXECUTION_ONRAMP_ENABLED = 'yes';
    const result = await triggerOperatorExecution(VALID_INPUT);
    expect(result.ok).toBe(false);
  });

  it('rejects when Supabase is not configured', async () => {
    mockedGetSupabase.mockReturnValue(null);
    const result = await triggerOperatorExecution(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('supabase_not_configured');
  });

  it('rejects empty planMarkdown without touching the DB', async () => {
    const result = await triggerOperatorExecution({ ...VALID_INPUT, planMarkdown: '  ' });
    expect(result.ok).toBe(false);
    expect(mockedSupa).not.toHaveBeenCalled();
  });

  it('rejects an empty filesReferenced list without touching the DB', async () => {
    const result = await triggerOperatorExecution({ ...VALID_INPUT, filesReferenced: [] });
    expect(result.ok).toBe(false);
    expect(mockedSupa).not.toHaveBeenCalled();
  });

  it('rejects when the target VTID is not found', async () => {
    mockedSupa.mockResolvedValue({ ok: true, data: [] });
    const result = await triggerOperatorExecution(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the target VTID is already terminal', async () => {
    mockedSupa.mockResolvedValue({ ok: true, data: [{ spec_status: 'approved', is_terminal: true }] });
    const result = await triggerOperatorExecution(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already terminal/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the target VTID is not spec_status=approved', async () => {
    mockedSupa.mockResolvedValue({ ok: true, data: [{ spec_status: 'draft', is_terminal: false }] });
    const result = await triggerOperatorExecution(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not 'approved'/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the recommendation + plan rows, calls approveAutoExecute, and stamps the DeepSeek override on success', async () => {
    mockedSupa
      .mockResolvedValueOnce({ ok: true, data: [{ spec_status: 'approved', is_terminal: false }] }) // governance read
      .mockResolvedValueOnce({ ok: true, data: [] }); // final metadata PATCH (via supa)
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/rest/v1/autopilot_recommendations')) {
        return Promise.resolve(jsonRes(201, [{ id: 'finding-123' }]));
      }
      if (url.includes('/rest/v1/dev_autopilot_plan_versions')) {
        return Promise.resolve(jsonRes(201, null));
      }
      return Promise.resolve(jsonRes(404, { error: 'unexpected url' }));
    });
    mockedApprove.mockResolvedValue({ ok: true, execution: { id: 'exec-456' } });

    const result = await triggerOperatorExecution(VALID_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.execution_id).toBe('exec-456');
      expect(result.finding_id).toBe('finding-123');
    }
    expect(mockedApprove).toHaveBeenCalledWith({ finding_id: 'finding-123', approved_by: VALID_INPUT.requestedBy });

    // The recommendation insert used the new operator_onramp source_type.
    const recCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('autopilot_recommendations'));
    expect(recCall).toBeDefined();
    const recBody = JSON.parse((recCall![1] as any).body);
    expect(recBody.source_type).toBe('operator_onramp');
    expect(recBody.activated_vtid).toBe(VALID_INPUT.vtid);

    // The final PATCH (via the mocked `supa` helper) stamped the override
    // and fast-forwarded execute_after in ONE call.
    const patchCall = mockedSupa.mock.calls.find((c) => String(c[1]).includes('dev_autopilot_executions?id=eq.exec-456'));
    expect(patchCall).toBeDefined();
    const patchInit = patchCall![2];
    expect(patchInit.method).toBe('PATCH');
    const patchBody = JSON.parse(patchInit.body);
    expect(patchBody.metadata.llm_on_ramp).toBe('deepseek');
    expect(patchBody.metadata.llm_on_ramp_override).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(typeof patchBody.execute_after).toBe('string');

    expect(mockedEmit).toHaveBeenCalled();
  });

  it('surfaces a safety-gate rejection from approveAutoExecute without stamping anything', async () => {
    mockedSupa.mockResolvedValueOnce({ ok: true, data: [{ spec_status: 'approved', is_terminal: false }] });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/rest/v1/autopilot_recommendations')) {
        return Promise.resolve(jsonRes(201, [{ id: 'finding-789' }]));
      }
      if (url.includes('/rest/v1/dev_autopilot_plan_versions')) {
        return Promise.resolve(jsonRes(201, null));
      }
      return Promise.resolve(jsonRes(404, { error: 'unexpected url' }));
    });
    mockedApprove.mockResolvedValue({
      ok: false,
      error: 'approval failed',
      decision: { ok: false, violations: [{ rule: 'tests_missing', message: 'no test file' }] },
    });

    const result = await triggerOperatorExecution(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('approval failed');
      expect(result.violations).toEqual([{ rule: 'tests_missing', message: 'no test file' }]);
    }
    // No PATCH call happens — approveAutoExecute itself never created an
    // execution row for `supa` to patch.
    expect(mockedSupa).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('dev_autopilot_executions'),
      expect.anything()
    );
  });
});

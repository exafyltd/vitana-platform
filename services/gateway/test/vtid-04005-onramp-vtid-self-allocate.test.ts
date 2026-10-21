/**
 * VTID-04005: on-ramp VTID self-allocation — server-side capability, gated
 * on OPERATOR_VTID_SELF_ALLOCATE_ENABLED (default OFF).
 *
 * The operator tool contract (`autopilot_execute_task`) still REQUIRES a
 * vtid in this PR; these tests pin what the on-ramp does when a caller ever
 * omits one, so wiring the tool later cannot silently change semantics.
 */

jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return { ...actual, getSupabase: jest.fn(), supa: jest.fn(), approveAutoExecute: jest.fn() };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import {
  triggerOperatorExecution,
  deriveVtidTitleFromPlan,
  isVtidSelfAllocateEnabled,
} from '../src/services/operator-execution-onramp';
import { getSupabase, supa, approveAutoExecute } from '../src/services/dev-autopilot-execute';

const mockedGetSupabase = getSupabase as jest.Mock;
const mockedSupa = supa as jest.Mock;
const mockedApprove = approveAutoExecute as jest.Mock;

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body } as any;
}

const NO_VTID_INPUT = {
  planMarkdown: '# Name failing checks in the CI failure reason\n\nReplace the ternary.',
  filesReferenced: ['services/gateway/src/services/x.ts', 'services/gateway/test/x.test.ts'],
  requestedBy: 'operator-chat:thread-9',
};

describe('VTID-04005 deriveVtidTitleFromPlan', () => {
  it('uses the explicit title when given', () => {
    expect(deriveVtidTitleFromPlan('# ignored', 'Fix the watcher')).toBe('Operator: Fix the watcher');
  });
  it('falls back to the first non-empty plan line, stripped of markdown', () => {
    expect(deriveVtidTitleFromPlan('\n\n## **Name** failing `checks`\nmore')).toBe('Operator: Name failing checks');
  });
  it('does not double-prefix and caps length', () => {
    expect(deriveVtidTitleFromPlan('Operator on-ramp: thing')).toBe('Operator on-ramp: thing');
    expect(deriveVtidTitleFromPlan('x'.repeat(500)).length).toBeLessThanOrEqual(150);
  });
});

describe('VTID-04005 triggerOperatorExecution without a vtid', () => {
  const ORIGINAL_ENV = process.env;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_EXECUTION_ONRAMP_ENABLED: 'true' };
    delete process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED;
    mockedGetSupabase.mockReset().mockReturnValue({ url: 'https://test.supabase.co', key: 'k' });
    mockedSupa.mockReset();
    mockedApprove.mockReset();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = originalFetch; });

  it('is OFF by default and rejects a missing vtid without allocating anything', async () => {
    expect(isVtidSelfAllocateEnabled()).toBe(false);
    const r = await triggerOperatorExecution(NO_VTID_INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/vtid is required/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedSupa).not.toHaveBeenCalled();
  });

  it('with the flag on: allocates via allocate_global_vtid, registers approved/in_progress, then runs the normal gates', async () => {
    process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED = 'true';
    fetchMock.mockImplementation((url: string, init?: { body?: string }) => {
      if (url.endsWith('/rest/v1/rpc/allocate_global_vtid')) {
        expect(JSON.parse(init!.body!)).toEqual({ p_source: 'operator-console', p_layer: 'DEV', p_module: 'operator-onramp' });
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-04123', num: 4123, id: 'row-1' }]));
      }
      if (url.includes('/rest/v1/autopilot_recommendations')) return Promise.resolve(jsonRes(201, [{ id: 'finding-1' }]));
      if (url.includes('/rest/v1/dev_autopilot_plan_versions')) return Promise.resolve(jsonRes(201, null));
      return Promise.resolve(jsonRes(404, { error: `unexpected ${url}` }));
    });
    mockedSupa
      .mockResolvedValueOnce({ ok: true })                                                            // ledger registration PATCH
      .mockResolvedValueOnce({ ok: true, data: [{ spec_status: 'approved', is_terminal: false }] })   // governance re-read
      .mockResolvedValue({ ok: true, data: [] });                                                      // later PATCHes
    mockedApprove.mockResolvedValue({ ok: true, execution: { id: 'exec-1' } });

    const r = await triggerOperatorExecution(NO_VTID_INPUT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.vtid).toBe('VTID-04123');
      expect(r.vtid_allocated).toBe(true);
      expect(r.execution_id).toBe('exec-1');
    }
    // Registration PATCH shape — the §4.1 follow-up, with a real title.
    const [, path, opts] = mockedSupa.mock.calls[0];
    expect(path).toBe('/rest/v1/vtid_ledger?vtid=eq.VTID-04123');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ status: 'in_progress', spec_status: 'approved', title: 'Operator: Name failing checks in the CI failure reason' });
    expect(body.metadata).toMatchObject({ source: 'operator-onramp', requested_by: 'operator-chat:thread-9' });
    // The recommendation was linked to the allocated VTID, not a placeholder.
    const recCall = fetchMock.mock.calls.find(([u]) => String(u).includes('autopilot_recommendations'));
    expect(JSON.parse(recCall![1].body).activated_vtid).toBe('VTID-04123');
  });

  it('refuses when the allocator RPC fails — never runs ungoverned', async () => {
    process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED = 'true';
    fetchMock.mockResolvedValue(jsonRes(500, { error: 'allocator disabled' }));
    const r = await triggerOperatorExecution(NO_VTID_INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/vtid_allocation_failed/);
    expect(mockedApprove).not.toHaveBeenCalled();
  });

  it('refuses when the ledger registration PATCH fails (allocated but not approved)', async () => {
    process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED = 'true';
    fetchMock.mockResolvedValue(jsonRes(200, [{ vtid: 'VTID-04124' }]));
    mockedSupa.mockResolvedValueOnce({ ok: false, error: 'RLS' });
    const r = await triggerOperatorExecution(NO_VTID_INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/vtid_registration_failed for VTID-04124/);
    expect(mockedApprove).not.toHaveBeenCalled();
  });

  it('a caller-supplied vtid is used verbatim and reported as not allocated', async () => {
    process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED = 'true';
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/rest/v1/autopilot_recommendations')) return Promise.resolve(jsonRes(201, [{ id: 'f' }]));
      if (url.includes('/rest/v1/dev_autopilot_plan_versions')) return Promise.resolve(jsonRes(201, null));
      return Promise.resolve(jsonRes(404, {}));
    });
    mockedSupa.mockResolvedValueOnce({ ok: true, data: [{ spec_status: 'approved', is_terminal: false }] }).mockResolvedValue({ ok: true, data: [] });
    mockedApprove.mockResolvedValue({ ok: true, execution: { id: 'exec-2' } });
    const r = await triggerOperatorExecution({ ...NO_VTID_INPUT, vtid: 'VTID-04100' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.vtid).toBe('VTID-04100'); expect(r.vtid_allocated).toBe(false); }
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('allocate_global_vtid'))).toBe(false);
  });
});

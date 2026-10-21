/**
 * VTID-04193: pins the ACTUAL failure behaviour of the on-ramp's VTID
 * self-allocation path (`allocateAndRegisterVtid` in
 * operator-execution-onramp.ts, gated on OPERATOR_VTID_SELF_ALLOCATE_ENABLED)
 * — see that function's JSDoc for the three documented outcomes.
 *
 * Summary of what these tests lock down:
 *   - RPC failure / malformed RPC response → clean refusal, no ledger row
 *     written, no execution. Nothing is left behind.
 *   - the follow-up registration PATCH failing → the allocator's shell row
 *     stays behind (PARTIAL/ORPHANED allocation). That is real, undocumented
 *     before now, and this test proves both halves: (a) the caller still gets
 *     a clean `{ ok: false }` with no execution, and (b) no compensating
 *     cleanup is attempted, so the orphan is genuinely left for manual
 *     cleanup.
 *   - a thrown (not `ok: false`) registration failure → same outer catch,
 *     misleadingly reported under the `vtid_allocation_failed` label, but
 *     still no execution.
 *   - in every failure case the function never returns a VTID.
 */

jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return { ...actual, getSupabase: jest.fn(), supa: jest.fn(), approveAutoExecute: jest.fn() };
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

const NO_VTID_INPUT = {
  planMarkdown: '# Document the self-allocation failure mode\n\nPin the real behaviour.',
  filesReferenced: ['services/gateway/src/services/x.ts', 'services/gateway/test/x.test.ts'],
  requestedBy: 'operator-chat:thread-29',
};

/** True when any `supa()` call was a DELETE (i.e. an attempted cleanup/rollback). */
function attemptedCleanupDelete(): boolean {
  return mockedSupa.mock.calls.some((c) => (c[2] as { method?: string } | undefined)?.method === 'DELETE');
}

describe('VTID-04193 on-ramp self-allocation failure modes', () => {
  const ORIGINAL_ENV = process.env;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      OPERATOR_EXECUTION_ONRAMP_ENABLED: 'true',
      OPERATOR_VTID_SELF_ALLOCATE_ENABLED: 'true',
    };
    mockedGetSupabase.mockReset().mockReturnValue({ url: 'https://test.supabase.co', key: 'k' });
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

  it('clean refusal when the allocator RPC itself fails: no ledger row attempted, no execution', async () => {
    fetchMock.mockResolvedValue(jsonRes(500, { error: 'allocator unavailable' }));

    const r = await triggerOperatorExecution(NO_VTID_INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^vtid_allocation_failed:/);
    // The RPC is the ONLY network call — nothing downstream was reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/v1/rpc/allocate_global_vtid');
    // No registration PATCH, no cleanup DELETE, no recommendation/plan rows.
    expect(mockedSupa).not.toHaveBeenCalled();
    expect(mockedApprove).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty('vtid');
  });

  it('clean refusal when the allocator returns a 2xx body with no usable VTID (nothing was inserted)', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, [{ num: 4193, id: 'row-x' }]));

    const r = await triggerOperatorExecution(NO_VTID_INPUT);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('vtid_allocation_failed: allocator returned no VTID');
    // A malformed body means the RPC returned but the VTID check bailed before
    // any PATCH — so there is nothing to leave behind.
    expect(mockedSupa).not.toHaveBeenCalled();
    expect(mockedApprove).not.toHaveBeenCalled();
  });

  it('registers nothing further, but LEAVES the allocated shell row, when the registration PATCH fails (documented orphan)', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, [{ vtid: 'VTID-04193', num: 4193, id: 'row-1' }]));
    // The `patch.ok === false` branch — allocated, but not registered approved.
    mockedSupa.mockResolvedValueOnce({ ok: false, error: 'RLS denied' });

    const r = await triggerOperatorExecution(NO_VTID_INPUT);

    // (a) The caller still refuses cleanly — no execution, no approval, no event.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('vtid_registration_failed for VTID-04193: RLS denied');
    expect(r).not.toHaveProperty('vtid');
    expect(mockedApprove).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalled();
    // The governance re-read and every downstream insert are skipped, so the
    // orphan can never be executed against by THIS call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/v1/rpc/allocate_global_vtid');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('autopilot_recommendations'))).toBe(false);

    // (b) The orphan is real and NOT cleaned up: the RPC already inserted a
    // `status='allocated'` shell row server-side, and this code path issues no
    // compensating DELETE — that is the documented gap, pinned here so it
    // cannot silently change (in either direction) without a test update.
    expect(mockedSupa).toHaveBeenCalledTimes(1);
    const [, patchPath, patchOpts] = mockedSupa.mock.calls[0];
    expect(patchPath).toBe('/rest/v1/vtid_ledger?vtid=eq.VTID-04193');
    expect((patchOpts as { method?: string }).method).toBe('PATCH');
    expect(attemptedCleanupDelete()).toBe(false);
  });

  it('reports a THROWN registration failure under the allocation-failure label (same outer catch, orphan still possible)', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, [{ vtid: 'VTID-04194', num: 4194, id: 'row-2' }]));
    mockedSupa.mockRejectedValueOnce(new Error('supabase blip'));

    const r = await triggerOperatorExecution(NO_VTID_INPUT);

    expect(r.ok).toBe(false);
    // Misleading for a reader, but this IS the implemented behaviour: the
    // catch() wrapper covers the PATCH too, so a minted-then-unregistered
    // VTID is reported as an allocation failure. See the JSDoc case 3.
    if (!r.ok) expect(r.error).toBe('vtid_allocation_failed: supabase blip');
    expect(r).not.toHaveProperty('vtid');
    expect(mockedApprove).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalled();
    expect(attemptedCleanupDelete()).toBe(false);
  });
});

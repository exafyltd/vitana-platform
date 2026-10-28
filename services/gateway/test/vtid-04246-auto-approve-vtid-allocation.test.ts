/**
 * VTID-04246 — every auto-approved Dev Autopilot finding gets a real VTID
 * before its execution exists, so the PR contract applies and the PR is
 * not born with the `VTID-DA-<exec8>` placeholder VALIDATOR-CHECK rejects.
 */
import * as fs from 'fs';
import * as path from 'path';
import { allocateAndRegisterFindingVtid, buildFindingVtidTitle } from '../src/services/dev-autopilot-vtid-allocate';

const S = { url: 'https://test.supabase.co', key: 'service_role_key' };

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
}

describe('VTID-04246 allocateAndRegisterFindingVtid', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock as unknown as typeof fetch; });
  afterAll(() => { global.fetch = originalFetch; });

  it('mints via allocate_global_vtid, registers the ledger row approved/in_progress, stamps the finding', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, [{ vtid: 'VTID-04299', num: 4299 }]))
      .mockResolvedValueOnce(res(204, ''))
      .mockResolvedValueOnce(res(204, ''));
    const r = await allocateAndRegisterFindingVtid(S, { findingId: 'f1f2f3f4-0000-0000-0000-000000000000', title: 'T', summary: 'S', scanner: 'todo-scanner-v1' });
    expect(r).toEqual({ ok: true, vtid: 'VTID-04299' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [rpcUrl, rpcInit] = fetchMock.mock.calls[0];
    expect(String(rpcUrl)).toBe(`${S.url}/rest/v1/rpc/allocate_global_vtid`);
    expect(JSON.parse(String(rpcInit.body))).toEqual({ p_source: 'dev-autopilot', p_layer: 'DEV', p_module: 'auto-approve' });

    const [ledgerUrl, ledgerInit] = fetchMock.mock.calls[1];
    expect(String(ledgerUrl)).toBe(`${S.url}/rest/v1/vtid_ledger?vtid=eq.VTID-04299`);
    expect(ledgerInit.method).toBe('PATCH');
    const ledgerBody = JSON.parse(String(ledgerInit.body));
    expect(ledgerBody).toMatchObject({ title: 'T', summary: 'S', status: 'in_progress', spec_status: 'approved' });
    expect(ledgerBody.metadata).toMatchObject({ source: 'dev-autopilot-auto-approve', finding_id: 'f1f2f3f4-0000-0000-0000-000000000000', scanner: 'todo-scanner-v1' });
    // Never the worker-runner's claim allowlist flag (VTID-03516).
    expect(ledgerBody.metadata.autonomous_execution).toBeUndefined();

    const [findingUrl, findingInit] = fetchMock.mock.calls[2];
    expect(String(findingUrl)).toBe(`${S.url}/rest/v1/autopilot_recommendations?id=eq.f1f2f3f4-0000-0000-0000-000000000000&activated_vtid=is.null`);
    const findingBody = JSON.parse(String(findingInit.body));
    expect(findingBody.activated_vtid).toBe('VTID-04299');
    expect(typeof findingBody.activated_at).toBe('string');
    // status is NOT touched — the reaper selects status=eq.activated and
    // approveAutoExecute requires status 'new'.
    expect(findingBody.status).toBeUndefined();
  });

  it('refuses when the allocator fails or returns no usable VTID, and issues no PATCH', async () => {
    fetchMock.mockResolvedValueOnce(res(500, 'boom'));
    const a = await allocateAndRegisterFindingVtid(S, { findingId: 'f', title: 'T', summary: 'S', scanner: null });
    expect(a.ok).toBe(false);
    expect((a as { error: string }).error).toMatch(/vtid_allocation_failed: 500/);
    fetchMock.mockResolvedValueOnce(res(200, [{ vtid: 'nope' }]));
    const b = await allocateAndRegisterFindingVtid(S, { findingId: 'f', title: 'T', summary: 'S', scanner: null });
    expect(b.ok).toBe(false);
    expect((b as { error: string }).error).toMatch(/allocator returned no VTID/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses (without stamping the finding) when the ledger registration fails', async () => {
    fetchMock.mockResolvedValueOnce(res(200, [{ vtid: 'VTID-04300' }])).mockResolvedValueOnce(res(403, 'denied'));
    const r = await allocateAndRegisterFindingVtid(S, { findingId: 'f', title: 'T', summary: 'S', scanner: null });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/vtid_registration_failed for VTID-04300/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses when the finding stamp fails, naming the VTID that was minted', async () => {
    fetchMock.mockResolvedValueOnce(res(200, [{ vtid: 'VTID-04301' }])).mockResolvedValueOnce(res(204, '')).mockResolvedValueOnce(res(409, 'conflict'));
    const r = await allocateAndRegisterFindingVtid(S, { findingId: 'f', title: 'T', summary: 'S', scanner: null });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/finding_stamp_failed for VTID-04301/);
  });

  it('a thrown fetch is a clean refusal', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const r = await allocateAndRegisterFindingVtid(S, { findingId: 'f', title: 'T', summary: 'S', scanner: null });
    expect(r).toEqual({ ok: false, error: 'vtid_allocation_failed: ECONNRESET' });
  });
});

describe('VTID-04246 buildFindingVtidTitle', () => {
  it('uses the finding title when present, else a stable fallback, always prefixed with the scanner', () => {
    expect(buildFindingVtidTitle({ title: '  Fix   the thing ' }, 'abcdef12-x', 'todo-scanner-v1')).toBe('Dev Autopilot (todo-scanner-v1): Fix the thing');
    expect(buildFindingVtidTitle({ summary: 'summary only' }, 'abcdef12-x', null)).toBe('Dev Autopilot (auto-approve): summary only');
    expect(buildFindingVtidTitle(null, 'abcdef12-x', 'npm-audit-scanner-v1')).toBe('Dev Autopilot (npm-audit-scanner-v1): Dev Autopilot finding abcdef12');
    expect(buildFindingVtidTitle({ title: 'x'.repeat(400) }, 'a', null).length).toBe(200);
  });
});

describe('VTID-04246 autoApproveTick wiring (source contract)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');

  it('selects activated_vtid for both auto-approve passes', () => {
    expect(src).toMatch(/&select=id,risk_class,effort_score,impact_score,spec_snapshot,activated_vtid`/);
    expect(src.match(/spec_snapshot,activated_vtid`/g)?.length).toBe(2);
  });

  it('ensures a VTID immediately before every approveAutoExecute call the tick makes', () => {
    const approves = src.match(/const result = await approveAutoExecute\(\{ finding_id: f\.id \}\);/g) || [];
    expect(approves.length).toBe(2);
    const ensured = src.match(/if \(!\(await ensureFindingVtid\(s, f\)\)\) continue;\n\s*const result = await approveAutoExecute\(\{ finding_id: f\.id \}\);/g) || [];
    expect(ensured.length).toBe(2);
  });

  it('ensureFindingVtid allocates only when the finding has none and skips the approval on failure', () => {
    const body = src.slice(src.indexOf('async function ensureFindingVtid('), src.indexOf('export async function autoApproveTick('));
    expect(body).toMatch(/if \(f\.activated_vtid\) return true;/);
    expect(body).toMatch(/allocateAndRegisterFindingVtid\(s, \{/);
    expect(body).toMatch(/if \(!alloc\.ok\) \{[\s\S]*return false;/);
    expect(body).toMatch(/f\.activated_vtid = alloc\.vtid;/);
  });
});

/**
 * VTID-04279 — services/approvals-service.ts.
 *
 * This logic used to live inline in routes/approvals.ts's handlers, which
 * had no dedicated test file at all before this VTID (confirmed: no
 * test/routes/approvals.test.ts existed until this same PR added one).
 * Extracted so it's callable in-process (services/gemini-operator.ts) as
 * well as from the now-auth-gated HTTP route — see that file's own header
 * for why. These tests exercise the extracted functions directly against a
 * mocked global.fetch (the same style test/orb-tools/developer-tools.test.ts
 * already uses for the approvals self-call), independent of Express.
 */
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' }),
}));

import { emitOasisEvent } from '../../src/services/oasis-event-service';
import {
  getPendingApprovalCount,
  getPendingApprovals,
  approveApprovalById,
  rejectApprovalById,
} from '../../src/services/approvals-service';

const ORIGINAL_ENV = { ...process.env };
const realFetch = global.fetch;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE: 'svc-key' };
});

afterEach(() => {
  global.fetch = realFetch;
  process.env = ORIGINAL_ENV;
  jest.clearAllMocks();
});

function mockFetchSequence(...responses: Array<{ status: number; body: unknown }>): jest.Mock {
  const fn = jest.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(JSON.stringify(r.body)),
    });
  }
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const vtidRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  vtid: 'VTID-02700',
  title: 'Fix voice quota guard',
  description: null,
  status: 'in_progress',
  layer: 'DEV',
  module: 'orb',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const prEvent = (vtid: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'e-1',
  created_at: '2026-01-01T00:00:00Z',
  vtid,
  topic: 'cicd.github.create_pr.succeeded',
  status: 'success',
  message: 'PR created',
  metadata: { pr_number: 2311, head_branch: 'claude/fix-quota', ...overrides },
});

describe('getPendingApprovalCount', () => {
  it('returns 500 when Supabase env is not configured', async () => {
    delete process.env.SUPABASE_URL;
    const { status, body } = await getPendingApprovalCount();
    expect(status).toBe(500);
    expect(body.ok).toBe(false);
  });

  it('counts only VTIDs with PR/branch info', async () => {
    mockFetchSequence(
      { status: 200, body: [vtidRow(), vtidRow({ vtid: 'VTID-02701' })] },
      { status: 200, body: [prEvent('VTID-02700')] } // only 02700 has PR info
    );
    const { status, body } = await getPendingApprovalCount();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, pending_count: 1 });
  });
});

describe('getPendingApprovals', () => {
  it('builds ApprovalItems for VTIDs with PR/branch references, respecting limit', async () => {
    mockFetchSequence(
      { status: 200, body: [vtidRow()] },
      { status: 200, body: [prEvent('VTID-02700')] },
      { status: 200, body: [] } // checks status query
    );
    const { status, body } = await getPendingApprovals(50);
    expect(status).toBe(200);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ vtid: 'VTID-02700', pr_number: 2311, head_branch: 'claude/fix-quota' });
  });

  it('returns an empty list, not an error, when there are no eligible VTIDs', async () => {
    mockFetchSequence({ status: 200, body: [] });
    const { status, body } = await getPendingApprovals(50);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, items: [] });
  });
});

describe('approveApprovalById', () => {
  it('rejects a malformed approval_id before touching the network', async () => {
    const fetchFn = mockFetchSequence();
    const { status, body } = await approveApprovalById('not-a-real-id', 'admin-1');
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('404s when the VTID is not in the ledger', async () => {
    mockFetchSequence({ status: 200, body: [] });
    const { status, body } = await approveApprovalById('appr_VTID-02700_abcdef', 'admin-1');
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it('refuses to re-approve a VTID already in a terminal status', async () => {
    mockFetchSequence({ status: 200, body: [vtidRow({ status: 'completed' })] });
    const { status, body } = await approveApprovalById('appr_VTID-02700_abcdef', 'admin-1');
    expect(status).toBe(400);
    expect(String(body.error)).toContain('terminal status');
  });

  it('requires a branch/PR reference before calling the merge endpoint', async () => {
    mockFetchSequence(
      { status: 200, body: [vtidRow()] },
      { status: 200, body: [] } // no PR event -> no head_branch
    );
    const { status, body } = await approveApprovalById('appr_VTID-02700_abcdef', 'admin-1');
    expect(status).toBe(400);
    expect(String(body.error)).toContain('No branch/PR info');
  });

  it('calls autonomous-pr-merge and returns merged:true on success, recording the verified decider — never a client-suppliable value', async () => {
    mockFetchSequence(
      { status: 200, body: [vtidRow()] },
      { status: 200, body: [prEvent('VTID-02700')] },
      { status: 200, body: { ok: true, merged: true } } // autonomous-pr-merge
    );
    const { status, body } = await approveApprovalById('appr_VTID-02700_abcdef', 'admin-99');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, result: { ok: true, merged: true } });
    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        vtid: 'VTID-02700',
        type: 'cicd.approval.approved',
        payload: expect.objectContaining({ decided_by: 'admin-99' }),
      })
    );
  });

  it('propagates a failed merge without throwing', async () => {
    mockFetchSequence(
      { status: 200, body: [vtidRow()] },
      { status: 200, body: [prEvent('VTID-02700')] },
      { status: 400, body: { ok: false, error: 'Cannot approve: CI is fail' } }
    );
    const { status, body } = await approveApprovalById('appr_VTID-02700_abcdef', 'admin-1');
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain('CI is fail');
  });
});

describe('rejectApprovalById', () => {
  it('rejects a malformed approval_id before touching the network', async () => {
    const fetchFn = mockFetchSequence();
    const { status } = await rejectApprovalById('not-a-real-id', 'reason', 'admin-1');
    expect(status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('404s when the VTID is not in the ledger', async () => {
    mockFetchSequence({ status: 200, body: [] });
    const { status } = await rejectApprovalById('appr_VTID-02700_abcdef', 'reason', 'admin-1');
    expect(status).toBe(404);
  });

  it('records the rejection and returns ok:true, with the verified decider on the audit event', async () => {
    mockFetchSequence({ status: 200, body: [vtidRow()] });
    const { status, body } = await rejectApprovalById('appr_VTID-02700_abcdef', 'not ready', 'admin-1');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        vtid: 'VTID-02700',
        type: 'cicd.approval.denied',
        payload: expect.objectContaining({ decided_by: 'admin-1', reason: 'not ready' }),
      })
    );
  });
});

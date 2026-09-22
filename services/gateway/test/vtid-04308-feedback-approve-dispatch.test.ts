/**
 * VTID-04308 — "Approve & Fix" dispatches a feedback ticket, every dispatched
 * ticket gets a real VTID (feedback_tickets.linked_vtid + finding
 * activated_vtid), and the feedback lane no longer bypasses the kill switch.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockBridge = jest.fn();
jest.mock('../src/services/dev-autopilot-execute', () => ({
  bridgeActivationToExecution: (...a: unknown[]) => mockBridge(...a),
}));
const mockAlloc = jest.fn();
jest.mock('../src/services/dev-autopilot-vtid-allocate', () => ({
  allocateAndRegisterFindingVtid: (...a: unknown[]) => mockAlloc(...a),
}));

import { approveAndDispatchTicket } from '../src/services/feedback-execution-bridge';
import { evaluateSafetyGate } from '../src/services/dev-autopilot-safety';

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let ticketRow: Record<string, unknown>;
let findingVtid: string | null;

function json(v: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) } as any;
}

beforeEach(() => {
  calls = [];
  mockBridge.mockReset();
  mockAlloc.mockReset();
  findingVtid = null;
  process.env.SUPABASE_URL = 'https://sb.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
  ticketRow = {
    id: 'tk-1', ticket_number: 'FB-1', kind: 'bug', status: 'spec_ready',
    spec_md: '## Problem\nButton broken', supervisor_notes: null, raw_transcript: 'it is broken',
    vitana_id: 'VIT-1', screen_path: '/x', app_version: '1', linked_finding_id: 'rec-1',
  };
  (global as any).fetch = jest.fn(async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (method === 'GET' && url.includes('/feedback_tickets?')) return json([ticketRow]);
    if (method === 'GET' && url.includes('select=activated_vtid')) return json([{ activated_vtid: findingVtid }]);
    if (method === 'GET' && url.includes('/autopilot_recommendations?id=eq.rec-1')) return json([{ id: 'rec-1' }]);
    if (method === 'PATCH' && url.includes('status=eq.spec_ready')) return json([{ ...ticketRow, status: 'in_progress' }]);
    return json([]);
  });
});

describe('approveAndDispatchTicket', () => {
  it('allocates a VTID, links it on the ticket, dispatches, then moves to in_progress', async () => {
    mockAlloc.mockResolvedValueOnce({ ok: true, vtid: 'VTID-09001' });
    mockBridge.mockResolvedValueOnce({ ok: true, execution_id: 'ex-1' });

    const r = await approveAndDispatchTicket('tk-1', 'admin-1');

    expect(r.ok).toBe(true);
    expect(r.vtid).toBe('VTID-09001');
    expect(r.execution_id).toBe('ex-1');
    expect(mockAlloc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      findingId: 'rec-1', source: 'feedback-ticket', module: 'feedback-ticket',
    }));
    const linkVtid = calls.find(c => c.method === 'PATCH' && c.body?.linked_vtid);
    expect(linkVtid?.body).toEqual({ linked_vtid: 'VTID-09001' });
    const toProgress = calls.find(c => c.method === 'PATCH' && c.url.includes('status=eq.spec_ready'));
    expect(toProgress?.body).toEqual({ status: 'in_progress', linked_finding_id: 'rec-1' });
    // VTID is allocated BEFORE the execution exists.
    expect(mockAlloc.mock.invocationCallOrder[0]).toBeLessThan(mockBridge.mock.invocationCallOrder[0]);
  });

  it('reuses a VTID the finding already carries', async () => {
    findingVtid = 'VTID-08888';
    mockBridge.mockResolvedValueOnce({ ok: true, execution_id: 'ex-2' });
    const r = await approveAndDispatchTicket('tk-1', 'admin-1');
    expect(r.vtid).toBe('VTID-08888');
    expect(mockAlloc).not.toHaveBeenCalled();
  });

  it('refuses to dispatch when VTID allocation fails, and leaves the ticket at spec_ready', async () => {
    mockAlloc.mockResolvedValueOnce({ ok: false, error: 'vtid_allocation_failed: 500' });
    const r = await approveAndDispatchTicket('tk-1', 'admin-1');
    expect(r.ok).toBe(false);
    expect(r.violations?.[0]?.code).toBe('vtid_allocation_failed');
    expect(mockBridge).not.toHaveBeenCalled();
    expect(calls.some(c => c.url.includes('status=eq.spec_ready'))).toBe(false);
  });

  it('leaves the ticket at spec_ready when the bridge refuses (e.g. kill switch)', async () => {
    mockAlloc.mockResolvedValueOnce({ ok: true, vtid: 'VTID-09002' });
    mockBridge.mockResolvedValueOnce({ ok: false, error: 'kill_switch', decision: { violations: [{ code: 'kill_switch_engaged', message: 'armed' }] } });
    const r = await approveAndDispatchTicket('tk-1', 'admin-1');
    expect(r.ok).toBe(false);
    expect(r.violations?.[0]?.code).toBe('kill_switch_engaged');
    expect(calls.some(c => c.url.includes('status=eq.spec_ready'))).toBe(false);
  });

  it('refuses non-dispatchable kinds and non spec_ready tickets', async () => {
    ticketRow.kind = 'support_question';
    expect((await approveAndDispatchTicket('tk-1')).ok).toBe(false);
    ticketRow.kind = 'bug';
    ticketRow.status = 'in_progress';
    const r = await approveAndDispatchTicket('tk-1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/NOT_APPROVABLE/);
    expect(mockBridge).not.toHaveBeenCalled();
  });
});

describe('kill switch applies to the feedback lane (exemption removed)', () => {
  it('evaluateSafetyGate blocks a feedback-lane finding when the kill switch is armed', () => {
    const decision = evaluateSafetyGate(
      { risk_class: 'low', files_to_modify: ['services/gateway/src/x.ts', 'services/gateway/test/x.test.ts'], files_to_delete: [] },
      {
        config: {
          kill_switch: true, daily_budget: 100, concurrency_cap: 5, max_auto_fix_depth: 2,
          allow_scope: ['services/gateway/**'], deny_scope: [],
        } as any,
        approved_today: 0,
        auto_fix_depth: 0,
        is_feedback_lane: true,
      } as any,
    );
    expect(decision.ok).toBe(false);
    expect(decision.violations[0].code).toBe('kill_switch_engaged');
  });

  it('the executor tick no longer filters cooling rows to the feedback lane', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
    expect(src).not.toMatch(/claiming \$\{filteredRows\.length\} feedback-lane/);
    expect(src).toMatch(/if \(cfg\.kill_switch\) return;\n\n  \/\/ 2\. Concurrency cap/);
  });
});

describe('VTID-04311: a placeholder spec is never dispatched', () => {
  it('refuses with spec_placeholder before any allocation or execution', async () => {
    ticketRow.spec_md = '# Devon auto-draft spec (placeholder)\n\nUser report: x';
    const r = await approveAndDispatchTicket('tk-1', 'admin-1');
    expect(r.ok).toBe(false);
    expect(r.violations?.[0]?.code).toBe('spec_placeholder');
    expect(mockAlloc).not.toHaveBeenCalled();
    expect(mockBridge).not.toHaveBeenCalled();
  });
});

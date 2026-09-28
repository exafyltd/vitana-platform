/**
 * VTID-04333 — the dispatch bridge carries the ticket number and the ticket
 * VTID on its OASIS event and on the recommendation; the admin APIs expose the
 * chain (linked_* + latest_execution + feedback_ticket).
 */
import * as fs from 'fs';
import * as path from 'path';

const mockBridge = jest.fn();
jest.mock('../src/services/dev-autopilot-execute', () => ({
  bridgeActivationToExecution: (...a: unknown[]) => mockBridge(...a),
  isUuidString: jest.requireActual('../src/services/dev-autopilot-execute').isUuidString,
}));
const mockAlloc = jest.fn();
jest.mock('../src/services/dev-autopilot-vtid-allocate', () => ({
  allocateAndRegisterFindingVtid: (...a: unknown[]) => mockAlloc(...a),
}));
const mockEmit = jest.fn();
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...a: unknown[]) => { mockEmit(...a); return Promise.resolve({ ok: true }); },
}));

import { approveAndDispatchTicket, AUTO_DISPATCH_ACTOR } from '../src/services/feedback-execution-bridge';
import { attachLatestExecutions, summarizeExecution } from '../src/services/feedback-ticket-ref';

type Call = { url: string; method: string; body: any };
let calls: Call[];
let snapshot: Record<string, unknown>;

beforeEach(() => {
  calls = [];
  mockBridge.mockReset();
  mockAlloc.mockReset();
  mockEmit.mockReset();
  process.env.SUPABASE_URL = 'https://sb.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
  snapshot = { scanner: 'feedback_pipeline', feedback: { ticket_id: 'tk-1', ticket_number: 'FB-2026-09-000777', linked_vtid: null } };
  const ticketRow = {
    id: 'tk-1', ticket_number: 'FB-2026-09-000777', kind: 'bug', status: 'spec_ready',
    spec_md: '## Problem\nButton broken', supervisor_notes: null, raw_transcript: 'broken',
    vitana_id: 'VIT-1', screen_path: '/x', app_version: '1', linked_finding_id: 'rec-1',
  };
  (global as any).fetch = jest.fn(async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v, text: async () => '' } as any);
    if (method === 'GET' && url.includes('/feedback_tickets?')) return json([ticketRow]);
    if (method === 'GET' && url.includes('select=activated_vtid')) return json([{ activated_vtid: null, spec_snapshot: snapshot }]);
    if (method === 'GET' && url.includes('/autopilot_recommendations?id=eq.rec-1')) return json([{ id: 'rec-1' }]);
    if (method === 'PATCH' && url.includes('status=eq.spec_ready')) return json([{ ...ticketRow, status: 'in_progress' }]);
    return json([]);
  });
});

describe('dispatch carries the ticket number and VTID', () => {
  it('stamps linked_vtid + ticket_number on the recommendation feedback block', async () => {
    mockAlloc.mockResolvedValueOnce({ ok: true, vtid: 'VTID-04700' });
    mockBridge.mockResolvedValueOnce({ ok: true, execution_id: 'ex-1' });
    const r = await approveAndDispatchTicket('tk-1', 'admin-1');
    expect(r.ok).toBe(true);
    expect(r.ticket_number).toBe('FB-2026-09-000777');
    const stamp = calls.find((c) => c.method === 'PATCH' && c.url.includes('/autopilot_recommendations?id=eq.rec-1'));
    expect(stamp?.body.spec_snapshot.feedback).toMatchObject({ ticket_number: 'FB-2026-09-000777', linked_vtid: 'VTID-04700' });
    expect(stamp?.body.spec_snapshot.scanner).toBe('feedback_pipeline');
  });

  it('emits feedback.ticket.dispatched under the ticket VTID with the ticket number', async () => {
    mockAlloc.mockResolvedValueOnce({ ok: true, vtid: 'VTID-04701' });
    mockBridge.mockResolvedValueOnce({ ok: true, execution_id: 'ex-2' });
    await approveAndDispatchTicket('tk-1', AUTO_DISPATCH_ACTOR);
    const ev = mockEmit.mock.calls.map((c) => c[0]).find((e) => e.type === 'feedback.ticket.dispatched');
    expect(ev.vtid).toBe('VTID-04701');
    expect(ev.payload).toMatchObject({
      ticket_id: 'tk-1', ticket_number: 'FB-2026-09-000777', linked_vtid: 'VTID-04701',
      recommendation_id: 'rec-1', execution_id: 'ex-2', auto_dispatch: true,
    });
  });

  it('emits nothing when the bridge refuses', async () => {
    mockAlloc.mockResolvedValueOnce({ ok: true, vtid: 'VTID-04702' });
    mockBridge.mockResolvedValueOnce({ ok: false, error: 'kill_switch' });
    await approveAndDispatchTicket('tk-1', 'admin-1');
    expect(mockEmit.mock.calls.some((c) => c[0].type === 'feedback.ticket.dispatched')).toBe(false);
  });
});

describe('latest execution per ticket (admin APIs)', () => {
  it('picks the newest execution per finding and derives the stage', () => {
    const out = attachLatestExecutions(
      [{ id: 'a', linked_finding_id: 'f1' }, { id: 'b', linked_finding_id: null }, { id: 'c', linked_finding_id: 'f2' }],
      [
        { id: 'e-old', finding_id: 'f1', status: 'failed', failure_stage: 'ci', created_at: '2026-09-01T00:00:00Z' },
        { id: 'e-new', finding_id: 'f1', status: 'running', failure_stage: null, created_at: '2026-09-02T00:00:00Z', pr_url: null },
      ],
    );
    expect(out[0].latest_execution).toMatchObject({ id: 'e-new', status: 'running', stage: 'running' });
    expect(out[1].latest_execution).toBeNull();
    expect(out[2].latest_execution).toBeNull();
    expect(summarizeExecution({ id: 'x', status: 'failed', failure_stage: 'deploy' })?.stage).toBe('deploy');
  });

  it('the admin ticket selects return the linked_* columns', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/feedback-admin-repository.ts'), 'utf8');
    const selects = src.match(/'id, ticket_number, vitana_id, kind, status[^']*'/g) ?? [];
    expect(selects.length).toBe(2);
    for (const s of selects) expect(s).toMatch(/linked_vtid, linked_finding_id, linked_pr_url/);
  });

  it('the Dev Autopilot list APIs attach feedback_ticket', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/dev-autopilot.ts'), 'utf8');
    expect(src.match(/feedback_ticket[:=] /g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/select=id,title,source_type,spec_snapshot,source_ref,activated_vtid/);
  });
});

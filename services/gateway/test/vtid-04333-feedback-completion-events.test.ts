/**
 * VTID-04333 — feedback ticket completion events are filed under the ticket's
 * own VTID and carry the ticket number; the failure branch emits an event.
 */
const mockEmit = jest.fn();
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...a: unknown[]) => { mockEmit(...a); return Promise.resolve({ ok: true }); },
}));
jest.mock('../src/services/feedback-reporter-notify', () => ({ notifyFeedbackReporter: jest.fn() }));

import {
  reconcileCompletedFeedbackTickets,
  eventVtidForTicket,
  RECONCILER_FALLBACK_VTID,
} from '../src/services/feedback-completion-reconciler';

const S = { url: 'https://sb.test', key: 'svc' };
const TID = '11111111-2222-3333-4444-555555555555';
let execRow: Record<string, unknown>;
let ticketRow: Record<string, unknown>;
let patches: Array<{ url: string; body: any }>;

beforeEach(() => {
  mockEmit.mockReset();
  patches = [];
  execRow = { id: 'exec-aaaa-bbbb', finding_id: 'rec-1', status: 'completed', pr_url: 'https://gh/pr/1', failure_stage: null, completed_at: null, updated_at: 'x' };
  ticketRow = { id: TID, ticket_number: 'FB-2026-09-000321', status: 'in_progress', supervisor_notes: null, linked_vtid: 'VTID-04500' };
  (global as any).fetch = jest.fn(async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    if (method === 'PATCH') { patches.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => [] }; }
    let data: unknown = [];
    if (url.includes('/dev_autopilot_executions')) data = [execRow];
    else if (url.includes('/autopilot_recommendations')) data = [{ id: 'rec-1', source_ref: `feedback_ticket:${TID}` }];
    else if (url.includes('/feedback_tickets')) data = [ticketRow];
    return { ok: true, json: async () => data, text: async () => '' };
  });
});

describe('eventVtidForTicket', () => {
  it('uses the ticket VTID and falls back only when it is missing', () => {
    expect(eventVtidForTicket({ linked_vtid: 'VTID-04500' })).toBe('VTID-04500');
    expect(eventVtidForTicket({ linked_vtid: null })).toBe(RECONCILER_FALLBACK_VTID);
    expect(eventVtidForTicket({ linked_vtid: 'garbage' })).toBe(RECONCILER_FALLBACK_VTID);
  });
});

describe('reconcileCompletedFeedbackTickets', () => {
  it('emits feedback.ticket.resolved under the ticket VTID with the ticket number', async () => {
    const r = await reconcileCompletedFeedbackTickets(S);
    expect(r.closed).toBe(1);
    const ev = mockEmit.mock.calls.map((c) => c[0]).find((e) => e.type === 'feedback.ticket.resolved');
    expect(ev.vtid).toBe('VTID-04500');
    expect(ev.payload).toMatchObject({ ticket_id: TID, ticket_number: 'FB-2026-09-000321', linked_vtid: 'VTID-04500', execution_id: 'exec-aaaa-bbbb' });
  });

  it('falls back to the reconciler VTID when the ticket has none', async () => {
    ticketRow.linked_vtid = null;
    await reconcileCompletedFeedbackTickets(S);
    expect(mockEmit.mock.calls[0][0].vtid).toBe(RECONCILER_FALLBACK_VTID);
  });

  it('emits feedback.ticket.fix_failed on the failure branch with stage and execution', async () => {
    execRow.status = 'failed';
    execRow.failure_stage = 'ci';
    const r = await reconcileCompletedFeedbackTickets(S);
    expect(r.failed).toBe(1);
    expect(patches[0].body.status).toBe('needs_more_info');
    const ev = mockEmit.mock.calls.map((c) => c[0]).find((e) => e.type === 'feedback.ticket.fix_failed');
    expect(ev).toBeDefined();
    expect(ev.vtid).toBe('VTID-04500');
    expect(ev.status).toBe('warning');
    expect(ev.payload).toMatchObject({
      ticket_number: 'FB-2026-09-000321', execution_id: 'exec-aaaa-bbbb', execution_status: 'failed', failure_stage: 'ci',
    });
  });

  it('emits nothing for a ticket that is already terminal', async () => {
    ticketRow.status = 'resolved';
    await reconcileCompletedFeedbackTickets(S);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

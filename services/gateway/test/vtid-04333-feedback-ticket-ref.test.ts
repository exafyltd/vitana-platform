/**
 * VTID-04333 — the resolver every surface uses to link a finding back to its
 * member ticket.
 */
import { feedbackTicketRefFor, resolveFeedbackTicketRef, ticketIdFromSourceRef } from '../src/services/feedback-ticket-ref';

const TID = '11111111-2222-3333-4444-555555555555';

describe('feedbackTicketRefFor', () => {
  it('reads the ticket id from source_ref and the number/VTID from the snapshot', () => {
    expect(feedbackTicketRefFor({
      source_ref: `feedback_ticket:${TID}`,
      spec_snapshot: { feedback: { ticket_id: TID, ticket_number: 'FB-2026-09-000001', linked_vtid: 'VTID-04400' } },
      activated_vtid: 'VTID-04400',
    })).toEqual({ ticket_id: TID, ticket_number: 'FB-2026-09-000001', linked_vtid: 'VTID-04400' });
  });

  it('falls back to activated_vtid when the snapshot has no linked_vtid', () => {
    expect(feedbackTicketRefFor({
      source_ref: `feedback_ticket:${TID}`,
      spec_snapshot: { feedback: { ticket_number: 'FB-2026-09-000001' } },
      activated_vtid: 'VTID-04401',
    })?.linked_vtid).toBe('VTID-04401');
  });

  it('returns null for a non-feedback finding', () => {
    expect(feedbackTicketRefFor({ source_ref: 'scanner:x', spec_snapshot: { scanner: 'todo' } })).toBeNull();
    expect(feedbackTicketRefFor(null)).toBeNull();
    expect(ticketIdFromSourceRef('feedback_ticket:nope')).toBeNull();
  });
});

describe('resolveFeedbackTicketRef', () => {
  afterEach(() => { delete (global as any).fetch; });

  it('reads the ticket row when the snapshot predates the ticket number', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => [{ ticket_number: 'FB-2026-05-000032', linked_vtid: 'VTID-04402' }] }));
    const r = await resolveFeedbackTicketRef({ url: 'https://sb.test', key: 'k' }, { source_ref: `feedback_ticket:${TID}`, spec_snapshot: {} });
    expect(r).toEqual({ ticket_id: TID, ticket_number: 'FB-2026-05-000032', linked_vtid: 'VTID-04402' });
    expect((global as any).fetch.mock.calls[0][0]).toContain(`feedback_tickets?id=eq.${TID}`);
  });

  it('never fetches for a non-feedback finding and never throws', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('down'); });
    expect(await resolveFeedbackTicketRef({ url: 'u', key: 'k' }, { source_ref: null })).toBeNull();
    expect((global as any).fetch).not.toHaveBeenCalled();
    const r = await resolveFeedbackTicketRef({ url: 'u', key: 'k' }, { source_ref: `feedback_ticket:${TID}` });
    expect(r).toEqual({ ticket_id: TID, ticket_number: null, linked_vtid: null });
  });
});

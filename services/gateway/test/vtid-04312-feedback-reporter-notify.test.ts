/**
 * VTID-04312 — the reporter is told when their ticket is resolved, in their
 * own language, through notifyUser; /mine returns the resolution once
 * resolved and never an unsent draft.
 */
import * as fs from 'fs';
import * as path from 'path';
import { notifyFeedbackReporter } from '../src/services/feedback-reporter-notify';

function fakeSupabase(ticket: any, tenant: any) {
  return {
    from: jest.fn((table: string) => {
      const chain: any = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: table === 'feedback_tickets' ? ticket : tenant, error: null }),
      };
      return chain;
    }),
  } as any;
}

describe('VTID-04412 resolved ticket → memory', () => {
  it('a resolved ticket is handed to the memory writer; an unresolved one is not', async () => {
    const rememberTicket = jest.fn().mockResolvedValue({ status: 'written', written: 2 });
    const notify = jest.fn().mockResolvedValue({ pushed: 0, inapp: true });
    const sb = fakeSupabase({ id: 'tk-1', user_id: 'u-1', ticket_number: 'FB-7', status: 'resolved' }, { tenant_id: 'ten-1' });
    await notifyFeedbackReporter('tk-1', { supabase: sb, notify, locale: async () => 'en' as any, rememberTicket });
    expect(rememberTicket).toHaveBeenCalledWith(sb, 'tk-1');
    rememberTicket.mockClear();
    const open = fakeSupabase({ id: 'tk-2', user_id: 'u-1', ticket_number: 'FB-8', status: 'needs_more_info' }, { tenant_id: 'ten-1' });
    await notifyFeedbackReporter('tk-2', { supabase: open, notify, locale: async () => 'en' as any, rememberTicket });
    expect(rememberTicket).not.toHaveBeenCalled();
  });

  it('a failing memory write never breaks the notification', async () => {
    const notify = jest.fn().mockResolvedValue({ pushed: 1, inapp: true });
    const sb = fakeSupabase({ id: 'tk-1', user_id: 'u-1', ticket_number: 'FB-7', status: 'resolved' }, { tenant_id: 'ten-1' });
    const r = await notifyFeedbackReporter('tk-1', { supabase: sb, notify, locale: async () => 'en' as any, rememberTicket: jest.fn().mockRejectedValue(new Error('x')) });
    expect(r.sent).toBe(true);
  });
});

describe('notifyFeedbackReporter', () => {
  it('sends one translated feedback_ticket_resolved notification to the reporter', async () => {
    const notify = jest.fn().mockResolvedValue({ pushed: 1, inapp: true });
    const sb = fakeSupabase({ id: 'tk-1', user_id: 'u-1', ticket_number: 'FB-7', status: 'resolved' }, { tenant_id: 'ten-1' });
    const r = await notifyFeedbackReporter('tk-1', { supabase: sb, notify, locale: async () => 'de' as any });
    expect(r.sent).toBe(true);
    const [userId, tenantId, type, payload] = notify.mock.calls[0];
    expect([userId, tenantId, type]).toEqual(['u-1', 'ten-1', 'feedback_ticket_resolved']);
    expect(payload.title).toBe('Deine Meldung ist erledigt');
    expect(payload.body).toContain('FB-7');
    expect(payload.tag).toBe('feedback_resolved:tk-1');
    // VTID-04383: the push tap opens data.url verbatim — it must name the ticket.
    expect(payload.data.url).toBe('/comm/talk-to-vitana?ticket=tk-1');
    expect(payload.data.ticket_id).toBe('tk-1');
  });

  it('uses English for an English reporter', async () => {
    const notify = jest.fn().mockResolvedValue({ pushed: 0, inapp: true });
    const sb = fakeSupabase({ id: 'tk-1', user_id: 'u-1', ticket_number: 'FB-7', status: 'resolved' }, { tenant_id: 'ten-1' });
    await notifyFeedbackReporter('tk-1', { supabase: sb, notify, locale: async () => 'en' as any });
    expect(notify.mock.calls[0][3].title).toBe('Your report is resolved');
  });

  it('never announces a ticket that is not resolved (needs_more_info is for the supervisor)', async () => {
    const notify = jest.fn();
    const sb = fakeSupabase({ id: 'tk-1', user_id: 'u-1', ticket_number: 'FB-7', status: 'needs_more_info' }, { tenant_id: 'ten-1' });
    const r = await notifyFeedbackReporter('tk-1', { supabase: sb, notify, locale: async () => 'en' as any });
    expect(r).toEqual({ sent: false, reason: 'status_needs_more_info' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const notify = jest.fn().mockRejectedValue(new Error('push down'));
    const sb = fakeSupabase({ id: 'tk-1', user_id: 'u-1', ticket_number: null, status: 'resolved' }, { tenant_id: 'ten-1' });
    await expect(notifyFeedbackReporter('tk-1', { supabase: sb, notify, locale: async () => 'en' as any })).resolves.toEqual({ sent: false, reason: 'error' });
  });
});

describe('wiring (source contract)', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  it('every resolve path notifies the reporter', () => {
    expect(read('src/services/feedback-completion-reconciler.ts')).toContain('notifyFeedbackReporter(tk.id)');
    const actions = read('src/routes/feedback-actions.ts');
    expect(actions.match(/void notifyReporter\(String\(data\.id\)\);/g)).toHaveLength(2);
    expect(read('src/routes/tenant-specialists.ts').match(/notifyFeedbackReporter\(t\.id\)/g)).toHaveLength(2);
  });
  it('/mine exposes the resolution only for resolved tickets', () => {
    const route = read('src/routes/feedback.ts');
    expect(route).toContain("const RESOLVED = new Set(['resolved', 'user_confirmed']);");
    expect(route).toContain('answer_md: draft_answer_md ?? null');
  });
});

/**
 * VTID-04385 — a spoken report that becomes a ticket reaches the member's
 * screen: the gateway sends one support_ticket_filed frame and the ORB
 * widget turns it into a vitana:support-ticket-filed window event.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildSupportTicketFiledMessage,
  ticketFromTypedToolResult,
  TICKET_FILING_TOOLS,
} from '../src/orb/live/support/support-ticket-filed-signal';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('buildSupportTicketFiledMessage', () => {
  it('builds the frame with a deep link to the ticket', () => {
    expect(buildSupportTicketFiledMessage({ id: 'tk-1', ticket_number: 'FB-2026-09-000001', kind: 'bug' })).toEqual({
      type: 'support_ticket_filed',
      ticket_id: 'tk-1',
      ticket_number: 'FB-2026-09-000001',
      kind: 'bug',
      url: '/comm/talk-to-vitana?ticket=tk-1',
    });
  });
  it('returns null without a ticket id', () => {
    expect(buildSupportTicketFiledMessage({ id: '' })).toBeNull();
  });
});

describe('ticketFromTypedToolResult', () => {
  it('reads the created ticket from a typed filing tool', () => {
    expect(ticketFromTypedToolResult('submit_bug_report', {
      decision: 'created', ticket_id: 'tk-2', ticket_number: 'FB-2', kind: 'bug', specialist: 'devon',
    })).toEqual({ id: 'tk-2', ticket_number: 'FB-2', kind: 'bug' });
  });
  it('ignores asks for details, failures and other tools', () => {
    expect(ticketFromTypedToolResult('submit_bug_report', { decision: 'needs_details' })).toBeNull();
    expect(ticketFromTypedToolResult('submit_bug_report', null)).toBeNull();
    expect(ticketFromTypedToolResult('list_my_tickets', { decision: 'created', ticket_id: 'x' })).toBeNull();
  });
  it('covers all four typed filing tools', () => {
    expect([...TICKET_FILING_TOOLS].sort()).toEqual([
      'submit_account_issue', 'submit_bug_report', 'submit_marketplace_dispute', 'submit_support_ticket',
    ]);
  });
});

describe('wiring', () => {
  const orbLive = read('src/routes/orb-live.ts');
  it('report_to_specialist signals the client when it files a ticket', () => {
    expect(orbLive).toContain("sendSupportTicketFiledToClient(session, { id: ticket.id, ticket_number: ticket.ticket_number, kind });");
  });
  it('the typed tool path signals the client and never sends data to the model', () => {
    expect(orbLive).toContain('ticketFromTypedToolResult(toolName, dispatched.data)');
    expect(orbLive).toContain('const { data: _data, ...forModel } = dispatched;');
  });
  it('dispatchOrbToolForVertex exposes the structured result', () => {
    expect(read('src/services/orb-tools-shared.ts')).toContain('return { success: true, result: resultStr, data: r.result };');
  });
  it('the ORB widget turns the frame into a window event', () => {
    const widget = read('src/frontend/command-hub/orb-widget.js');
    expect(widget).toContain("case 'support_ticket_filed':");
    expect(widget).toContain("new CustomEvent('vitana:support-ticket-filed'");
  });
  it('the Command Hub cache-bust was bumped at or after this widget change', () => {
    const m = read('src/frontend/command-hub/index.html').match(/orb-widget\.js\?v=(\d{8})-vtid-(\d{5})/);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBeGreaterThanOrEqual(4385);
  });
});

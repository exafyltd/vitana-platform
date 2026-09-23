/**
 * VTID-04385 — tell the member's client that a spoken report became a ticket.
 *
 * Vitana (or Devon) says the ticket number out loud, but nothing on screen
 * showed it, so a member who missed it had no way to find the ticket. The
 * voice paths now send one `support_ticket_filed` frame whenever a voice
 * tool creates a ticket; the ORB widget turns it into a
 * `vitana:support-ticket-filed` window event and the app shows the number
 * with a link to the ticket.
 *
 * Pure helpers — the caller owns the transport (SSE response / WebSocket).
 */

export const SUPPORT_TICKET_FILED_MESSAGE_TYPE = 'support_ticket_filed' as const;

/** The typed voice tools that file a ticket (feedback-settings-tools.ts). */
export const TICKET_FILING_TOOLS: ReadonlySet<string> = new Set([
  'submit_bug_report',
  'submit_support_ticket',
  'submit_marketplace_dispute',
  'submit_account_issue',
]);

export type SupportTicketFiledMessage = {
  type: typeof SUPPORT_TICKET_FILED_MESSAGE_TYPE;
  ticket_id: string;
  ticket_number: string | null;
  kind: string | null;
  /** Relative app path that opens the member's ticket list on this ticket. */
  url: string;
};

export function buildSupportTicketFiledMessage(ticket: {
  id: string;
  ticket_number?: string | null;
  kind?: string | null;
}): SupportTicketFiledMessage | null {
  const id = typeof ticket?.id === 'string' ? ticket.id.trim() : '';
  if (!id) return null;
  return {
    type: SUPPORT_TICKET_FILED_MESSAGE_TYPE,
    ticket_id: id,
    ticket_number: ticket.ticket_number ?? null,
    kind: ticket.kind ?? null,
    url: `/comm/talk-to-vitana?ticket=${encodeURIComponent(id)}`,
  };
}

/**
 * Pull the created ticket out of a typed tool's raw result
 * ({ decision: 'created', ticket_id, ticket_number, kind }). Anything else —
 * a needs_details ask, a failure — returns null.
 */
export function ticketFromTypedToolResult(
  toolName: string,
  raw: unknown,
): { id: string; ticket_number: string | null; kind: string | null } | null {
  if (!TICKET_FILING_TOOLS.has(toolName) || !raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.decision !== 'created' || typeof r.ticket_id !== 'string' || !r.ticket_id) return null;
  return {
    id: r.ticket_id,
    ticket_number: typeof r.ticket_number === 'string' ? r.ticket_number : null,
    kind: typeof r.kind === 'string' ? r.kind : null,
  };
}

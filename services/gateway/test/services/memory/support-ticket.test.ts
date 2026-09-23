// VTID-04412 — resolved support tickets become member + support memory.
jest.mock('../../../src/services/memory/embed-item', () => ({ embedItemLater: jest.fn() }));
import { describeResolvedTicket, recordResolvedTicketMemory, SUPPORT_EPISODE_IMPORTANCE } from '../../../src/services/memory/support-ticket';

const ticket = {
  id: 'tk-1', user_id: 'u1', ticket_number: 'FB-2026-09-000123', kind: 'bug', status: 'resolved',
  raw_transcript: 'I cannot log in on **mobile**', resolution_md: '## Fixed\nThe login session now refreshes.', draft_answer_md: null,
  resolved_at: '2026-09-23T10:00:00Z',
};

function fakeSb(t: any, tenant: any = { tenant_id: 't1' }, insertErrors: Array<string | null> = []) {
  const inserts: any[] = [];
  return {
    inserts,
    sb: {
      from: (table: string) => {
        const q: any = {
          select: () => q, eq: () => q, order: () => q, limit: () => q,
          maybeSingle: async () => ({ data: table === 'feedback_tickets' ? t : tenant, error: null }),
          insert: (p: any) => { inserts.push(p); return q; },
          single: async () => {
            const e = insertErrors[inserts.length - 1];
            return e ? { data: null, error: { message: e } } : { data: { id: `mi-${inserts.length}` }, error: null };
          },
        };
        return q;
      },
    } as any,
  };
}

describe('describeResolvedTicket', () => {
  it('uses the ticket number, what was reported and how it was resolved, markdown stripped', () => {
    expect(describeResolvedTicket(ticket as any)).toBe('FB-2026-09-000123 (bug): I cannot log in on mobile → Fixed The login session now refreshes.');
  });
  it('falls back to the sent answer and returns null when there is nothing to say', () => {
    expect(describeResolvedTicket({ ...ticket, resolution_md: null, draft_answer_md: 'Reset your password' } as any)).toContain('→ Reset your password');
    expect(describeResolvedTicket({ ...ticket, raw_transcript: null, resolution_md: null } as any)).toBeNull();
  });
});

describe('recordResolvedTicketMemory', () => {
  it('writes one member episode and one support episode, both below the notification threshold', async () => {
    const { sb, inserts } = fakeSb(ticket);
    expect(await recordResolvedTicketMemory(sb, 'tk-1')).toEqual({ status: 'written', written: 2 });
    expect(inserts.map((i) => i.active_role)).toEqual([null, 'support']);
    expect(inserts[0]).toMatchObject({ tenant_id: 't1', user_id: 'u1', category_key: 'support_ticket', importance: SUPPORT_EPISODE_IMPORTANCE, content_json: { ticket_id: 'tk-1', audience: 'member' } });
    expect(inserts[1].content_json.audience).toBe('support');
    expect(SUPPORT_EPISODE_IMPORTANCE).toBeLessThanOrEqual(50);
  });
  it('is idempotent: duplicates are skipped, other errors reported', async () => {
    expect(await recordResolvedTicketMemory(fakeSb(ticket, undefined, ['duplicate key', 'duplicate key']).sb, 'tk-1')).toEqual({ status: 'written', written: 0 });
    expect(await recordResolvedTicketMemory(fakeSb(ticket, undefined, ['boom']).sb, 'tk-1')).toEqual({ status: 'failed', error: 'boom' });
  });
  it('writes nothing for an unresolved ticket, a missing reporter or tenant', async () => {
    for (const [t, tenant, status] of [
      [{ ...ticket, status: 'needs_more_info' }, { tenant_id: 't1' }, 'not_resolved'],
      [{ ...ticket, user_id: null }, { tenant_id: 't1' }, 'no_reporter'],
      [ticket, null, 'no_tenant'],
      [null, null, 'not_found'],
    ] as const) {
      const { sb, inserts } = fakeSb(t, tenant);
      expect((await recordResolvedTicketMemory(sb, 'tk-1')).status).toBe(status);
      expect(inserts).toHaveLength(0);
    }
  });
});

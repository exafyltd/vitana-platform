// VTID-04411 — customer-scoped memory from BackOffice commands.
jest.mock('../../../src/services/memory/embed-item', () => ({ embedItemLater: jest.fn() }));
import { customerRefOf, describeCommand, recordCustomerEpisode, recallCustomerMemory, CUSTOMER_EPISODE_IMPORTANCE } from '../../../src/services/memory/customer';

function row(over: any = {}) {
  return {
    id: 'cmd-1', tenant_id: 't1', requester_id: 'u1', channel: 'web', type: 'crm.activity.create', action: 'add-activity', tier: 'draft',
    status: 'executed', payload: { customer_ref: 'Acme GmbH', subject: 'Call about renewal', notes: 'Wants  a quote\nby Friday' },
    resolved_payload: { customer_ref: 'Acme GmbH', customer_id: 'CUST-0007', subject: 'Call about renewal', notes: 'Wants  a quote\nby Friday' },
    idempotency_key: 'k', request_hash: 'h', reason: null, approval_id: null, receipt: { status: 'executed', result: {} }, escalations: [],
    created_at: '2026-09-23T10:00:00Z', updated_at: '2026-09-23T10:00:00Z', executed_at: '2026-09-23T10:00:01Z', ...over,
  } as any;
}

function fakeSb(opts: { insertError?: string; rows?: any[] } = {}) {
  const inserts: any[] = [];
  const filters: string[] = [];
  const q: any = {
    insert: (p: any) => { inserts.push(p); return q; },
    select: () => q, single: async () => (opts.insertError ? { data: null, error: { message: opts.insertError } } : { data: { id: 'mi-1' }, error: null }),
    eq: (k: string, v: any) => { filters.push(`${k}=${v}`); return q; },
    or: (e: string) => { filters.push(`or:${e}`); return q; },
    order: () => q, limit: () => q,
    then: (res: any) => Promise.resolve({ data: opts.rows ?? [], error: null }).then(res),
  };
  return { sb: { from: () => q } as any, inserts, filters };
}

describe('customerRefOf', () => {
  it('prefers the resolved id and keeps the name as label', () => {
    expect(customerRefOf(row())).toEqual({ key: 'customer:CUST-0007', kind: 'customer', id: 'CUST-0007', label: 'Acme GmbH' });
  });
  it('takes a new record id from the receipt on create', () => {
    const r = customerRefOf(row({ type: 'crm.lead.create', payload: { lead_name: 'Jane Doe' }, resolved_payload: null, receipt: { result: { id: 'LEAD-9' } } }));
    expect(r).toEqual({ key: 'lead:LEAD-9', kind: 'lead', id: 'LEAD-9', label: 'Jane Doe' });
  });
  it('falls back to a folded name, and to null when nothing identifies a customer', () => {
    expect(customerRefOf(row({ payload: { customer_ref: '  ACME  GmbH ' }, resolved_payload: null }))!.key).toBe('name:acme gmbh');
    expect(customerRefOf(row({ payload: { subject: 'x' }, resolved_payload: null }))).toBeNull();
  });
});

describe('describeCommand', () => {
  it('quotes the command fields verbatim, whitespace collapsed', () => {
    const r = row();
    expect(describeCommand(r, customerRefOf(r)!)).toBe('crm.activity.create — Acme GmbH (CUST-0007) — subject: Call about renewal; notes: Wants a quote by Friday');
  });
});

describe('recordCustomerEpisode', () => {
  it('writes one backoffice-scoped episode keyed by customer, below the notification threshold', async () => {
    const { sb, inserts } = fakeSb();
    expect(await recordCustomerEpisode(sb, row())).toEqual({ status: 'written', id: 'mi-1' });
    expect(inserts[0]).toMatchObject({
      tenant_id: 't1', user_id: 'u1', category_key: 'customer', active_role: 'backoffice', importance: CUSTOMER_EPISODE_IMPORTANCE,
      content_json: { customer_key: 'customer:CUST-0007', customer_label: 'acme gmbh', command_id: 'cmd-1', command_type: 'crm.activity.create' },
    });
    expect(CUSTOMER_EPISODE_IMPORTANCE).toBeLessThanOrEqual(50);
  });
  it('skips failed commands, reads and commands with no customer', async () => {
    const { sb, inserts } = fakeSb();
    expect((await recordCustomerEpisode(sb, row({ status: 'failed' }))).status).toBe('not_applicable');
    expect((await recordCustomerEpisode(sb, row({ type: 'crm.lead.list' }))).status).toBe('not_applicable');
    expect((await recordCustomerEpisode(sb, row({ payload: {}, resolved_payload: null }))).status).toBe('no_customer');
    expect(inserts).toHaveLength(0);
  });
  it('treats a duplicate command as already written and reports other errors', async () => {
    expect((await recordCustomerEpisode(fakeSb({ insertError: 'duplicate key value violates unique constraint' }).sb, row())).status).toBe('already_written');
    expect(await recordCustomerEpisode(fakeSb({ insertError: 'boom' }).sb, row())).toEqual({ status: 'write_failed', error: 'boom' });
  });
});

describe('recallCustomerMemory', () => {
  it('matches the tenant, the category, and the id under every kind or the exact folded name', async () => {
    const { sb, filters } = fakeSb({ rows: [{ id: 'a', content: 'x', content_json: { command_type: 'crm.task.create', customer_key: 'customer:CUST-0007' }, occurred_at: 't' }] });
    const out = await recallCustomerMemory(sb, 't1', ' CUST-0007 ');
    expect(out).toEqual([{ id: 'a', content: 'x', command_type: 'crm.task.create', customer_key: 'customer:CUST-0007', occurred_at: 't' }]);
    expect(filters).toContain('tenant_id=t1');
    expect(filters).toContain('category_key=customer');
    const or = filters.find((f) => f.startsWith('or:'))!;
    expect(or).toContain('"customer:CUST-0007"');
    expect(or).toContain('"lead:CUST-0007"');
    expect(or).toContain('"name:cust-0007"');
    expect(or).toContain('content_json->>customer_label.eq."cust-0007"');
  });
  it('an explicit key is used as is; an empty ref returns nothing', async () => {
    const { sb, filters } = fakeSb();
    await recallCustomerMemory(sb, 't1', 'lead:LEAD-9');
    expect(filters.find((f) => f.startsWith('or:'))).toContain('in.("lead:LEAD-9")');
    expect(await recallCustomerMemory(sb, 't1', '  ')).toEqual([]);
  });
});

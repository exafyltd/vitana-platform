/**
 * VTID-04357 — calendar step 6: developer and admin work lenses.
 *
 * Pins: who gets work items (Exafy staff only, lens picked by role), how each
 * source maps to a read-only item, that every source fails open, that the
 * window route merges them without touching calendar rows, and that a work
 * item can never be "completed" through the calendar.
 */
import fs from 'fs';
import path from 'path';
import {
  workLensesFor,
  deployItems,
  reviewItems,
  ticketItems,
  erpApprovalItems,
  listWorkItems,
  mergeWorkItems,
  inWindow,
} from '../src/services/calendar-work-lens';

const U = 'user-1';

describe('who sees work items', () => {
  it('nobody without the verified exafy_admin claim, whatever the role header says', () => {
    for (const role of ['developer', 'admin', 'super_admin', 'staff', 'infra', null]) {
      expect(workLensesFor(role, false)).toEqual([]);
    }
  });

  it('staff get the lens their active role picks', () => {
    expect(workLensesFor('developer', true)).toEqual(['developer']);
    expect(workLensesFor('infra', true)).toEqual(['developer']);
    expect(workLensesFor('admin', true)).toEqual(['admin']);
    expect(workLensesFor('backoffice', true)).toEqual(['admin']);
    expect(workLensesFor('super_admin', true)).toEqual(['developer', 'admin']);
  });

  it('a staff member in the community or patient view gets no work items', () => {
    expect(workLensesFor('community', true)).toEqual([]);
    expect(workLensesFor('patient', true)).toEqual([]);
    expect(workLensesFor(null, true)).toEqual([]);
  });
});

describe('source rows become read-only items', () => {
  it('deploys: prod vs staging kind, short commit, service, 10 minutes', () => {
    const [p, s] = deployItems(U, [
      { id: 'e1', topic: 'prod.deploy.completed', service: 'vitana-gateway-awsdr', created_at: '2026-09-22T10:00:00.000Z', metadata: { git_commit: 'abcdef1234' } },
      { id: 'e2', topic: 'staging.deploy.completed', service: 'vitana-gateway-aws', created_at: '2026-09-22T11:00:00.000Z', metadata: {} },
    ]);
    expect(p.work).toEqual({ kind: 'deploy_prod', source_id: 'e1', params: { commit: 'abcdef1', service: 'vitana-gateway' } });
    expect(p.event?.title).toBe('abcdef1');
    expect(p.event?.event_type).toBe('deployment');
    expect(p.event?.role_context).toBe('developer');
    expect(p.end_time).toBe('2026-09-22T10:10:00.000Z');
    expect(s.work.kind).toBe('deploy_staging');
    expect(s.event?.title).toBe('vitana-gateway'); // no commit → service, never a sentence
  });

  it('every item is marked read-only and can never collide with a real row id', () => {
    const [i] = deployItems(U, [{ id: 'e1', topic: 'prod.deploy.completed', created_at: '2026-09-22T10:00:00Z' }]);
    expect(i.id).toBe('work:deploy_prod:e1');
    expect(i.event_id).toBe(i.id);
    expect(i.busy).toBe(false);
    expect(i.event?.metadata).toEqual({ work_item: true });
    expect(i.event?.reminder_offsets).toEqual([]);
  });

  it('autopilot reviews: placed when staged, titled by the PR title', () => {
    const [r] = reviewItems(U, [
      { id: 'abcdef12-0000', updated_at: '2026-09-22T12:00:00Z', metadata: { pending_approval: { staged_at: '2026-09-22T09:00:00Z', pr_title: 'fix: x', branch: 'dev-autopilot/abcdef12' } } },
    ]);
    expect(r.start_time).toBe('2026-09-22T09:00:00Z');
    expect(r.event?.title).toBe('fix: x');
    expect(r.event?.event_type).toBe('dev_task');
    expect(r.work.params).toEqual({ execution: 'abcdef12', branch: 'dev-autopilot/abcdef12' });
  });

  it('tickets: the block ends on the SLA deadline; closed statuses are dropped', () => {
    const items = ticketItems(U, [
      { id: 't1', ticket_number: 'FB-1', status: 'triaged', priority: 'p1', kind: 'bug', sla_due_at: '2026-09-22T12:00:00.000Z' },
      { id: 't2', ticket_number: 'FB-2', status: 'wont_fix', sla_due_at: '2026-09-22T12:00:00.000Z' },
      { id: 't3', ticket_number: 'FB-3', status: 'rejected', sla_due_at: '2026-09-22T12:00:00.000Z' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].end_time).toBe('2026-09-22T12:00:00.000Z');
    expect(items[0].event?.event_type).toBe('admin_task');
    expect(items[0].event?.role_context).toBe('admin');
    expect(items[0].work.params).toEqual({ ticket: 'FB-1', priority: 'p1', ticket_kind: 'bug' });
  });

  it('ERP approvals are admin tasks titled by the capability', () => {
    const [a] = erpApprovalItems(U, [{ id: 'a1', approve_capability: 'finance.payment.approve', created_at: '2026-09-22T08:00:00Z' }]);
    expect(a.event?.title).toBe('finance.payment.approve');
    expect(a.work.kind).toBe('erp_approval');
  });
});

describe('listWorkItems', () => {
  const realFetch = global.fetch;
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
  const W = { from: '2026-09-22T00:00:00.000Z', to: '2026-09-23T00:00:00.000Z' };

  const respondBy = (fn: (url: string) => { status: number; body: unknown }) => {
    global.fetch = jest.fn(async (url: any) => {
      urls.push(String(url));
      const r = fn(String(url));
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as any;
  };

  it('no lenses → no reads at all', async () => {
    respondBy(() => ({ status: 200, body: [] }));
    expect(await listWorkItems(U, [], W)).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  it('developer lens reads deploys + held executions only, never writes', async () => {
    respondBy((url) =>
      url.includes('oasis_events')
        ? { status: 200, body: [{ id: 'e1', topic: 'prod.deploy.completed', created_at: '2026-09-22T10:00:00Z', metadata: {} }] }
        : { status: 200, body: [{ id: 'x1', updated_at: '2026-09-22T05:00:00Z', metadata: {} }, { id: 'x2', updated_at: '2026-09-01T05:00:00Z', metadata: {} }] },
    );
    const items = await listWorkItems(U, ['developer'], W);
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes('topic=in.(staging.deploy.completed,prod.deploy.completed)'))).toBe(true);
    expect(urls.some((u) => u.includes('dev_autopilot_executions') && u.includes('status=eq.awaiting_approval'))).toBe(true);
    expect(urls.some((u) => u.includes('feedback_tickets') || u.includes('erp_approvals') || u.includes('calendar_events'))).toBe(false);
    // the held execution outside the window is dropped; order is by start
    expect(items.map((i) => i.work.kind)).toEqual(['autopilot_review', 'deploy_prod']);
    expect((global.fetch as jest.Mock).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('admin lens reads open ticket SLAs in the window and pending ERP approvals', async () => {
    respondBy(() => ({ status: 200, body: [] }));
    await listWorkItems(U, ['admin'], W);
    expect(urls).toHaveLength(2);
    const t = urls.find((u) => u.includes('feedback_tickets'))!;
    expect(t).toContain('resolved_at=is.null');
    expect(t).toContain('sla_due_at=gte.');
    expect(urls.find((u) => u.includes('erp_approvals'))).toContain('status=eq.pending');
  });

  it('a failing source is logged and skipped, the others still come back', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    respondBy((url) =>
      url.includes('oasis_events')
        ? { status: 500, body: { message: 'boom' } }
        : { status: 200, body: [{ id: 'x1', updated_at: '2026-09-22T05:00:00Z', metadata: {} }] },
    );
    const items = await listWorkItems(U, ['developer'], W);
    expect(items.map((i) => i.work.kind)).toEqual(['autopilot_review']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a thrown fetch fails open too', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    global.fetch = jest.fn(async () => {
      throw new Error('network');
    }) as any;
    expect(await listWorkItems(U, ['developer', 'admin'], W)).toEqual([]);
    err.mockRestore();
  });
});

describe('helpers', () => {
  it('inWindow keeps overlapping items only', () => {
    const W = { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' };
    const keep = { start_time: '2026-09-21T23:50:00Z', end_time: '2026-09-22T00:10:00Z' };
    const drop = { start_time: '2026-09-23T00:00:00Z', end_time: '2026-09-23T00:30:00Z' };
    expect(inWindow([keep, drop], W)).toEqual([keep]);
  });

  it('mergeWorkItems keeps start order across both lists', () => {
    const a = [{ start_time: '2026-09-22T10:00:00Z', n: 'a' }];
    const w = [{ start_time: '2026-09-22T09:00:00Z', n: 'w' }];
    expect(mergeWorkItems<any>(a, w).map((x) => x.n)).toEqual(['w', 'a']);
  });
});

describe('route wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/calendar.ts'), 'utf8');
  const route = src.slice(src.indexOf("router.get('/events/window'"), src.indexOf("router.get('/events/upcoming'"));

  it('grants work lenses from the verified claim, never from the header alone', () => {
    expect(route).toContain('workLensesFor(role, (req as AuthenticatedRequest).identity?.exafy_admin === true)');
    expect(route).toContain("req.query.include_work === 'false'");
    expect(route).toContain('work_lenses: lenses');
  });

  it('work items carry no reminders', () => {
    expect(route).toContain('reminders: [] as unknown[]');
  });

  it('the complete route refuses work items', () => {
    const complete = src.slice(src.indexOf("router.post('/events/:id/complete'"));
    expect(complete.indexOf("id.startsWith('work:')")).toBeGreaterThan(-1);
    expect(complete.indexOf("id.startsWith('work:')")).toBeLessThan(complete.indexOf('markEventCompleted('));
  });
});

import * as repo from '../../src/services/feedback/feedback-tickets-repository';
import { RepositoryError, __setClientForTest } from '../../src/services/feedback/feedback-tickets-repository';

// VTID-03498 (Aurora migration B1) — feedback-ticket data-access seam.
//
// The tests that matter most here are the tenant-gate ones. `loadTicketIfTenantOwned`
// is what stops a tenant admin acting on another tenant's ticket, and the whole
// reason it lives in the repository is so no caller can perform step one of the
// chain and skip steps two and three. These pin that the chain is actually
// walked, and that all three failure modes are indistinguishable to the caller.

type Result = { data: unknown; error: { message: string } | null };

/**
 * Stub that returns a DIFFERENT result per table, so a multi-step chain can be
 * driven precisely — e.g. ticket found, membership absent.
 */
function makeClient(byTable: Record<string, Result>, spy?: { tables: string[] }) {
  const build = (table: string) => {
    const result = byTable[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'insert', 'delete']) {
      builder[m] = () => builder;
    }
    builder.maybeSingle = () => Promise.resolve(result);
    builder.single = () => Promise.resolve(result);
    builder.then = (res: (r: Result) => unknown) => Promise.resolve(result).then(res);
    return builder;
  };
  return {
    from: (t: string) => {
      spy?.tables.push(t);
      return build(t);
    },
  } as never;
}

const TICKET = { id: 't1', user_id: 'u1', ticket_number: 'FB-1', status: 'spec_ready' };

afterEach(() => __setClientForTest(null));

describe('loadTicketIfTenantOwned — the tenant gate', () => {
  it('returns the ticket and handoffs when the owner is in the tenant', async () => {
    __setClientForTest(
      makeClient({
        feedback_tickets: { data: TICKET, error: null },
        user_tenants: { data: { user_id: 'u1' }, error: null },
        feedback_handoff_events: { data: [{ id: 'h1' }], error: null },
      }),
    );
    const out = await repo.loadTicketIfTenantOwned('tenant-a', 't1');
    expect(out).not.toBeNull();
    expect(out!.ticket.id).toBe('t1');
    expect(out!.handoffs).toHaveLength(1);
  });

  it('returns null when the ticket does not exist', async () => {
    __setClientForTest(makeClient({ feedback_tickets: { data: null, error: null } }));
    await expect(repo.loadTicketIfTenantOwned('tenant-a', 'nope')).resolves.toBeNull();
  });

  it('returns null when the ticket has no owner', async () => {
    __setClientForTest(
      makeClient({ feedback_tickets: { data: { id: 't1', user_id: null }, error: null } }),
    );
    await expect(repo.loadTicketIfTenantOwned('tenant-a', 't1')).resolves.toBeNull();
  });

  it('returns null when the owner is NOT a member of the tenant', async () => {
    // The cross-tenant case. This is the leak the gate exists to prevent.
    __setClientForTest(
      makeClient({
        feedback_tickets: { data: TICKET, error: null },
        user_tenants: { data: null, error: null },
      }),
    );
    await expect(repo.loadTicketIfTenantOwned('tenant-b', 't1')).resolves.toBeNull();
  });

  it('actually checks membership — it does not stop after finding the ticket', async () => {
    // Guards against a refactor that returns early once the ticket is loaded.
    const spy = { tables: [] as string[] };
    __setClientForTest(
      makeClient(
        {
          feedback_tickets: { data: TICKET, error: null },
          user_tenants: { data: null, error: null },
        },
        spy,
      ),
    );
    await repo.loadTicketIfTenantOwned('tenant-b', 't1');
    expect(spy.tables).toContain('user_tenants');
  });

  it('all three failure modes are indistinguishable to the caller', async () => {
    const cases: Array<Record<string, Result>> = [
      { feedback_tickets: { data: null, error: null } },
      { feedback_tickets: { data: { id: 't1', user_id: null }, error: null } },
      { feedback_tickets: { data: TICKET, error: null }, user_tenants: { data: null, error: null } },
    ];
    for (const c of cases) {
      __setClientForTest(makeClient(c));
      await expect(repo.loadTicketIfTenantOwned('tenant-x', 't1')).resolves.toBeNull();
    }
  });

  it('throws rather than returning null when the membership query itself errors', async () => {
    // A failed check must not read as "not a member" — that would silently
    // deny access on a blip, and worse, the inverse bug would grant it.
    __setClientForTest(
      makeClient({
        feedback_tickets: { data: TICKET, error: null },
        user_tenants: { data: null, error: { message: 'connection reset' } },
      }),
    );
    await expect(repo.loadTicketIfTenantOwned('tenant-a', 't1')).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('resolveTenantCustomer', () => {
  it('distinguishes unknown customer from customer outside the tenant', async () => {
    __setClientForTest(makeClient({ app_users: { data: null, error: null } }));
    await expect(repo.resolveTenantCustomer('tenant-a', 'VIT-1')).resolves.toEqual({ status: 'not_found' });

    __setClientForTest(
      makeClient({
        app_users: { data: { user_id: 'u1' }, error: null },
        user_tenants: { data: null, error: null },
      }),
    );
    await expect(repo.resolveTenantCustomer('tenant-a', 'VIT-1')).resolves.toEqual({ status: 'not_in_tenant' });
  });

  it('returns the user id on success', async () => {
    __setClientForTest(
      makeClient({
        app_users: { data: { user_id: 'u1' }, error: null },
        user_tenants: { data: { user_id: 'u1' }, error: null },
      }),
    );
    await expect(repo.resolveTenantCustomer('tenant-a', 'VIT-1')).resolves.toEqual({
      status: 'ok',
      userId: 'u1',
    });
  });
});

describe('transitionTicketStatus — optimistic lock', () => {
  it('returns the row when the transition applied', async () => {
    __setClientForTest(makeClient({ feedback_tickets: { data: { id: 't1', status: 'in_progress' }, error: null } }));
    await expect(
      repo.transitionTicketStatus('t1', 'spec_ready', { status: 'in_progress' }, 'id, status'),
    ).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('returns null (skip) rather than throwing when the row did not move', async () => {
    // Contended ticket in a bulk batch must not abort the whole batch — this is
    // the one place the repository deliberately swallows the error.
    __setClientForTest(makeClient({ feedback_tickets: { data: null, error: { message: 'no rows' } } }));
    await expect(
      repo.transitionTicketStatus('t1', 'spec_ready', { status: 'in_progress' }, 'id, status'),
    ).resolves.toBeNull();
  });
});

describe('plain ticket writes do throw', () => {
  it('updateTicket surfaces a failure', async () => {
    __setClientForTest(makeClient({ feedback_tickets: { data: null, error: { message: 'denied' } } }));
    await expect(repo.updateTicket('t1', { status: 'x' })).rejects.toBeInstanceOf(RepositoryError);
  });

  it('updateTicketReturning surfaces a failure', async () => {
    __setClientForTest(makeClient({ feedback_tickets: { data: null, error: { message: 'denied' } } }));
    await expect(repo.updateTicketReturning('t1', { status: 'x' }, 'status')).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });
});

describe('executions', () => {
  it('latestCompletedExecutionForFinding returns null when there is none', async () => {
    __setClientForTest(makeClient({ dev_autopilot_executions: { data: null, error: null } }));
    await expect(repo.latestCompletedExecutionForFinding('f1')).resolves.toBeNull();
  });

  it('latestExecutionForFinding throws on a query error', async () => {
    __setClientForTest(makeClient({ dev_autopilot_executions: { data: null, error: { message: 'boom' } } }));
    await expect(repo.latestExecutionForFinding('f1')).rejects.toBeInstanceOf(RepositoryError);
  });
});

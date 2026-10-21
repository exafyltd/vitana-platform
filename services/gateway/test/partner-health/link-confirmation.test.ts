// VTID-05055 — services/partner-health/link-confirmation.ts, the ONE place
// that creates a partner link + order (after the member confirms).
//
//   - RPC not_pending → 409, not_in_tenant → 409, function missing → 503
//   - RPC success → health_test.order_created with actor_id = the member
//   - an RPC error is rolled back by Postgres: the row stays pending_member
//     and a retry succeeds
//   - the migration's function is SECURITY DEFINER, SET search_path = public,
//     revoked from PUBLIC/anon/authenticated, granted to service_role only
//   - declineMemberLink compare-and-sets pending_member → declined

import fs from 'fs';
import path from 'path';

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));

import {
  materializeMemberConfirmedLink,
  declineMemberLink,
  isMissingSchemaError,
} from '../../src/services/partner-health/link-confirmation';

const MEMBER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ROW = { id: 'inbox-1', proposed_user_id: MEMBER };

/**
 * A tiny in-memory stand-in for fn_confirm_partner_link_request: one inbox
 * row; a transaction either commits all three writes or none.
 */
function makeDb(opts: { inTenant?: boolean; failNextInsert?: boolean } = {}) {
  const state = {
    row: { id: 'inbox-1', proposed_user_id: MEMBER, member_link_status: 'pending_member', resolved: false } as Record<string, any>,
    links: [] as string[],
    orders: [] as string[],
    failNextInsert: !!opts.failNextInsert,
  };
  const sb: any = {
    rpc: jest.fn(async (fn: string, params: { p_inbox_id: string; p_user_id: string }) => {
      expect(fn).toBe('fn_confirm_partner_link_request');
      const r = state.row;
      if (r.id !== params.p_inbox_id || r.proposed_user_id !== params.p_user_id || r.member_link_status !== 'pending_member' || r.resolved) {
        return { data: { ok: false, code: 'not_pending' }, error: null };
      }
      if (opts.inTenant === false) return { data: { ok: false, code: 'not_in_tenant' }, error: null };
      // BEGIN
      const snapshot = JSON.stringify(state);
      try {
        state.links.push('link-1');
        if (state.failNextInsert) {
          state.failNextInsert = false;
          throw new Error('duplicate key value violates unique constraint "partner_health_test_orders_partner_ext_uidx"');
        }
        state.orders.push('order-1');
        Object.assign(r, { member_link_status: 'confirmed', resolved: true, resolved_order_id: 'order-1' });
        return { data: { ok: true, order_id: 'order-1', link_id: 'link-1' }, error: null };
      } catch (e) {
        // ROLLBACK
        const back = JSON.parse(snapshot);
        Object.assign(state.row, back.row);
        state.links = back.links;
        state.orders = back.orders;
        return { data: null, error: { code: '23505', message: (e as Error).message } };
      }
    }),
  };
  return { sb, state };
}

beforeEach(() => {
  jest.clearAllMocks();
  emitOasisEventMock.mockResolvedValue({ ok: true });
});

describe('materializeMemberConfirmedLink', () => {
  it('success → link + order, health_test.order_created with the member as actor', async () => {
    const { sb, state } = makeDb();
    const out = await materializeMemberConfirmedLink(sb, ROW);
    expect(out).toEqual({ ok: true, order_id: 'order-1', link_id: 'link-1' });
    expect(state.row.member_link_status).toBe('confirmed');
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-05055',
      type: 'health_test.order_created',
      status: 'success',
      actor_id: MEMBER,
      payload: { inbox_id: 'inbox-1', order_id: 'order-1', link_id: 'link-1', confirmed_by: 'member' },
    }));
  });

  it('RPC not_pending → 409, nothing emitted', async () => {
    const { sb, state } = makeDb();
    state.row.member_link_status = 'declined';
    const out = await materializeMemberConfirmedLink(sb, ROW);
    expect(out).toEqual({ ok: false, status: 409, error: 'NOT_PENDING' });
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('RPC not_in_tenant → 409, nothing written', async () => {
    const { sb, state } = makeDb({ inTenant: false });
    const out = await materializeMemberConfirmedLink(sb, ROW);
    expect(out).toEqual({ ok: false, status: 409, error: 'NOT_IN_TENANT' });
    expect(state.links).toEqual([]);
    expect(state.orders).toEqual([]);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 'PGRST202', message: 'Could not find the function public.fn_confirm_partner_link_request(p_inbox_id, p_user_id) in the schema cache' }],
    [{ code: '42883', message: 'function public.fn_confirm_partner_link_request(uuid, uuid) does not exist' }],
  ])('function missing (migration pending) → 503 MEMBER_CONFIRMATION_UNAVAILABLE', async (error) => {
    const sb: any = { rpc: jest.fn().mockResolvedValue({ data: null, error }) };
    const out = await materializeMemberConfirmedLink(sb, ROW);
    expect(out).toEqual({ ok: false, status: 503, error: 'MEMBER_CONFIRMATION_UNAVAILABLE' });
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('an RPC error leaves the row pending_member (rolled back) and a retry succeeds', async () => {
    const { sb, state } = makeDb({ failNextInsert: true });
    const first = await materializeMemberConfirmedLink(sb, ROW);
    expect(first).toEqual({ ok: false, status: 500, error: 'CONFIRM_FAILED' });
    expect(state.row.member_link_status).toBe('pending_member');
    expect(state.row.resolved).toBe(false);
    expect(state.links).toEqual([]);
    expect(state.orders).toEqual([]);
    expect(emitOasisEventMock).not.toHaveBeenCalled();

    const retry = await materializeMemberConfirmedLink(sb, ROW);
    expect(retry).toEqual({ ok: true, order_id: 'order-1', link_id: 'link-1' });
    expect(state.links).toEqual(['link-1']);
    expect(state.orders).toEqual(['order-1']);
  });

  it('the order stands when the audit emit fails (logged, not hidden, not rolled back)', async () => {
    const { sb } = makeDb();
    emitOasisEventMock.mockResolvedValue({ ok: false, error: 'insert failed' });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await materializeMemberConfirmedLink(sb, ROW);
    expect(out.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('health_test.order_created emit failed'));
    spy.mockRestore();
  });
});

describe('declineMemberLink', () => {
  function makeTable(row: Record<string, any> | null, updated: any[] = [{ id: 'inbox-1' }]) {
    const updates: any[] = [];
    const sb: any = {
      from: () => {
        let op = 'select';
        let payload: any;
        const filters: any[] = [];
        const chain: any = {
          select: () => chain,
          update: (p: any) => { op = 'update'; payload = p; return chain; },
          eq: (...a: any[]) => { filters.push(a); return chain; },
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
          then: (resolve: any, reject: any) => {
            if (op === 'update') updates.push({ payload, filters });
            return Promise.resolve({ data: updated, error: null }).then(resolve, reject);
          },
        };
        return chain;
      },
    };
    return { sb, updates };
  }

  it('pending_member → declined, member appended, row stays unresolved', async () => {
    const { sb, updates } = makeTable({ id: 'inbox-1', member_link_status: 'pending_member', member_declined_user_ids: [], resolved: false });
    const out = await declineMemberLink(sb, { inbox_id: 'inbox-1', user_id: MEMBER });
    expect(out).toEqual({ ok: true });
    expect(updates[0].payload).toMatchObject({ member_link_status: 'declined', member_declined_user_ids: [MEMBER] });
    expect(updates[0].payload).not.toHaveProperty('resolved');
    expect(updates[0].filters).toEqual(expect.arrayContaining([['member_link_status', 'pending_member'], ['resolved', false]]));
  });

  it('404 when the row is not the caller\'s; 409 when no longer pending; 409 when the CAS updates nothing', async () => {
    expect(await declineMemberLink(makeTable(null).sb, { inbox_id: 'inbox-1', user_id: MEMBER })).toMatchObject({ ok: false, status: 404 });
    expect(await declineMemberLink(makeTable({ member_link_status: 'confirmed', resolved: true }).sb, { inbox_id: 'inbox-1', user_id: MEMBER })).toMatchObject({ ok: false, status: 409 });
    expect(await declineMemberLink(makeTable({ member_link_status: 'pending_member', resolved: false, member_declined_user_ids: [] }, []).sb, { inbox_id: 'inbox-1', user_id: MEMBER })).toMatchObject({ ok: false, status: 409 });
  });
});

describe('isMissingSchemaError', () => {
  it('recognises missing columns/functions, nothing else', () => {
    expect(isMissingSchemaError({ code: '42703' })).toBe(true);
    expect(isMissingSchemaError({ code: 'PGRST204' })).toBe(true);
    expect(isMissingSchemaError({ code: 'PGRST202' })).toBe(true);
    expect(isMissingSchemaError({ message: 'column partner_health_result_inbox.proposed_user_id does not exist' })).toBe(true);
    expect(isMissingSchemaError({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
  });
});

describe('migration contract — fn_confirm_partner_link_request', () => {
  const dir = path.join(__dirname, '../../../../supabase/migrations');
  const file = fs.readdirSync(dir).find((f) => /_vtid_05055_partner_health_member_link_confirmation\.sql$/.test(f));
  const sql = file ? fs.readFileSync(path.join(dir, file), 'utf8') : '';
  const fnBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_confirm_partner_link_request'), sql.indexOf('$$;') + 3);

  it('exists, is SECURITY DEFINER with SET search_path = public and returns jsonb', () => {
    expect(file).toBeDefined();
    expect(fnBody).toMatch(/fn_confirm_partner_link_request\(p_inbox_id uuid, p_user_id uuid\)\s+RETURNS jsonb/);
    expect(fnBody).toMatch(/SECURITY DEFINER/);
    expect(fnBody).toMatch(/SET search_path = public/);
  });

  it('EXECUTE is revoked from PUBLIC, anon and authenticated and granted to service_role only', () => {
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.fn_confirm_partner_link_request\\(uuid, uuid\\) FROM ${role};`));
    }
    const grants = sql.match(/GRANT EXECUTE ON FUNCTION public\.fn_confirm_partner_link_request\(uuid, uuid\) TO (\w+);/g) ?? [];
    expect(grants).toEqual(['GRANT EXECUTE ON FUNCTION public.fn_confirm_partner_link_request(uuid, uuid) TO service_role;']);
  });

  it('locks the row, re-checks tenant membership on the STORED tenant, writes what confirm-match wrote', () => {
    expect(fnBody).toMatch(/proposed_user_id = p_user_id[\s\S]*member_link_status = 'pending_member'[\s\S]*resolved = false[\s\S]*FOR UPDATE/);
    expect(fnBody).toMatch(/FROM public\.user_tenants ut[\s\S]*ut\.user_id = p_user_id[\s\S]*ut\.tenant_id = v_row\.proposed_tenant_id/);
    expect(fnBody).toMatch(/'not_pending'/);
    expect(fnBody).toMatch(/'not_in_tenant'/);
    expect(fnBody).toMatch(/INSERT INTO public\.partner_customer_links[\s\S]*'manual_confirmed'[\s\S]*v_row\.proposed_by_admin_id/);
    expect(fnBody).toMatch(/INSERT INTO public\.partner_health_test_orders[\s\S]*v_row\.proposed_external_order_ref[\s\S]*v_row\.proposed_test_name[\s\S]*'processing'/);
    expect(fnBody).toMatch(/member_link_status\s+= 'confirmed'[\s\S]*resolved\s+= true[\s\S]*resolved_order_id\s+= v_order_id/);
    // Never trusts a tenant passed in by the caller.
    expect(fnBody).not.toMatch(/p_tenant_id/);
  });
});

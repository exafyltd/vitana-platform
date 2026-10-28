/** VTID-03842 — exact-match entity resolution through a fake bridge. */
import { resolveEntities, pickExact } from '../src/services/backoffice/entity-resolution';
import type { ErpBridgeClient, BridgeExecuteRequest } from '../src/services/backoffice/erp-bridge-client';

function fakeBridge(lists: Record<string, Record<string, unknown>>): ErpBridgeClient & { calls: BridgeExecuteRequest[] } {
  const calls: BridgeExecuteRequest[] = [];
  return {
    calls,
    async execute(req) {
      calls.push(req);
      const result = lists[req.action];
      if (!result) return { ok: false, status: 403, error: 'not_allowlisted' };
      return { ok: true, status: 200, receipt: { status: 'executed', replayed: false, idempotency_key: req.idempotency_key, action: req.action, result } };
    },
  };
}

const customers = { customers: [
  { id: 'c1', customer_name: 'Acme LLC' }, { id: 'c2', customer_name: 'Acme Trading LLC' }, { id: 'c3', customer_name: 'acme llc ' },
] };

test('exact match (trimmed, case-folded) resolves to the id and drops the ref', async () => {
  const b = fakeBridge({ 'list-customers': { customers: [{ id: 'c1', customer_name: 'Acme LLC' }] } });
  const r = await resolveEntities(b, 't1', 'u1', { customer_ref: '  acme llc ', amount: 5 });
  expect(r).toEqual({ ok: true, payload: { customer_id: 'c1', amount: 5 }, resolved: [{ field: 'customer_id', ref: '  acme llc ', id: 'c1' }] });
  expect(b.calls[0]).toMatchObject({ tenant_id: 't1', action: 'list-customers', params: { limit: 200, search: 'acme llc' }, actor: { user_id: 'u1', channel: 'system' } });
});

test('several exact matches → entity_ambiguous with candidates, never a pick', async () => {
  const r = await resolveEntities(fakeBridge({ 'list-customers': customers }), 't1', 'u1', { customer_ref: 'Acme LLC' });
  expect(r).toMatchObject({ ok: false, reason: 'entity_ambiguous', field: 'customer_ref' });
  expect((r as any).candidates.map((c: any) => c.id)).toEqual(['c1', 'c3']);
});

test('no match → entity_not_found; a near miss is not a match', async () => {
  const r = await resolveEntities(fakeBridge({ 'list-customers': customers }), 't1', 'u1', { customer_ref: 'Acme' });
  expect(r).toMatchObject({ ok: false, reason: 'entity_not_found' });
  expect(pickExact(customers.customers, 'Acme Trading', ['customer_name'])).toEqual([]);
});

test('ref and id both present → entity_ref_conflict; lookup failure surfaces; no refs → passthrough', async () => {
  expect(await resolveEntities(fakeBridge({}), 't1', 'u1', { customer_ref: 'x', customer_id: 'c9' })).toMatchObject({ ok: false, reason: 'entity_ref_conflict' });
  expect(await resolveEntities(fakeBridge({}), 't1', 'u1', { account_ref: '1110' })).toMatchObject({ ok: false, reason: 'entity_lookup_failed', error: 'not_allowlisted' });
  const b = fakeBridge({});
  expect(await resolveEntities(b, 't1', 'u1', { amount: 1 })).toEqual({ ok: true, payload: { amount: 1 }, resolved: [] });
  expect(b.calls).toHaveLength(0);
});

test('account_ref matches on number or name', async () => {
  const b = fakeBridge({ 'list-accounts': { accounts: [{ id: 'a1', account_number: '1110', name: 'Cash and Bank' }, { id: 'a2', account_number: '4100', name: 'Sales' }] } });
  expect((await resolveEntities(b, 't1', 'u1', { account_ref: '1110' }) as any).payload.account_id).toBe('a1');
  expect((await resolveEntities(b, 't1', 'u1', { account_ref: 'sales' }) as any).payload.account_id).toBe('a2');
});

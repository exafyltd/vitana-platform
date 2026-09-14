/**
 * VTID-03842 — /api/v1/backoffice/commands, approvals, audit, policy.
 * Auth (lib/tenant-role-auth) and the access resolver are mocked; the store is
 * the memory implementation; the bridge is a fake that records every call.
 */
import request from 'supertest';
import express from 'express';

const mockVerifyAuth = jest.fn();
jest.mock('../../src/lib/tenant-role-auth', () => ({
  verifyAuth: (...a: any[]) => mockVerifyAuth(...a),
  canManageRoles: async () => ({ allowed: true }),
  getBearerToken: () => 'tok',
}));
const mockEmit = jest.fn(async () => ({ ok: true }));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: any[]) => mockEmit(...a) }));

import router from '../../src/routes/backoffice-commands';
import { MemoryCommandStore, __setCommandStoreForTests } from '../../src/services/backoffice/command-store';
import { __setErpBridgeClientForTests, type BridgeExecuteRequest, type ErpBridgeClient } from '../../src/services/backoffice/erp-bridge-client';

const app = express();
app.use(express.json());
app.use('/api/v1/backoffice', router);

const TENANT = '11111111-1111-1111-1111-111111111111';
// aal2 token: header.payload.sig with {"aal":"aal2"}
const AAL2 = 'h.' + Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url') + '.s';
const AAL1 = 'h.' + Buffer.from(JSON.stringify({ aal: 'aal1' })).toString('base64url') + '.s';
const user = (id: string, role: string | null, token = AAL2, exafy = false) => ({ ok: true, user_id: id, email: `${id}@x`, is_exafy_admin: exafy, tenant_id: TENANT, active_role: role, token });

let store: MemoryCommandStore;
let bridge: ErpBridgeClient & { calls: BridgeExecuteRequest[]; fail?: boolean };
let fetchMock: jest.Mock;

function grantsFor(userId: string, caps: string[]) {
  return caps.map((c) => ({ user_id: userId, tenant_id: TENANT, capability: c, granted_by: null, granted_at: 'now' }));
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://sb.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  store = new MemoryCommandStore();
  __setCommandStoreForTests(store);
  const calls: BridgeExecuteRequest[] = [];
  bridge = {
    calls,
    async execute(req) {
      calls.push(req);
      if (bridge.fail) return { ok: true, status: 200, receipt: { status: 'failed', replayed: false, idempotency_key: req.idempotency_key, action: req.action, result: { status: 'error', message: 'nope' } } };
      if (req.action === 'list-customers') return { ok: true, status: 200, receipt: { status: 'executed', replayed: false, idempotency_key: req.idempotency_key, action: req.action, result: { customers: [{ id: 'c1', customer_name: 'Acme LLC' }, { id: 'c2', customer_name: 'Acme Trading' }] } } };
      return { ok: true, status: 200, receipt: { status: 'executed', replayed: false, idempotency_key: req.idempotency_key, action: req.action, tier: 'x', result: { status: 'ok', echo: req.params } } };
    },
  };
  __setErpBridgeClientForTests(bridge);
  // explicit-grant reads by resolveAccess go through global fetch; default: no explicit grants
  fetchMock = jest.fn(async (url: string) => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' }));
  (global as any).fetch = fetchMock;
});
afterEach(() => { __setCommandStoreForTests(null); __setErpBridgeClientForTests(null); });

function withGrants(userId: string, caps: string[]) {
  fetchMock.mockImplementation(async (url: string) => {
    const rows = url.includes(`user_id=eq.${userId}`) ? grantsFor(userId, caps) : [];
    return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
  });
}
const post = (body: any) => request(app).post('/api/v1/backoffice/commands').send(body);

describe('POST /commands — read/draft/commit', () => {
  test('401 without identity, JSON body (mount proof)', async () => {
    mockVerifyAuth.mockResolvedValue({ ok: false, status: 401, error: 'UNAUTHENTICATED' });
    const r = await post({ type: 'crm.lead.list', idempotency_key: 'k-00000001' });
    expect(r.status).toBe(401); expect(r.headers['content-type']).toMatch(/json/);
  });
  test('unknown type → 400; bad key → 400', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    expect((await post({ type: 'erp.nuke', idempotency_key: 'k-00000001' })).status).toBe(400);
    expect((await post({ type: 'crm.lead.list', idempotency_key: 'x' })).status).toBe(400);
  });
  test('read executes on the bridge with tenant + actor + channel; receipt stored; audit + OASIS emitted', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    const r = await post({ type: 'crm.lead.list', payload: { limit: 5 }, idempotency_key: 'k-00000002', channel: 'chat' });
    expect(r.status).toBe(200);
    expect(r.body.command).toMatchObject({ type: 'crm.lead.list', action: 'list-leads', tier: 'read', status: 'executed', channel: 'chat', replayed: false });
    expect(bridge.calls[0]).toMatchObject({ tenant_id: TENANT, action: 'list-leads', params: { limit: 5 }, idempotency_key: 'k-00000002', actor: { user_id: 'u1', channel: 'chat' }, confirmation: { granted: false } });
    expect(store.audit.map((a) => a.event)).toEqual(['command.executed']);
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ type: 'backoffice.command.executed', vtid: 'VTID-03842' }));
  });
  test('capability missing → 403, rejected row, nothing sent to the bridge', async () => {
    withGrants('u-bo', []); mockVerifyAuth.mockResolvedValue(user('u-bo', 'backoffice'));
    const r = await post({ type: 'crm.lead.create', payload: { lead_name: 'x' }, idempotency_key: 'k-00000003' });
    expect(r.status).toBe(403); expect(r.body.command.status).toBe('rejected'); expect(r.body.required_capability).toBe('crm.manage');
    expect(bridge.calls).toHaveLength(0); expect(store.audit[0].event).toBe('command.rejected');
  });
  test('commit without confirm → rejected confirmation_required; with confirm → bridge gets granted:true', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    const r1 = await post({ type: 'sales.invoice.submit', payload: { sales_invoice_id: 'inv1' }, idempotency_key: 'k-00000004' });
    expect(r1.status).toBe(200); expect(r1.body.command).toMatchObject({ status: 'rejected', reason: 'confirmation_required', tier: 'commit' });
    const r2 = await post({ type: 'sales.invoice.submit', payload: { sales_invoice_id: 'inv1' }, idempotency_key: 'k-00000005', confirm: true });
    expect(r2.status).toBe(200); expect(r2.body.command.status).toBe('executed');
    expect(bridge.calls[0].confirmation).toEqual({ granted: true });
  });
  test('idempotency: replay returns the stored command, different payload → 409', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    await post({ type: 'crm.lead.create', payload: { lead_name: 'A' }, idempotency_key: 'k-00000006' });
    const r = await post({ type: 'crm.lead.create', payload: { lead_name: 'A' }, idempotency_key: 'k-00000006' });
    expect(r.body.command.replayed).toBe(true); expect(bridge.calls).toHaveLength(1);
    expect((await post({ type: 'crm.lead.create', payload: { lead_name: 'B' }, idempotency_key: 'k-00000006' })).status).toBe(409);
  });
  test('ERPClaw failure → 502, failed row, command.failed audit', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin')); bridge.fail = true;
    const r = await post({ type: 'crm.lead.create', payload: { lead_name: 'A' }, idempotency_key: 'k-00000007' });
    expect(r.status).toBe(502); expect(r.body.command).toMatchObject({ status: 'failed', reason: 'erp_action_failed' });
    expect(store.audit[0].event).toBe('command.failed');
  });
  test('voice: draft ok, commit rejected voice_not_permitted', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    expect((await post({ type: 'crm.lead.create', payload: { lead_name: 'A' }, idempotency_key: 'k-00000008', channel: 'voice' })).body.command.status).toBe('executed');
    expect((await post({ type: 'sales.invoice.submit', payload: {}, idempotency_key: 'k-00000009', channel: 'voice', confirm: true })).body.command.reason).toBe('voice_not_permitted');
  });
  test('developer holds the capability but is capped at Read', async () => {
    mockVerifyAuth.mockResolvedValue(user('u-dev', 'developer'));
    expect((await post({ type: 'crm.lead.list', idempotency_key: 'k-00000010' })).body.command.status).toBe('executed');
    withGrants('u-dev', ['crm.manage']);
    const r = await post({ type: 'crm.lead.create', payload: { lead_name: 'x' }, idempotency_key: 'k-00000011' });
    expect(r.status).toBe(403); expect(r.body.command.reason).toBe('platform_role_read_only');
  });
  test('bridge not configured → 503 on a ref lookup; failed row on execute (never a silent success)', async () => {
    __setErpBridgeClientForTests(null); delete process.env.ERP_BRIDGE_URL;
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    expect((await post({ type: 'crm.lead.list', payload: { customer_ref: 'x' }, idempotency_key: 'k-00000012' })).status).toBe(503);
    const r = await post({ type: 'crm.lead.list', idempotency_key: 'k-00000013' });
    expect(r.status).toBe(502); expect(r.body.command.reason).toBe('bridge_not_configured');
  });
});

describe('POST /commands — entity resolution', () => {
  test('customer_ref resolves exactly via the bridge Read action and is replaced by customer_id', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    const r = await post({ type: 'sales.quotation.create', payload: { customer_ref: 'acme llc', items: [] }, idempotency_key: 'k-00000020' });
    expect(r.status).toBe(200);
    expect(bridge.calls.map((c) => c.action)).toEqual(['list-customers', 'add-quotation']);
    expect(bridge.calls[1].params).toEqual({ customer_id: 'c1', items: [] });
    expect(bridge.calls[0].params).toMatchObject({ search: 'acme llc' });
  });
  test('ambiguous / missing → rejected with candidates, nothing written', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    const r = await post({ type: 'sales.quotation.create', payload: { customer_ref: 'Acme' }, idempotency_key: 'k-00000021' });
    expect(r.body.command).toMatchObject({ status: 'rejected', reason: 'entity_not_found' });
    expect(bridge.calls.map((c) => c.action)).toEqual(['list-customers']);
  });
});

describe('High-risk → approvals (maker-checker)', () => {
  const queue = async () => {
    mockVerifyAuth.mockResolvedValue(user('u-maker', 'admin'));
    const r = await post({ type: 'sales.invoice.cancel', payload: { sales_invoice_id: 'inv1' }, idempotency_key: 'k-00000030', confirm: true });
    expect(r.status).toBe(202);
    expect(r.body.command).toMatchObject({ tier: 'high', status: 'awaiting_approval' });
    expect(r.body.approval.approve_capability).toBe('finance.approve');
    expect(bridge.calls).toHaveLength(0);
    return r.body.approval.approval_id as string;
  };
  test('queues with no_eligible_approver when the tenant has no second approver, still queued', async () => {
    const id = await queue();
    expect(store.approvals[0]).toMatchObject({ id, status: 'pending', reason: 'no_eligible_approver' });
    expect(store.commands[0].reason).toBe('no_eligible_approver');
  });
  test('requester cannot approve own request (even as tenant admin); a second admin with MFA can; then the bridge runs with the approval chain', async () => {
    store.admins = [{ tenant_id: TENANT, user_id: 'u-maker' }, { tenant_id: TENANT, user_id: 'u-checker' }];
    const id = await queue();
    expect(store.commands[0].reason).toBe('awaiting_approval');
    // self
    let r = await request(app).post(`/api/v1/backoffice/approvals/${id}/approve`).send({});
    expect(r.status).toBe(403); expect(r.body.error).toBe('self_approval_forbidden');
    // checker without MFA
    mockVerifyAuth.mockResolvedValue(user('u-checker', 'admin', AAL1));
    r = await request(app).post(`/api/v1/backoffice/approvals/${id}/approve`).send({});
    expect(r.status).toBe(403); expect(r.body.error).toBe('mfa_required');
    // checker from chat
    mockVerifyAuth.mockResolvedValue(user('u-checker', 'admin'));
    r = await request(app).post(`/api/v1/backoffice/approvals/${id}/approve`).send({ channel: 'chat' });
    expect(r.body.error).toBe('approval_requires_approvals_screen');
    // checker, web, aal2
    r = await request(app).post(`/api/v1/backoffice/approvals/${id}/approve`).send({ note: 'ok' });
    expect(r.status).toBe(200); expect(r.body.command.status).toBe('executed');
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toMatchObject({ action: 'cancel-sales-invoice', actor: { user_id: 'u-maker' }, confirmation: { granted: true, approval_id: id, approved_by: 'u-checker', requested_by: 'u-maker' } });
    expect(store.approvals[0]).toMatchObject({ status: 'approved', decided_by: 'u-checker', decision_note: 'ok' });
    expect(store.audit.map((a) => a.event)).toEqual(['command.queued', 'approval.refused', 'approval.refused', 'approval.refused', 'approval.approved']);
    // second decision → 409
    expect((await request(app).post(`/api/v1/backoffice/approvals/${id}/approve`).send({})).status).toBe(409);
  });
  test('approver needs the approve capability, not just any capability; reject path records the note', async () => {
    const id = await queue();
    withGrants('u-sales', ['sales.commit']); mockVerifyAuth.mockResolvedValue(user('u-sales', 'backoffice'));
    expect((await request(app).post(`/api/v1/backoffice/approvals/${id}/approve`).send({})).body.error).toBe('approver_capability_missing');
    withGrants('u-fin', ['finance.approve']); mockVerifyAuth.mockResolvedValue(user('u-fin', 'backoffice'));
    const r = await request(app).post(`/api/v1/backoffice/approvals/${id}/reject`).send({ note: 'wrong invoice' });
    expect(r.status).toBe(200); expect(r.body.command).toMatchObject({ status: 'rejected', reason: 'approval_rejected' });
    expect(bridge.calls).toHaveLength(0);
  });
  test('exafy super-admin queues like everyone and cannot self-approve', async () => {
    mockVerifyAuth.mockResolvedValue(user('u-x', null, AAL2, true));
    const r = await post({ type: 'finance.payment.cancel', payload: { payment_entry_id: 'p1' }, idempotency_key: 'k-00000031', confirm: true });
    expect(r.status).toBe(202);
    expect((await request(app).post(`/api/v1/backoffice/approvals/${r.body.approval.approval_id}/approve`).send({})).body.error).toBe('self_approval_forbidden');
  });
  test('§4.3: payment kind=pay escalates to High-risk with finance.pay; amount over the tenant threshold escalates too', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    let r = await post({ type: 'finance.payment.submit', payload: { payment_entry_id: 'p', kind: 'pay' }, idempotency_key: 'k-00000032', confirm: true });
    expect(r.status).toBe(202); expect(r.body.approval.approve_capability).toBe('finance.pay'); expect(r.body.command.escalations).toEqual(['kind:pay']);
    await store.upsertPolicy({ tenant_id: TENANT, high_risk_amount_threshold: 100, require_mfa_for_high: true, updated_by: null });
    r = await post({ type: 'accounting.journal.submit', payload: { journal_entry_id: 'j', amount: '150.00' }, idempotency_key: 'k-00000033', confirm: true });
    expect(r.status).toBe(202); expect(r.body.approval.approve_capability).toBe('accounting.close');
  });
});

describe('GET /commands, /approvals, /audit, policy', () => {
  test('audit.view sees all rows; others only their own; audit needs audit.view; policy needs approvals.policy', async () => {
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    await post({ type: 'crm.lead.list', idempotency_key: 'k-00000040' });
    withGrants('u-bo', ['crm.view']); mockVerifyAuth.mockResolvedValue(user('u-bo', 'backoffice'));
    await post({ type: 'crm.lead.list', idempotency_key: 'k-00000041' });
    expect((await request(app).get('/api/v1/backoffice/commands')).body.commands).toHaveLength(1);
    expect((await request(app).get('/api/v1/backoffice/audit')).status).toBe(403);
    expect((await request(app).put('/api/v1/backoffice/policy').send({ high_risk_amount_threshold: 1, require_mfa_for_high: false })).status).toBe(403);
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    expect((await request(app).get('/api/v1/backoffice/commands')).body.commands).toHaveLength(2);
    expect((await request(app).get('/api/v1/backoffice/audit')).body.audit).toHaveLength(2);
    const p = await request(app).put('/api/v1/backoffice/policy').send({ high_risk_amount_threshold: 5000, require_mfa_for_high: true });
    expect(p.status).toBe(200); expect(p.body.policy.high_risk_amount_threshold).toBe(5000);
    expect((await request(app).get('/api/v1/backoffice/policy')).body.policy.high_risk_amount_threshold).toBe(5000);
    expect(store.audit.at(-1)!.event).toBe('policy.updated');
    expect((await request(app).get('/api/v1/backoffice/commands/nope')).status).toBe(404);
    const cat = await request(app).get('/api/v1/backoffice/commands-catalog');
    expect(cat.body.commands).toHaveLength(164);
  });
  test('approvals list is denied to a user with no capabilities and carries can_decide', async () => {
    withGrants('u-none', []); mockVerifyAuth.mockResolvedValue(user('u-none', 'backoffice'));
    expect((await request(app).get('/api/v1/backoffice/approvals')).status).toBe(403);
    mockVerifyAuth.mockResolvedValue(user('u1', 'admin'));
    await post({ type: 'sales.invoice.cancel', payload: {}, idempotency_key: 'k-00000050', confirm: true });
    const r = await request(app).get('/api/v1/backoffice/approvals');
    expect(r.body.approvals).toHaveLength(1); expect(r.body.approvals[0].can_decide).toBe(false);   // own request
  });
});

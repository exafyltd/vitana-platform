import express from 'express';
import request from 'supertest';
import { buildVcaopRouter } from '../../src/api/router';
import { InMemoryRepository } from '../../src/api/repository';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { seedPolicyEngine } from '../../src/policy/provider-policy-seeds';
import { PolicyEngine } from '../../src/guardrails/policy-engine';

function makeApp() {
  const repo = new InMemoryRepository();
  const oasis = new InMemoryOasisSink();
  const policyEngine = seedPolicyEngine(new PolicyEngine());
  const app = express();
  app.use('/api/v1/vcaop', buildVcaopRouter({ repo, oasis, policyEngine, source: 'test' }));
  return { app, repo, oasis, policyEngine };
}

const as = (role: string, userId = 'u1', tenant = 'platform') => ({
  'x-user-id': userId,
  'x-role': role,
  'x-tenant-id': tenant,
});

describe('CTRL-API-0004 — VCAOP API', () => {
  test('unauthenticated request is 401', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/api/v1/vcaop/providers');
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
  });

  test('community cannot read providers (403)', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/api/v1/vcaop/providers').set(as('community'));
    expect(r.status).toBe(403);
  });

  test('staff can read providers', async () => {
    const { app, repo } = makeApp();
    await repo.create('provider', { id: 'amazon', name: 'Amazon', category: 'marketplace', policy: {} });
    const r = await request(app).get('/api/v1/vcaop/providers').set(as('staff'));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('only admin can set policy; write emits an OASIS event', async () => {
    const { app, oasis } = makeApp();
    const policy = { automation_allowed: 'api_only', registration_method: 'human_required', captcha_policy: 'human_only', kyb_required: true, multi_account_allowed: false, affiliate_cashback_allowed: null, notes: 't' };
    const staff = await request(app).put('/api/v1/vcaop/policies/foo').set(as('staff')).send({ policy });
    expect(staff.status).toBe(403);
    const admin = await request(app).put('/api/v1/vcaop/policies/foo').set(as('admin')).send({ policy });
    expect(admin.status).toBe(200);
    expect(oasis.events.some((e) => e.type === 'vcaop.policy.updated')).toBe(true);
  });

  test('account creation enforces single-identity (409 on second active)', async () => {
    const { app, repo } = makeApp();
    await repo.create('provider', { id: 'amazon', name: 'Amazon', category: 'm', policy: { multi_account_allowed: false } });
    const first = await request(app).post('/api/v1/vcaop/accounts').set(as('staff')).send({ provider_id: 'amazon' });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/v1/vcaop/accounts').set(as('staff')).send({ provider_id: 'amazon' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SINGLE_IDENTITY');
  });

  test('multi_account_allowed policy permits a second account', async () => {
    const { app, repo } = makeApp();
    await repo.create('provider', { id: 'aff', name: 'Aff', category: 'm', policy: { multi_account_allowed: true } });
    await request(app).post('/api/v1/vcaop/accounts').set(as('staff')).send({ provider_id: 'aff' });
    const second = await request(app).post('/api/v1/vcaop/accounts').set(as('staff')).send({ provider_id: 'aff' });
    expect(second.status).toBe(201);
  });

  test('account responses never expose credential/secret references', async () => {
    const { app, repo } = makeApp();
    await repo.create('provider', { id: 'amazon', name: 'A', category: 'm', policy: {} });
    await repo.create('provider_account', {
      id: 'acc1', tenant_id: 'platform', provider_id: 'amazon', status: 'active',
      credential_ref: 'sm://secret/should-not-leak', mfa_seed_ref: 'sm://totp/x',
    });
    const r = await request(app).get('/api/v1/vcaop/accounts').set(as('staff'));
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toMatch(/credential_ref/);
    expect(body).not.toMatch(/should-not-leak/);
    expect(body).not.toMatch(/mfa_seed_ref/);
  });

  test('rewards: community sees only own rows; staff sees all (RLS)', async () => {
    const { app, repo } = makeApp();
    await repo.seed('rewards_ledger', [
      { id: 'r1', user_id: 'u1', amount: 5, state: 'pending' },
      { id: 'r2', user_id: 'u2', amount: 9, state: 'pending' },
    ]);
    const mine = await request(app).get('/api/v1/vcaop/rewards').set(as('community', 'u1'));
    expect(mine.body.data.map((x: any) => x.id)).toEqual(['r1']);
    const all = await request(app).get('/api/v1/vcaop/rewards').set(as('staff', 'sx'));
    expect(all.body.data.length).toBe(2);
  });

  test('human task create requires a valid HUMAN_REQUIRED type; approvals are admin-only', async () => {
    const { app } = makeApp();
    const bad = await request(app).post('/api/v1/vcaop/tasks').set(as('staff')).send({ type: 'NONSENSE' });
    expect(bad.status).toBe(400);
    const created = await request(app).post('/api/v1/vcaop/tasks').set(as('staff')).send({ type: 'KYB' });
    expect(created.status).toBe(201);
    const taskId = created.body.data.id;
    const staffApprove = await request(app).post(`/api/v1/vcaop/approvals/${taskId}`).set(as('staff')).send({});
    expect(staffApprove.status).toBe(403); // staff cannot satisfy a human gate alone (Sec. 5)
    const adminApprove = await request(app).post(`/api/v1/vcaop/approvals/${taskId}`).set(as('admin')).send({ decision: 'approve' });
    expect(adminApprove.status).toBe(200);
    expect(adminApprove.body.data.status).toBe('approved');
  });

  test('community can open own cart; write emits OASIS', async () => {
    const { app, oasis } = makeApp();
    const r = await request(app).post('/api/v1/vcaop/cart').set(as('community', 'u9')).send({});
    expect(r.status).toBe(201);
    expect(r.body.data.user_id).toBe('u9');
    expect(oasis.events.some((e) => e.type === 'vcaop.cart.created')).toBe(true);
  });
});

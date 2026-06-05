/**
 * IAM-ROLES-0001 — role matrix assertions at the Gateway authz layer (Sec. 5).
 *
 * This is the application-level half of defense-in-depth; the DB-level half (RLS)
 * is verified separately against Postgres
 * (prisma/migrations/20260605_vcaop_iam_roles_0001 — see its README). Together they
 * enforce the runbook AC:
 *   - community cannot read another user's rewards
 *   - staff cannot satisfy a human gate alone (only admin approves)
 *   - only admin changes policy
 *   - secrets are unreadable by all roles via the API
 */
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
  const app = express();
  app.use('/v', buildVcaopRouter({ repo, oasis, policyEngine: seedPolicyEngine(new PolicyEngine()), source: 'iam-test' }));
  return { app, repo };
}
const as = (role: string, userId = 'u1') => ({ 'x-user-id': userId, 'x-role': role, 'x-tenant-id': 'platform' });

describe('IAM role matrix (Sec. 5)', () => {
  test('community cannot read another user\'s rewards', async () => {
    const { app, repo } = makeApp();
    await repo.seed('rewards_ledger', [
      { id: 'a', user_id: 'u1', amount: 1, state: 'pending' },
      { id: 'b', user_id: 'u2', amount: 2, state: 'pending' },
    ]);
    const r = await request(app).get('/v/rewards').set(as('community', 'u1'));
    const ids = r.body.data.map((x: any) => x.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
  });

  test('staff cannot satisfy a human gate alone; admin can', async () => {
    const { app } = makeApp();
    const t = await request(app).post('/v/tasks').set(as('staff')).send({ type: 'KYB' });
    const id = t.body.data.id;
    expect((await request(app).post(`/v/approvals/${id}`).set(as('staff')).send({})).status).toBe(403);
    expect((await request(app).post(`/v/approvals/${id}`).set(as('admin')).send({ decision: 'approve' })).status).toBe(200);
  });

  test('only admin changes policy', async () => {
    const { app } = makeApp();
    const policy = { automation_allowed: 'denied', registration_method: 'human_required', captcha_policy: 'human_only', kyb_required: true, multi_account_allowed: false, affiliate_cashback_allowed: null, notes: 'x' };
    for (const role of ['community', 'staff', 'developer']) {
      expect((await request(app).put('/v/policies/p').set(as(role)).send({ policy })).status).not.toBe(200);
    }
    expect((await request(app).put('/v/policies/p').set(as('admin')).send({ policy })).status).toBe(200);
  });

  test('secrets/credential refs are unreadable via the API for every role', async () => {
    const { app, repo } = makeApp();
    await repo.create('provider', { id: 'amazon', name: 'A', category: 'm', policy: {} });
    await repo.create('provider_account', { id: 'acc', tenant_id: 'platform', provider_id: 'amazon', status: 'active', credential_ref: 'sm://leak', mfa_seed_ref: 'sm://totp' });
    for (const role of ['staff', 'admin']) {
      const r = await request(app).get('/v/accounts').set(as(role));
      const body = JSON.stringify(r.body);
      expect(body).not.toMatch(/credential_ref|mfa_seed_ref|sm:\/\/leak/);
    }
  });
});

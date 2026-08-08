/** Phase 3 — portal API authz + tenant isolation over supertest. */
import express from 'express';
import request from 'supertest';
import { buildPortalRouter } from '../../src/portal/router';
import {
  InMemoryConnectionRepository,
  PartnerOnboardingService,
} from '../../src/portal/onboarding-service';
import { headerAuthResolver } from '../../src/api/authz';
import { PolicyEngine } from '../../src/guardrails/policy-engine';
import { SandboxSupplierTransport } from '../factory/sandbox-transport';
import spec from '../factory/fixtures/sandbox-supplier-openapi.json';

function makeApp() {
  const pe = new PolicyEngine();
  pe.setPolicy('sandbox_supplier', {
    automation_allowed: 'api_only',
    registration_method: 'human_required',
    captcha_policy: 'human_only',
    kyb_required: true,
    multi_account_allowed: false,
    affiliate_cashback_allowed: null,
    notes: 'sandbox fixture policy (test)',
  });
  const service = new PartnerOnboardingService({
    repo: new InMemoryConnectionRepository(),
    policyEngine: pe,
    emit: () => undefined,
    transportFor: () => new SandboxSupplierTransport(),
  });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1/vcaop/portal', buildPortalRouter({ service, authResolver: headerAuthResolver }));
  return { app, service };
}

const as = (role: string, tenant = 'tenant-a') => ({
  'x-user-id': `${role}-1`,
  'x-role': role,
  'x-tenant-id': tenant,
});

const startBody = {
  name: 'Sandbox Supplier GmbH',
  connector_id: 'sandbox-supplier',
  provider_id: 'sandbox_supplier',
  openapi_document: spec,
};

describe('portal API', () => {
  test('community role is denied everywhere; unauthenticated is 401', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/api/v1/vcaop/portal/connections')).status).toBe(401);
    expect(
      (await request(app).get('/api/v1/vcaop/portal/connections').set(as('community'))).status,
    ).toBe(403);
    expect(
      (await request(app).post('/api/v1/vcaop/portal/connections').set(as('community')).send(startBody)).status,
    ).toBe(403);
  });

  test('staff can run the wizard up to certification; activation is ADMIN-only', async () => {
    const { app } = makeApp();
    const created = await request(app).post('/api/v1/vcaop/portal/connections').set(as('staff')).send(startBody);
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    // Review + re-test as staff.
    const decision = await request(app)
      .post(`/api/v1/vcaop/portal/connections/${id}/mapping-decisions`)
      .set(as('staff'))
      .send({ source_schema: 'OrderRequest', source_field: 'customer_email', decision: 'approve' });
    expect(decision.status).toBe(200);

    const tested = await request(app).post(`/api/v1/vcaop/portal/connections/${id}/sandbox-tests`).set(as('staff'));
    expect(tested.status).toBe(200);
    expect(tested.body.data.certification_status).toBe('certified');

    // Staff cannot give the one-approval activation…
    expect(
      (await request(app).post(`/api/v1/vcaop/portal/connections/${id}/approve-activation`).set(as('staff'))).status,
    ).toBe(403);
    // …admin can.
    const activated = await request(app)
      .post(`/api/v1/vcaop/portal/connections/${id}/approve-activation`)
      .set(as('admin'));
    expect(activated.status).toBe(200);
    expect(activated.body.data.state).toBe('active');
  }, 30000);

  test('tenant isolation: another tenant’s connection reads as 404', async () => {
    const { app } = makeApp();
    const created = await request(app).post('/api/v1/vcaop/portal/connections').set(as('staff')).send(startBody);
    const id = created.body.data.id;
    const foreign = await request(app)
      .get(`/api/v1/vcaop/portal/connections/${id}/mapping-preview`)
      .set(as('staff', 'tenant-b'));
    expect(foreign.status).toBe(404);
  });

  test('mapping preview + activation summary responses carry no refs/secrets', async () => {
    const { app } = makeApp();
    const created = await request(app).post('/api/v1/vcaop/portal/connections').set(as('staff')).send(startBody);
    const id = created.body.data.id;
    const preview = await request(app).get(`/api/v1/vcaop/portal/connections/${id}/mapping-preview`).set(as('staff'));
    const summary = await request(app)
      .get(`/api/v1/vcaop/portal/connections/${id}/activation-summary`)
      .set(as('staff'));
    for (const res of [preview, summary]) {
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      // Field NAMES like customer_ref are the preview's purpose; what must
      // never appear is vault reference material or the auth secret block.
      expect(body).not.toMatch(/vault:/);
      expect(body).not.toMatch(/secret_refs/);
      expect(body).not.toMatch(/\S+@\S+\.\S+/);
    }
  });

  test('decided_by is always the authenticated user, never client-supplied', async () => {
    const { app, service } = makeApp();
    const created = await request(app).post('/api/v1/vcaop/portal/connections').set(as('staff')).send(startBody);
    const id = created.body.data.id;
    await request(app)
      .post(`/api/v1/vcaop/portal/connections/${id}/mapping-decisions`)
      .set(as('staff'))
      .send({
        source_schema: 'OrderRequest',
        source_field: 'customer_email',
        decision: 'approve',
        decided_by: 'spoofed-admin', // must be ignored
      });
    const rec = await service.getConnection('tenant-a', id);
    expect(rec!.decisions[0].decided_by).toBe('staff-1');
  });
});

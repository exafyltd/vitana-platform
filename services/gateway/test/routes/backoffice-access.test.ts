/**
 * VTID-03834 — /api/v1/backoffice access routes.
 * Auth is the shared lib/tenant-role-auth (extracted verbatim from role-admin); mocked here.
 * PostgREST is reached with global fetch; mocked per test.
 */
import request from 'supertest';
import express from 'express';

const mockVerifyAuth = jest.fn();
const mockCanManageRoles = jest.fn();
jest.mock('../../src/lib/tenant-role-auth', () => ({
  verifyAuth: (...a: any[]) => mockVerifyAuth(...a),
  canManageRoles: (...a: any[]) => mockCanManageRoles(...a),
  getBearerToken: () => 'tok',
}));

import backofficeAccessRouter, { requireErpCapability } from '../../src/routes/backoffice-access';

const app = express();
app.use(express.json());
app.use('/api/v1/backoffice', backofficeAccessRouter);
app.get('/api/v1/backoffice/guarded', requireErpCapability('finance.pay'), (_req, res) => res.json({ ok: true, guarded: true }));

const TENANT = '11111111-1111-1111-1111-111111111111';
const ADMIN = { ok: true, user_id: 'u-admin', email: 'a@x', is_exafy_admin: false, tenant_id: TENANT, active_role: 'admin', token: 't' };
const BO = { ok: true, user_id: 'u-bo', email: 'b@x', is_exafy_admin: false, tenant_id: TENANT, active_role: 'backoffice', token: 't' };
const EXAFY = { ok: true, user_id: 'u-x', email: 'x@x', is_exafy_admin: true, tenant_id: TENANT, active_role: null, token: 't' };

let fetchMock: jest.Mock;
function grantsResponse(rows: any[]) { return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) }; }

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://sb.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  fetchMock = jest.fn(async () => grantsResponse([]));
  (global as any).fetch = fetchMock;
  mockCanManageRoles.mockResolvedValue({ allowed: true });
});

describe('GET /me', () => {
  test('401 without identity (mount proof: JSON, not HTML)', async () => {
    mockVerifyAuth.mockResolvedValue({ ok: false, status: 401, error: 'UNAUTHENTICATED' });
    const r = await request(app).get('/api/v1/backoffice/me');
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  test('tenant admin: defaults (incl. erp.admin, no finance.pay) ∪ explicit grants', async () => {
    mockVerifyAuth.mockResolvedValue(ADMIN);
    fetchMock.mockResolvedValueOnce(grantsResponse([{ user_id: 'u-admin', tenant_id: TENANT, capability: 'finance.pay', granted_by: 'u-x', granted_at: 'now' }]));
    const r = await request(app).get('/api/v1/backoffice/me');
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('admin');
    expect(r.body.defaults).toContain('erp.admin');
    expect(r.body.defaults).not.toContain('finance.pay');
    expect(r.body.explicit).toEqual(['finance.pay']);
    expect(r.body.capabilities).toContain('finance.pay');
    expect(r.body.can_manage_access).toBe(true);
    expect(r.body.catalog).toHaveLength(30);
    // grants were read for THIS user in THIS tenant only
    expect(fetchMock.mock.calls[0][0]).toContain(`tenant_id=eq.${TENANT}`);
    expect(fetchMock.mock.calls[0][0]).toContain('user_id=eq.u-admin');
  });

  test('backoffice role with no grants: empty capabilities, cannot manage access', async () => {
    mockVerifyAuth.mockResolvedValue(BO);
    const r = await request(app).get('/api/v1/backoffice/me');
    expect(r.status).toBe(200);
    expect(r.body.capabilities).toEqual([]);
    expect(r.body.can_manage_access).toBe(false);
  });

  test('a failing grants read fails closed on explicit grants but keeps role defaults', async () => {
    mockVerifyAuth.mockResolvedValue(ADMIN);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
    const r = await request(app).get('/api/v1/backoffice/me');
    expect(r.status).toBe(200);
    expect(r.body.explicit).toEqual([]);
    expect(r.body.capabilities).toContain('erp.admin');
  });
});

describe('requireErpCapability middleware', () => {
  test('403 names the missing capability; 200 when held via explicit grant', async () => {
    mockVerifyAuth.mockResolvedValue(ADMIN);
    let r = await request(app).get('/api/v1/backoffice/guarded');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, error: 'FORBIDDEN', required: 'finance.pay' });
    fetchMock.mockResolvedValueOnce(grantsResponse([{ user_id: 'u-admin', tenant_id: TENANT, capability: 'finance.pay' }]));
    r = await request(app).get('/api/v1/backoffice/guarded');
    expect(r.status).toBe(200);
    expect(r.body.guarded).toBe(true);
  });
});

describe('GET /access', () => {
  test('403 for a backoffice user without erp.admin; 200 grouped per user for a tenant admin', async () => {
    mockVerifyAuth.mockResolvedValue(BO);
    let r = await request(app).get('/api/v1/backoffice/access');
    expect(r.status).toBe(403);
    mockVerifyAuth.mockResolvedValue(ADMIN);
    fetchMock
      .mockResolvedValueOnce(grantsResponse([])) // caller's own grants (resolveAccess)
      .mockResolvedValueOnce(grantsResponse([
        { user_id: 'u1', tenant_id: TENANT, capability: 'crm.view', granted_by: 'u-admin', granted_at: 't' },
        { user_id: 'u1', tenant_id: TENANT, capability: 'crm.manage', granted_by: 'u-admin', granted_at: 't' },
        { user_id: 'u2', tenant_id: TENANT, capability: 'reports.view', granted_by: 'u-admin', granted_at: 't' },
      ]));
    r = await request(app).get('/api/v1/backoffice/access');
    expect(r.status).toBe(200);
    expect(r.body.tenant_id).toBe(TENANT);
    expect(r.body.users).toEqual([
      expect.objectContaining({ user_id: 'u1', capabilities: ['crm.view', 'crm.manage'] }),
      expect.objectContaining({ user_id: 'u2', capabilities: ['reports.view'] }),
    ]);
    expect(fetchMock.mock.calls[1][0]).toContain(`tenant_id=eq.${TENANT}`);
  });

  test('a non-exafy caller cannot read another tenant via ?tenant_id', async () => {
    mockVerifyAuth.mockResolvedValue(ADMIN);
    fetchMock.mockResolvedValue(grantsResponse([]));
    const r = await request(app).get('/api/v1/backoffice/access?tenant_id=22222222-2222-2222-2222-222222222222');
    expect(r.status).toBe(200);
    expect(r.body.tenant_id).toBe(TENANT);
  });
});

describe('POST /access/grant', () => {
  test('validates the capability against the catalog', async () => {
    mockVerifyAuth.mockResolvedValue(ADMIN);
    const r = await request(app).post('/api/v1/backoffice/access/grant').send({ user_id: 'u1', capability: 'nope.x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_CAPABILITY');
  });

  test('tenant admin grants sales.draft: POST to erp_capability_grants with granted_by and tenant scope', async () => {
    mockVerifyAuth.mockResolvedValue(ADMIN);
    fetchMock
      .mockResolvedValueOnce(grantsResponse([]))
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => [{}], text: async () => '' });
    const r = await request(app).post('/api/v1/backoffice/access/grant').send({ user_id: 'u1', capability: 'sales.draft' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, capability: 'sales.draft', tenant_id: TENANT, granted_by: 'u-admin', explicit_only: false });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://sb.example/rest/v1/erp_capability_grants');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ user_id: 'u1', tenant_id: TENANT, capability: 'sales.draft', granted_by: 'u-admin' });
  });

  test('duplicate grant is idempotent (200, already granted)', async () => {
    mockVerifyAuth.mockResolvedValue(ADMIN);
    fetchMock
      .mockResolvedValueOnce(grantsResponse([]))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}), text: async () => 'duplicate key value violates unique constraint' });
    const r = await request(app).post('/api/v1/backoffice/access/grant').send({ user_id: 'u1', capability: 'sales.draft' });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/already granted/);
  });

  test('hr.* can be granted by a tenant admin, NOT by a delegated erp.admin holder', async () => {
    mockVerifyAuth.mockResolvedValue({ ...BO });
    fetchMock.mockResolvedValueOnce(grantsResponse([{ user_id: 'u-bo', tenant_id: TENANT, capability: 'erp.admin' }]));
    let r = await request(app).post('/api/v1/backoffice/access/grant').send({ user_id: 'u1', capability: 'hr.view' });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/personal-data/);
    mockVerifyAuth.mockResolvedValue(ADMIN);
    fetchMock
      .mockResolvedValueOnce(grantsResponse([]))
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => [{}], text: async () => '' });
    r = await request(app).post('/api/v1/backoffice/access/grant').send({ user_id: 'u1', capability: 'hr.view' });
    expect(r.status).toBe(200);
    expect(r.body.explicit_only).toBe(true);
  });

  test('target outside the tenant is refused (canManageRoles membership check)', async () => {
    mockVerifyAuth.mockResolvedValue(ADMIN);
    mockCanManageRoles.mockResolvedValue({ allowed: false, reason: 'Target user is not in your tenant' });
    const r = await request(app).post('/api/v1/backoffice/access/grant').send({ user_id: 'u9', capability: 'sales.draft' });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/not in your tenant/);
  });

  test('a backoffice user without erp.admin cannot grant at all', async () => {
    mockVerifyAuth.mockResolvedValue(BO);
    const r = await request(app).post('/api/v1/backoffice/access/grant').send({ user_id: 'u1', capability: 'sales.draft' });
    expect(r.status).toBe(403);
  });
});

describe('POST /access/revoke', () => {
  test('DELETE scoped to user × tenant × capability', async () => {
    mockVerifyAuth.mockResolvedValue(EXAFY);
    fetchMock
      .mockResolvedValueOnce(grantsResponse([]))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
    const r = await request(app).post('/api/v1/backoffice/access/revoke').send({ user_id: 'u1', capability: 'sales.draft' });
    expect(r.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[1];
    expect(init.method).toBe('DELETE');
    expect(url).toContain('user_id=eq.u1');
    expect(url).toContain(`tenant_id=eq.${TENANT}`);
    expect(url).toContain('capability=eq.sales.draft');
  });
});

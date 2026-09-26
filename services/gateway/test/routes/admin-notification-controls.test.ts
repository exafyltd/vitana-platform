/**
 * VTID-04674: /api/v1/admin/tenants/:tenantId/notification-controls
 * Real requireTenantAdmin; only token verification and the tenant-role lookup are stubbed.
 */
import request from 'supertest';
import express from 'express';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

const identities: Record<string, any> = {
  exafy: { user_id: 'u-exafy', email: 'boss@exafy.io', exafy_admin: true, tenant_id: OTHER },
  tadmin: { user_id: 'u-admin', email: 'admin@t.io', exafy_admin: false, tenant_id: TENANT },
  member: { user_id: 'u-member', email: 'm@t.io', exafy_admin: false, tenant_id: TENANT },
};

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  verifyAndExtractIdentity: jest.fn(async (token: string) =>
    identities[token] ? { identity: identities[token], claims: {}, auth_source: 'test' } : null),
}));

jest.mock('../../src/middleware/require-tenant-admin-repository', () => ({
  fetchCallerActiveRoleForTenant: jest.fn(async (_sb: any, userId: string) => ({
    data: { active_role: userId === 'u-admin' ? 'admin' : 'community' },
    error: null,
  })),
}));

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({})) }));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({}) }));

const mockSvc = {
  listNotificationControls: jest.fn(),
  setNotificationControl: jest.fn(),
  getNotificationControlAudit: jest.fn(),
  getNotificationActivity: jest.fn(),
};
jest.mock('../../src/services/notification-controls/notification-controls-service', () => {
  const actual = jest.requireActual('../../src/services/notification-controls/notification-controls-service');
  return {
    NotificationControlError: actual.NotificationControlError,
    listNotificationControls: (...a: any[]) => mockSvc.listNotificationControls(...a),
    setNotificationControl: (...a: any[]) => mockSvc.setNotificationControl(...a),
    getNotificationControlAudit: (...a: any[]) => mockSvc.getNotificationControlAudit(...a),
    getNotificationActivity: (...a: any[]) => mockSvc.getNotificationActivity(...a),
  };
});

process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE = 'service-role';
delete process.env.SUPABASE_SERVICE_ROLE_KEY; // the task definitions only set SUPABASE_SERVICE_ROLE

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../src/routes/admin-notification-controls').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NotificationControlError } = jest.requireActual('../../src/services/notification-controls/notification-controls-service');

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/notification-controls', router);
const base = (t = TENANT) => `/api/v1/admin/tenants/${t}/notification-controls`;

beforeEach(() => {
  jest.clearAllMocks();
  mockSvc.listNotificationControls.mockResolvedValue({ controls: [], stats_error: null, categories_error: null, audience: {} });
  mockSvc.setNotificationControl.mockResolvedValue({ type: 'post_like', source_key: '', old_enabled: false, new_enabled: true });
  mockSvc.getNotificationActivity.mockResolvedValue([]);
  mockSvc.getNotificationControlAudit.mockResolvedValue([]);
});

describe('access', () => {
  test('no token → 401', async () => {
    expect((await request(app).get(base())).status).toBe(401);
  });
  test('a member → 403', async () => {
    expect((await request(app).get(base()).set('Authorization', 'Bearer member')).status).toBe(403);
  });
  test('an admin of another tenant → 403', async () => {
    expect((await request(app).get(base(OTHER)).set('Authorization', 'Bearer tadmin')).status).toBe(403);
  });
  test('tenant admin (role looked up with SUPABASE_SERVICE_ROLE) → 200', async () => {
    const r = await request(app).get(base()).set('Authorization', 'Bearer tadmin');
    expect(r.status).toBe(200);
    expect(mockSvc.listNotificationControls).toHaveBeenCalledWith(expect.anything(), TENANT, 7);
  });
  test('exafy admin, any tenant → 200', async () => {
    expect((await request(app).get(base()).set('Authorization', 'Bearer exafy')).status).toBe(200);
  });
});

describe('PATCH /:type', () => {
  test('passes the switch, reason, automation and actor through', async () => {
    const r = await request(app).patch(`${base()}/orb_suggestion`).set('Authorization', 'Bearer tadmin')
      .send({ enabled: true, reason: 'go', source_key: 'AP-1601' });
    expect(r.status).toBe(200);
    expect(mockSvc.setNotificationControl).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT, type: 'orb_suggestion', sourceKey: 'AP-1601', enabled: true, reason: 'go',
      actorUserId: 'u-admin', actorEmail: 'admin@t.io',
    });
  });
  test('English-only text → 409', async () => {
    mockSvc.setNotificationControl.mockRejectedValue(new NotificationControlError('not_localized', 'English only'));
    const r = await request(app).patch(`${base()}/admin_digest`).set('Authorization', 'Bearer tadmin').send({ enabled: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NOT_LOCALIZED');
  });
  test('bad input → 400', async () => {
    mockSvc.setNotificationControl.mockRejectedValue(new NotificationControlError('invalid_input', 'enabled must be true or false'));
    expect((await request(app).patch(`${base()}/post_like`).set('Authorization', 'Bearer tadmin').send({})).status).toBe(400);
  });
});

describe('reads', () => {
  test('activity clamps days to 90', async () => {
    await request(app).get(`${base()}/activity?days=500`).set('Authorization', 'Bearer tadmin');
    expect(mockSvc.getNotificationActivity).toHaveBeenCalledWith(expect.anything(), TENANT, 90);
  });
  test('a failed read is an error, not an empty list', async () => {
    mockSvc.getNotificationActivity.mockRejectedValue(new Error('timeout'));
    const r = await request(app).get(`${base()}/activity`).set('Authorization', 'Bearer tadmin');
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
  });
  test('audit for one type', async () => {
    const r = await request(app).get(`${base()}/post_like/audit`).set('Authorization', 'Bearer tadmin');
    expect(r.status).toBe(200);
    expect(mockSvc.getNotificationControlAudit).toHaveBeenCalledWith(expect.anything(), TENANT, 'post_like', 50);
  });
});

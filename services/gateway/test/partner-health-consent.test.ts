// VTID-03885 — HTTP tests for the Partner Health Test Integration
// self-service consent routes.
//
// Contract under test (mounted at /api/v1/partner-health/consent,
// requireAuthWithTenant-gated — the user's own identity, not admin):
//   - auth: 401 without an identity
//   - GET /: 400 without partner_key/scope, happy path (checks consent)
//   - POST /grant: 400 without partner_key/scope, happy path
//   - POST /revoke: 400 without partner_key/scope, happy path

import express from 'express';
import request from 'supertest';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID = 'tenant-1';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer user-1') {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    req.identity = { user_id: USER_ID, tenant_id: TENANT_ID };
    return next();
  },
}));

const checkDataSharingConsentMock = jest.fn();
const grantDataSharingConsentMock = jest.fn();
const revokeDataSharingConsentMock = jest.fn();
jest.mock('../src/services/partner-health/consent', () => ({
  checkDataSharingConsent: (...args: any[]) => checkDataSharingConsentMock(...args),
  grantDataSharingConsent: (...args: any[]) => grantDataSharingConsentMock(...args),
  revokeDataSharingConsent: (...args: any[]) => revokeDataSharingConsentMock(...args),
}));

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/partner-health-consent').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/partner-health/consent', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('partner-health-consent — auth', () => {
  it('401 without a user token', async () => {
    const r = await request(makeApp()).get('/api/v1/partner-health/consent?partner_key=doctorbox&scope=result_ingestion');
    expect(r.status).toBe(401);
  });
});

describe('GET /', () => {
  it('400 without partner_key/scope', async () => {
    const r = await request(makeApp())
      .get('/api/v1/partner-health/consent')
      .set('Authorization', 'Bearer user-1');
    expect(r.status).toBe(400);
  });

  it('400 on an unrecognized scope', async () => {
    const r = await request(makeApp())
      .get('/api/v1/partner-health/consent?partner_key=doctorbox&scope=not_a_real_scope')
      .set('Authorization', 'Bearer user-1');
    expect(r.status).toBe(400);
  });

  it('200 happy path — reports the real granted state', async () => {
    checkDataSharingConsentMock.mockResolvedValue(true);
    const r = await request(makeApp())
      .get('/api/v1/partner-health/consent?partner_key=doctorbox&scope=result_ingestion')
      .set('Authorization', 'Bearer user-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, granted: true });
    expect(checkDataSharingConsentMock).toHaveBeenCalledWith(
      expect.anything(),
      { user_id: USER_ID, tenant_id: TENANT_ID },
      'partner_integration',
      'doctorbox',
      'result_ingestion',
    );
  });
});

describe('POST /grant', () => {
  it('400 without partner_key/scope', async () => {
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({});
    expect(r.status).toBe(400);
  });

  it('200 happy path — grants via settings_connected_apps', async () => {
    grantDataSharingConsentMock.mockResolvedValue({ ok: true });
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(grantDataSharingConsentMock).toHaveBeenCalledWith(
      expect.anything(),
      { user_id: USER_ID, tenant_id: TENANT_ID },
      'partner_integration',
      'doctorbox',
      'result_ingestion',
      'settings_connected_apps',
    );
  });

  it('500 when the grant fails', async () => {
    grantDataSharingConsentMock.mockResolvedValue({ ok: false, error: 'db error' });
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(r.status).toBe(500);
  });
});

describe('POST /revoke', () => {
  it('400 without partner_key/scope', async () => {
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/revoke')
      .set('Authorization', 'Bearer user-1')
      .send({});
    expect(r.status).toBe(400);
  });

  it('200 happy path — idempotent revoke', async () => {
    revokeDataSharingConsentMock.mockResolvedValue({ ok: true });
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/revoke')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});

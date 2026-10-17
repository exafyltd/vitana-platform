// VTID-03885 / VTID-05092 — HTTP tests for the legacy Partner Health consent
// routes (mounted at /api/v1/partner-health/consent, requireAuthWithTenant).
//
// Contract under test:
//   - auth: 401 without an identity
//   - GET /: 400 without partner_key/scope, reports the real granted state
//   - POST /grant, /revoke: delegate to the health-consent service with
//     category partner_results (VTID-05092): partner_key validated against
//     partner_registry (UNKNOWN_RESOURCE), text_version 'legacy-03885',
//     one-transaction write, OASIS health.consent.* on a change, 503 before
//     the migration, order_tracking writes refused (no category)

import express from 'express';
import fs from 'fs';
import path from 'path';
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
jest.mock('../src/services/partner-health/consent', () => ({
  checkDataSharingConsent: (...args: any[]) => checkDataSharingConsentMock(...args),
}));

const setHealthConsentMock = jest.fn();
jest.mock('../src/services/consent/health-consent', () => {
  const actual = jest.requireActual('../src/services/consent/health-consent');
  return { ...actual, setHealthConsent: (...a: any[]) => setHealthConsentMock(...a) };
});

const emitOasisEventMock = jest.fn();
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
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

function change(over: Record<string, unknown> = {}) {
  return {
    ok: true, changed: true, action: 'grant', category: 'partner_results', resource_type: 'partner_integration',
    resource_id: 'doctorbox', scope: 'result_ingestion', text_version: 'legacy-03885', shown_locale: null,
    granted_via: 'settings_connected_apps', granted_at: 't', revoked_at: null, consent_id: 'c1', event_id: 'e1', ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  emitOasisEventMock.mockResolvedValue({ ok: true });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('partner-health-consent — auth', () => {
  it('401 without a user token', async () => {
    const r = await request(makeApp()).get('/api/v1/partner-health/consent?partner_key=doctorbox&scope=result_ingestion');
    expect(r.status).toBe(401);
  });

  it('401 on grant/revoke without a user token, nothing written', async () => {
    expect((await request(makeApp()).post('/api/v1/partner-health/consent/grant').send({ partner_key: 'doctorbox', scope: 'result_ingestion' })).status).toBe(401);
    expect((await request(makeApp()).post('/api/v1/partner-health/consent/revoke').send({ partner_key: 'doctorbox', scope: 'result_ingestion' })).status).toBe(401);
    expect(setHealthConsentMock).not.toHaveBeenCalled();
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

  it('200 — delegates to partner_results with the legacy text version, then emits health.consent.granted', async () => {
    setHealthConsentMock.mockResolvedValue(change());
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'result_ingestion', user_id: 'someone-else' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(setHealthConsentMock).toHaveBeenCalledTimes(1);
    expect(setHealthConsentMock.mock.calls[0][1]).toMatchObject({
      identity: { user_id: USER_ID, tenant_id: TENANT_ID },
      category: 'partner_results',
      resource_id: 'doctorbox',
      action: 'grant',
      granted_via: 'settings_connected_apps',
      text_version: 'legacy-03885',
      locale: null,
      actor: { role: 'user', id: USER_ID },
    });
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    expect(emitOasisEventMock.mock.calls[0][0]).toMatchObject({
      vtid: 'VTID-05092', type: 'health.consent.granted', source: 'partner-health-consent', actor_id: USER_ID,
      payload: { category: 'partner_results', resource_id: 'doctorbox', text_version: 'legacy-03885', locale: null, granted_via: 'settings_connected_apps' },
    });
  });

  it('400 UNKNOWN_RESOURCE for a partner_key that is not an active/sandbox partner (validated in fn_set_health_consent)', async () => {
    setHealthConsentMock.mockResolvedValue({ ok: false, status: 400, error: 'UNKNOWN_RESOURCE' });
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'not-a-partner', scope: 'result_ingestion' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'UNKNOWN_RESOURCE' });
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('400 UNSUPPORTED_SCOPE for an order_tracking write (no consent category), nothing written', async () => {
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'order_tracking' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'UNSUPPORTED_SCOPE' });
    expect(setHealthConsentMock).not.toHaveBeenCalled();
  });

  it('503 CONSENT_STORE_PENDING before the migration (nothing written, no event)', async () => {
    setHealthConsentMock.mockResolvedValue({ ok: false, status: 503, error: 'CONSENT_STORE_PENDING' });
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: 'CONSENT_STORE_PENDING' });
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('500 when the write fails — a code, never the database message', async () => {
    setHealthConsentMock.mockResolvedValue({ ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' });
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'CONSENT_WRITE_FAILED' });
  });

  it('an already-active grant changes nothing and emits nothing', async () => {
    setHealthConsentMock.mockResolvedValue(change({ changed: false }));
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/grant')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(r.status).toBe(200);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
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

  it('200 — delegates the revoke and emits health.consent.revoked; an OASIS failure does not fail it', async () => {
    setHealthConsentMock.mockResolvedValue(change({ action: 'revoke', revoked_at: 't2' }));
    emitOasisEventMock.mockResolvedValue({ ok: false, error: 'oasis down' });
    const r = await request(makeApp())
      .post('/api/v1/partner-health/consent/revoke')
      .set('Authorization', 'Bearer user-1')
      .send({ partner_key: 'doctorbox', scope: 'result_ingestion' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(setHealthConsentMock.mock.calls[0][1]).toMatchObject({ category: 'partner_results', resource_id: 'doctorbox', action: 'revoke' });
    expect(emitOasisEventMock.mock.calls[0][0].type).toBe('health.consent.revoked');
  });
});

describe('source', () => {
  it('no longer opts out of OASIS and no longer writes the consent tables directly', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/partner-health-consent.ts'), 'utf8');
    expect(route).not.toMatch(/impact-allow-no-oasis/);
    const service = fs.readFileSync(path.join(__dirname, '../src/services/partner-health/consent.ts'), 'utf8');
    expect(service).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});

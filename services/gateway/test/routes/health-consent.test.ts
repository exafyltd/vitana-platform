// VTID-05092 — HTTP tests for the member health-consent API
// (mounted at /api/v1/health/consents, requireAuthWithTenant).
//
//   - every endpoint 401 without a token
//   - identity only from the JWT: a body/query user_id is ignored
//   - validation: INVALID_REQUEST / UNKNOWN_CATEGORY / UNKNOWN_RESOURCE (400),
//     STALE_TEXT_VERSION (409), CONSENT_STORE_PENDING (503); no DB message leaks
//   - OASIS health.consent.* emitted after the commit, only on a change; an
//     emit failure never fails the request
//   - GET / and GET /history are scoped to the caller

import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID = 'tenant-1';
const OTHER_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer user-1') return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: USER_ID, tenant_id: TENANT_ID };
    return next();
  },
}));

jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({ fake: true }) }));

const emitOasisEventMock = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));

jest.mock('../../src/connectors', () => ({
  listConnectors: () => [
    { id: 'oura', category: 'wearable', display_name: 'Oura' },
    { id: 'terra', category: 'aggregator', display_name: 'Terra' },
    { id: 'google', category: 'productivity', display_name: 'Google' },
    { id: 'doctorbox', category: 'health_lab', display_name: 'DoctorBox' },
  ],
}));

const setHealthConsentMock = jest.fn();
const listMemberConsentsMock = jest.fn();
const listMemberConsentHistoryMock = jest.fn();
jest.mock('../../src/services/consent/health-consent', () => {
  const actual = jest.requireActual('../../src/services/consent/health-consent');
  return {
    ...actual,
    setHealthConsent: (...a: any[]) => setHealthConsentMock(...a),
    listMemberConsents: (...a: any[]) => listMemberConsentsMock(...a),
    listMemberConsentHistory: (...a: any[]) => listMemberConsentHistoryMock(...a),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../src/routes/health-consent').default;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/health/consents', router);
  return a;
}
const AUTH = { Authorization: 'Bearer user-1' };

function change(over: Record<string, unknown> = {}) {
  return {
    ok: true, changed: true, action: 'grant', category: 'ai_health_analysis', resource_type: 'health_category',
    resource_id: 'ai_health_analysis', scope: 'processing', text_version: 'v1', shown_locale: 'de',
    granted_via: 'settings_privacy', granted_at: '2026-10-12T10:00:00Z', revoked_at: null, consent_id: 'c1', event_id: 'e1',
    ...over,
  };
}

const GRANT = { category: 'ai_health_analysis', text_version: 'v1', locale: 'de' };

beforeEach(() => {
  jest.clearAllMocks();
  emitOasisEventMock.mockResolvedValue({ ok: true, event_id: 'oasis-1' });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('auth', () => {
  it.each([
    ['get', '/api/v1/health/consents'],
    ['get', '/api/v1/health/consents/history'],
    ['post', '/api/v1/health/consents/grant'],
    ['post', '/api/v1/health/consents/revoke'],
  ])('%s %s → 401 without a token, nothing called', async (method, url) => {
    const r = await (request(app()) as any)[method](url).send(GRANT);
    expect(r.status).toBe(401);
    expect(setHealthConsentMock).not.toHaveBeenCalled();
    expect(listMemberConsentsMock).not.toHaveBeenCalled();
    expect(listMemberConsentHistoryMock).not.toHaveBeenCalled();
  });
});

describe('POST /grant', () => {
  it('grants with the JWT identity; a body user_id/tenant_id is ignored', async () => {
    setHealthConsentMock.mockResolvedValue(change());
    const r = await request(app()).post('/api/v1/health/consents/grant').set(AUTH)
      .send({ ...GRANT, user_id: OTHER_USER, tenant_id: 'tenant-evil' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, changed: true, consent: {
      category: 'ai_health_analysis', resource_id: 'ai_health_analysis', active: true, text_version: 'v1', shown_locale: 'de',
      granted_via: 'settings_privacy', granted_at: '2026-10-12T10:00:00Z', revoked_at: null,
    } });
    const input = setHealthConsentMock.mock.calls[0][1];
    expect(input).toMatchObject({
      identity: { user_id: USER_ID, tenant_id: TENANT_ID }, category: 'ai_health_analysis', action: 'grant',
      granted_via: 'settings_privacy', text_version: 'v1', locale: 'de', actor: { role: 'user', id: USER_ID },
    });
    expect(typeof input.request_id).toBe('string');
    expect(JSON.stringify(setHealthConsentMock.mock.calls)).not.toContain(OTHER_USER);
  });

  it('passes x-request-id through and accepts the member granted_via values', async () => {
    setHealthConsentMock.mockResolvedValue(change({ granted_via: 'partner_link_confirm' }));
    const r = await request(app()).post('/api/v1/health/consents/grant').set({ ...AUTH, 'x-request-id': 'req-42' })
      .send({ category: 'partner_results', resource_id: 'doctorbox', text_version: 'v1', locale: 'sr', granted_via: 'partner_link_confirm' });
    expect(r.status).toBe(200);
    expect(setHealthConsentMock.mock.calls[0][1]).toMatchObject({ request_id: 'req-42', granted_via: 'partner_link_confirm', resource_id: 'doctorbox', locale: 'sr' });
  });

  it.each([
    [{}, 'category'],
    [{ category: 'ai_health_analysis', locale: 'de' }, 'text_version'],
    [{ category: 'ai_health_analysis', text_version: 'v1' }, 'locale'],
    [{ category: 'ai_health_analysis', text_version: 'v1', locale: 'xx' }, 'locale'],
    [{ ...GRANT, granted_via: 'portal_admin_backfill' }, 'granted_via'],
    [{ ...GRANT, granted_via: 'checkout_flow' }, 'granted_via'],
    [{ ...GRANT, resource_id: 42 }, 'resource_id'],
  ])('400 INVALID_REQUEST for %j (field %s), nothing written', async (body, field) => {
    const r = await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send(body);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'INVALID_REQUEST', field });
    expect(setHealthConsentMock).not.toHaveBeenCalled();
  });

  it('400 UNKNOWN_CATEGORY for a category that is not in the catalogue', async () => {
    const r = await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send({ ...GRANT, category: 'genome' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'UNKNOWN_CATEGORY' });
    expect(setHealthConsentMock).not.toHaveBeenCalled();
  });

  it('409 STALE_TEXT_VERSION for the reserved legacy label (only the legacy route may record it)', async () => {
    const r = await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send({ ...GRANT, text_version: 'legacy-03885' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, error: 'STALE_TEXT_VERSION' });
    expect(setHealthConsentMock).not.toHaveBeenCalled();
  });

  it('wearables: only a known wearable/aggregator connector id', async () => {
    for (const resource_id of [undefined, 'google', 'doctorbox', 'fitbit-typo']) {
      const r = await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send({ ...GRANT, category: 'wearables', resource_id });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ ok: false, error: 'UNKNOWN_RESOURCE' });
    }
    expect(setHealthConsentMock).not.toHaveBeenCalled();
    setHealthConsentMock.mockResolvedValue(change({ category: 'wearables', resource_id: 'terra' }));
    const ok = await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send({ ...GRANT, category: 'wearables', resource_id: 'terra' });
    expect(ok.status).toBe(200);
  });

  it.each([
    [400, 'UNKNOWN_RESOURCE'],
    [409, 'STALE_TEXT_VERSION'],
    [503, 'CONSENT_STORE_PENDING'],
    [500, 'CONSENT_WRITE_FAILED'],
  ])('service %i %s is answered as-is, with no OASIS event', async (status, error) => {
    setHealthConsentMock.mockResolvedValue({ ok: false, status, error });
    const r = await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send({ ...GRANT, category: 'partner_results', resource_id: 'unknownlab' });
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ ok: false, error });
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('emits health.consent.granted AFTER the commit, with no health values', async () => {
    setHealthConsentMock.mockResolvedValue(change());
    await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send(GRANT);
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    expect(setHealthConsentMock.mock.invocationCallOrder[0]).toBeLessThan(emitOasisEventMock.mock.invocationCallOrder[0]);
    const ev = emitOasisEventMock.mock.calls[0][0];
    expect(ev).toMatchObject({ vtid: 'VTID-05092', type: 'health.consent.granted', source: 'health-consent', actor_id: USER_ID, actor_role: 'user' });
    expect(ev.payload).toEqual({ category: 'ai_health_analysis', resource_id: 'ai_health_analysis', text_version: 'v1', locale: 'de', granted_via: 'settings_privacy' });
  });

  it('no event for an idempotent grant (nothing changed)', async () => {
    setHealthConsentMock.mockResolvedValue(change({ changed: false }));
    const r = await request(app()).post('/api/v1/health/consents/grant').set(AUTH).send(GRANT);
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(false);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});

describe('POST /revoke', () => {
  it('revokes with the JWT identity; no version needed; any resource id (a member can always withdraw)', async () => {
    setHealthConsentMock.mockResolvedValue(change({ action: 'revoke', category: 'wearables', resource_id: 'old-connector', revoked_at: '2026-10-12T11:00:00Z' }));
    const r = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH)
      .send({ category: 'wearables', resource_id: 'old-connector', user_id: OTHER_USER });
    expect(r.status).toBe(200);
    expect(r.body.consent).toMatchObject({ category: 'wearables', resource_id: 'old-connector', active: false, revoked_at: '2026-10-12T11:00:00Z' });
    expect(setHealthConsentMock.mock.calls[0][1]).toMatchObject({
      identity: { user_id: USER_ID, tenant_id: TENANT_ID }, category: 'wearables', resource_id: 'old-connector', action: 'revoke', locale: null,
    });
    expect(emitOasisEventMock.mock.calls[0][0].type).toBe('health.consent.revoked');
  });

  it('an OASIS failure (ok:false or a throw) never fails the revoke', async () => {
    setHealthConsentMock.mockResolvedValue(change({ action: 'revoke', revoked_at: 't' }));
    emitOasisEventMock.mockResolvedValueOnce({ ok: false, error: 'oasis down' });
    const a = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'ai_health_analysis' });
    expect(a.status).toBe(200);
    emitOasisEventMock.mockRejectedValueOnce(new Error('network'));
    const b = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'ai_health_analysis' });
    expect(b.status).toBe(200);
    expect(b.body.ok).toBe(true);
  });

  it('400 for an unknown or missing category; a service write failure is passed through as a code', async () => {
    expect((await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({})).body).toEqual({ ok: false, error: 'INVALID_REQUEST', field: 'category' });
    expect((await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'x' })).body).toEqual({ ok: false, error: 'UNKNOWN_CATEGORY' });
    // (Pre-migration revokes never answer 503 — see test/consent/health-consent-premigration.test.ts.)
    setHealthConsentMock.mockResolvedValue({ ok: false, status: 500, error: 'CONSENT_WRITE_FAILED' });
    const r = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'community_insights' });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'CONSENT_WRITE_FAILED' });
  });
});

describe('GET / and GET /history', () => {
  it('GET / lists the caller only and passes the wearable connectors', async () => {
    listMemberConsentsMock.mockResolvedValue({ ok: true, store_pending: true, categories: [], consents: [], partners: [], connectors: [] });
    const r = await request(app()).get(`/api/v1/health/consents?user_id=${OTHER_USER}`).set(AUTH);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, store_pending: true });
    expect(listMemberConsentsMock).toHaveBeenCalledWith(expect.anything(), { user_id: USER_ID, tenant_id: TENANT_ID }, {
      connectors: [{ id: 'oura', display_name: 'Oura' }, { id: 'terra', display_name: 'Terra' }],
    });
  });

  it('GET / answers the service error code', async () => {
    listMemberConsentsMock.mockResolvedValue({ ok: false, status: 500, error: 'CONSENTS_UNAVAILABLE' });
    const r = await request(app()).get('/api/v1/health/consents').set(AUTH);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'CONSENTS_UNAVAILABLE' });
  });

  it('GET /history is scoped to the caller (query user_id ignored)', async () => {
    listMemberConsentHistoryMock.mockResolvedValue({ ok: true, store_pending: false, events: [] });
    const r = await request(app()).get(`/api/v1/health/consents/history?user_id=${OTHER_USER}`).set(AUTH);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, store_pending: false, events: [] });
    expect(listMemberConsentHistoryMock).toHaveBeenCalledWith(expect.anything(), { user_id: USER_ID, tenant_id: TENANT_ID });
  });
});

describe('route mount', () => {
  it('index.ts mounts the router exactly once at /api/v1/health/consents', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf8');
    const mounts = index.match(/mountRouterSync\(app, '\/api\/v1\/health\/consents', healthConsentRouter, \{ owner: 'health-consent' \}\)/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(index).toContain("require('./routes/health-consent').default");
  });

  it('no mutating handler opts out of OASIS', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/health-consent.ts'), 'utf8');
    expect(src).not.toMatch(/impact-allow-no-oasis/);
  });
});

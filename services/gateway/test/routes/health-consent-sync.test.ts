// VTID-05164 (Health Hub Phase 1 / C1) — the D10 grant route and the Health
// Sync consent keys: a sync_* grant names a phone store (apple_health,
// health_connect) or an aggregator connector, never a device cloud or an
// unknown id; self_logged_health is one consent with no resource;
// granted_via native_health_sync is a member value. The D10 suite
// (health-consent.test.ts) runs unchanged next to this file.

import express from 'express';
import request from 'supertest';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer user-1') return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: USER_ID, tenant_id: 'tenant-1' };
    return next();
  },
}));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({ fake: true }) }));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: async () => ({ ok: true }) }));

const setHealthConsentMock = jest.fn();
jest.mock('../../src/services/consent/health-consent', () => {
  const actual = jest.requireActual('../../src/services/consent/health-consent');
  return { ...actual, setHealthConsent: (...a: any[]) => setHealthConsentMock(...a) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const route = require('../../src/routes/health-consent');
const router = route.default;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/health/consents', router);
  return a;
}
const AUTH = { Authorization: 'Bearer user-1' };
const grant = (body: Record<string, unknown>) => request(app()).post('/api/v1/health/consents/grant').set(AUTH).send({ text_version: 'v1', locale: 'de', ...body });

function change(category: string, resource_id: string, granted_via = 'native_health_sync') {
  return {
    ok: true, changed: true, action: 'grant', category, resource_type: 'health_source', resource_id, scope: `ingestion:${category.slice(5)}`,
    text_version: 'v1', shown_locale: 'de', granted_via, granted_at: '2026-10-13T10:00:00Z', revoked_at: null, consent_id: 'c1', event_id: 'e1',
  };
}

beforeEach(() => jest.clearAllMocks());

describe('sync_* grants (VTID-05164)', () => {
  it('the resources are the phone stores and the aggregator connectors (from the real registry)', () => {
    const resources: string[] = route.healthSyncConsentResources();
    expect(resources).toEqual(expect.arrayContaining(['apple_health', 'health_connect', 'terra', 'vital']));
    expect(resources).not.toContain('oura');
    expect(resources).not.toContain('google');
    // a phone store is not a wearables (device cloud) resource
    expect(route.wearableConnectors().map((c: { id: string }) => c.id)).not.toContain('apple_health');
  });

  it.each(['sync_activity', 'sync_sleep', 'sync_heart', 'sync_body'])('%s for apple_health / health_connect with granted_via native_health_sync', async (category) => {
    for (const resource of ['apple_health', 'health_connect']) {
      setHealthConsentMock.mockResolvedValueOnce(change(category, resource));
      const r = await grant({ category, resource_id: resource, granted_via: 'native_health_sync' });
      expect(r.status).toBe(200);
      expect(setHealthConsentMock.mock.calls.at(-1)[1]).toMatchObject({ category, resource_id: resource, granted_via: 'native_health_sync', identity: { user_id: USER_ID } });
    }
  });

  it.each([['oura'], ['google'], ['unknown'], [null]])('a sync_* grant for %s is UNKNOWN_RESOURCE, nothing written', async (resource) => {
    const r = await grant({ category: 'sync_sleep', resource_id: resource });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'UNKNOWN_RESOURCE' });
    expect(setHealthConsentMock).not.toHaveBeenCalled();
  });

  it('a wearables grant still refuses a phone store id (device clouds only)', async () => {
    const r = await grant({ category: 'wearables', resource_id: 'apple_health' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'UNKNOWN_RESOURCE' });
  });

  it('self_logged_health is one consent with no resource', async () => {
    setHealthConsentMock.mockResolvedValueOnce({ ...change('self_logged_health', 'self_logged_health', 'settings_privacy'), resource_type: 'health_category', scope: 'ingestion:self_logged' });
    const r = await grant({ category: 'self_logged_health' });
    expect(r.status).toBe(200);
    expect(setHealthConsentMock.mock.calls[0][1]).toMatchObject({ category: 'self_logged_health', granted_via: 'settings_privacy' });
  });

  it('revoking a sync_* consent never checks the resource (withdrawal always works)', async () => {
    setHealthConsentMock.mockResolvedValueOnce({ ...change('sync_heart', 'retired_connector'), action: 'revoke', revoked_at: '2026-10-13T11:00:00Z' });
    const r = await request(app()).post('/api/v1/health/consents/revoke').set(AUTH).send({ category: 'sync_heart', resource_id: 'retired_connector' });
    expect(r.status).toBe(200);
    expect(setHealthConsentMock.mock.calls[0][1]).toMatchObject({ category: 'sync_heart', action: 'revoke', resource_id: 'retired_connector' });
  });
});

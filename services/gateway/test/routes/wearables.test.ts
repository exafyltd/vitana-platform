/**
 * routes/wearables.ts — GET /providers.
 *
 * Focused on two previously-unchecked Supabase errors: the connector
 * registry read and the (optional, auth-only) user-connections read.
 * Both `data`-only destructures made a real DB error indistinguishable
 * from "no providers"/"nothing connected" — this pins the fix: the
 * registry read now surfaces 500, the connections read degrades but logs.
 */
import express from 'express';
import request from 'supertest';
import * as jose from 'jose';

jest.mock('jose');

const mockFetchWearableConnectorRegistry = jest.fn();
const mockFetchUserWearableConnections = jest.fn();
const mockFetchActivePrimaryTenant = jest.fn();
jest.mock('../../src/routes/wearables-repository', () => ({
  fetchWearableConnectorRegistry: (...args: unknown[]) => mockFetchWearableConnectorRegistry(...args),
  fetchUserWearableConnections: (...args: unknown[]) => mockFetchUserWearableConnections(...args),
  fetchActivePrimaryTenant: (...args: unknown[]) => mockFetchActivePrimaryTenant(...args),
}));

jest.mock('../../src/connectors', () => ({
  getConnector: jest.fn(() => ({ id: 'terra', display_name: 'Terra', category: 'aggregator' })),
  listConnectors: jest.fn(() => []),
}));

const mockSupabase = {};
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wearablesRouter = require('../../src/routes/wearables').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/wearables', wearablesRouter);
  return app;
}

describe('GET /api/v1/wearables/providers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchWearableConnectorRegistry.mockResolvedValue({ data: [], error: null });
    mockFetchUserWearableConnections.mockResolvedValue({ data: [], error: null });
  });

  it('200 with an empty provider list, unchanged happy path (anonymous)', async () => {
    const res = await request(makeApp()).get('/api/v1/wearables/providers');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, providers: [] });
  });

  it('500 (not an empty "no providers" list) when the registry lookup errors', async () => {
    mockFetchWearableConnectorRegistry.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    const res = await request(makeApp()).get('/api/v1/wearables/providers');
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('logs loudly but still returns providers when the (optional) user-connections lookup errors', async () => {
    (jose.decodeJwt as jest.Mock).mockReturnValue({ sub: 'user-1', app_metadata: { active_tenant_id: 'tenant-1' } });
    mockFetchWearableConnectorRegistry.mockResolvedValueOnce({
      data: [{ id: 'terra', display_name: 'Terra', description: '', category: 'aggregator', auth_type: 'widget', capabilities: [], requires_ios_companion: false, underlying_providers: [], docs_url: null }],
      error: null,
    });
    mockFetchUserWearableConnections.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(makeApp())
      .get('/api/v1/wearables/providers')
      .set('Authorization', 'Bearer sometoken');

    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.providers[0].status).toBe('available'); // degraded, not "connected" — but not a 500 either
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('user connections lookup failed'),
    );
    errorSpy.mockRestore();
  });
});

describe('POST /api/v1/wearables/connect/:connector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs loudly when the tenant-resolution lookup errors, still reports 400 (unchanged fail-closed default)', async () => {
    // No active_tenant_id in the JWT claims, forcing the resolveTenantId() fallback path.
    (jose.decodeJwt as jest.Mock).mockReturnValue({ sub: 'user-1' });
    mockFetchActivePrimaryTenant.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(makeApp())
      .post('/api/v1/wearables/connect/terra')
      .set('Authorization', 'Bearer sometoken');

    expect(res.status).toBe(400);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('resolveTenantId lookup failed'),
    );
    errorSpy.mockRestore();
  });
});

/**
 * Tests for src/routes/admin-aurora-memory-health.ts (VTID-03773 Phase 0).
 *
 * Same admin-gate pattern as test/routes/admin-memory-broker.test.ts: assert
 * requireAuth/requireExafyAdmin refuse BEFORE the route ever touches Aurora,
 * then exercise the three real outcomes a Phase-0 network check can report —
 * not configured, reachable, and reachable-but-erroring (distinguishing a
 * network failure from an auth/TLS failure, since they point at different
 * fixes: a security-group rule vs. a Secrets Manager value).
 */
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

jest.mock('jose');

jest.mock('../../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
  countActiveUsageDays: jest.fn().mockResolvedValue(0),
}));

const mockResolveAuroraConfig = jest.fn();
const mockWithAuroraClient = jest.fn();

class FakeAuroraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuroraConfigError';
  }
}

jest.mock('../../src/services/db-i18n/aurora-client', () => ({
  AuroraConfigError: FakeAuroraConfigError,
  resolveAuroraConfig: (...args: unknown[]) => mockResolveAuroraConfig(...args),
  withAuroraClient: (...args: unknown[]) => mockWithAuroraClient(...args),
}));

import router from '../../src/routes/admin-aurora-memory-health';

const app = express();
app.use(express.json());
app.use('/', router);

const ADMIN_CLAIMS = { sub: 'admin-1', email: 'admin@example.com', app_metadata: { exafy_admin: true } };
const NON_ADMIN_CLAIMS = { sub: 'user-1', email: 'user@example.com', app_metadata: { exafy_admin: false } };

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}
function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('bad signature'));
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPABASE_JWT_SECRET = 'test-secret';
  delete process.env.SUPABASE_AUTH_JWKS_URL;
  mockInvalidJwt();
  mockResolveAuroraConfig.mockReturnValue({
    connectionString: 'postgres://user:***@aurora-host:5432/vitana',
    ssl: { rejectUnauthorized: true },
    describe: 'postgres://user:***@aurora-host:5432/vitana',
  });
});

describe('admin gate', () => {
  it('returns 401 with no Authorization header, and never touches Aurora', async () => {
    const res = await request(app).get('/admin/aurora-memory/health').send();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(mockResolveAuroraConfig).not.toHaveBeenCalled();
    expect(mockWithAuroraClient).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin caller, and never touches Aurora', async () => {
    mockVerifiedJwt(NON_ADMIN_CLAIMS);
    const res = await request(app)
      .get('/admin/aurora-memory/health')
      .set('Authorization', 'Bearer valid-non-admin-token')
      .send();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockResolveAuroraConfig).not.toHaveBeenCalled();
    expect(mockWithAuroraClient).not.toHaveBeenCalled();
  });
});

describe('GET /admin/aurora-memory/health (authenticated admin)', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('reports not configured when AURORA_DATABASE_URL is unset', async () => {
    mockResolveAuroraConfig.mockImplementation(() => {
      throw new FakeAuroraConfigError('AURORA_DATABASE_URL is not set.');
    });

    const res = await request(app)
      .get('/admin/aurora-memory/health')
      .set('Authorization', 'Bearer valid-admin-token')
      .send();

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, reachable: false, configured: false, error_type: 'config' });
    expect(mockWithAuroraClient).not.toHaveBeenCalled();
  });

  it('reports reachable=true with latency and db_time on a real round trip', async () => {
    mockWithAuroraClient.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
      fn({
        query: jest.fn().mockResolvedValue({ rows: [{ ok: 1, db_time: '2026-08-27T00:00:00.000Z' }] }),
      }),
    );

    const res = await request(app)
      .get('/admin/aurora-memory/health')
      .set('Authorization', 'Bearer valid-admin-token')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reachable).toBe(true);
    expect(res.body.configured).toBe(true);
    expect(res.body.db_time).toBe('2026-08-27T00:00:00.000Z');
    expect(typeof res.body.latency_ms).toBe('number');
  });

  it('classifies a connection timeout as a network failure, not auth/TLS', async () => {
    mockWithAuroraClient.mockRejectedValue(new Error('connect ETIMEDOUT 10.0.1.23:5432'));

    const res = await request(app)
      .get('/admin/aurora-memory/health')
      .set('Authorization', 'Bearer valid-admin-token')
      .send();

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, reachable: false, configured: true, error_type: 'network' });
  });

  it('classifies a TLS/certificate rejection as auth_or_tls, not network', async () => {
    mockWithAuroraClient.mockRejectedValue(new Error('self-signed certificate in certificate chain'));

    const res = await request(app)
      .get('/admin/aurora-memory/health')
      .set('Authorization', 'Bearer valid-admin-token')
      .send();

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, reachable: false, configured: true, error_type: 'auth_or_tls' });
  });
});

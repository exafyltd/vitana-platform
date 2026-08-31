import request from 'supertest';
import express from 'express';

/**
 * GET /api/v1/admin/aurora-rls-health — VTID-03591/B4.
 *
 * Covers the three states the endpoint exists to distinguish: Aurora not
 * configured (the expected, safe state everywhere today), the RLS shim
 * resolving the caller's own identity correctly, and each of the specific
 * failure modes this endpoint is meant to catch (BYPASSRLS/superuser login
 * role, auth.uid() not resolving to the caller, auth.uid() resolving to
 * someone ELSE's id — a pooled-connection context leak).
 */

let mockCallerUserId = 'user-abc-123';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: jest.fn((req: any, _res: any, next: any) => {
    req.identity = { user_id: mockCallerUserId, role: 'authenticated' };
    req.auth_raw_claims = { sub: mockCallerUserId, role: 'authenticated' };
    next();
  }),
}));

const mockGetAuroraPool = jest.fn();
const mockWithAuroraRlsContext = jest.fn();

jest.mock('../../src/services/aurora-client', () => ({
  getAuroraPool: () => mockGetAuroraPool(),
  withAuroraRlsContext: (...args: any[]) => mockWithAuroraRlsContext(...args),
}));

import adminHealthRouter from '../../src/routes/admin-health';

const app = express();
app.use(express.json());
app.use('/api/v1/admin', adminHealthRouter);

describe('GET /api/v1/admin/aurora-rls-health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallerUserId = 'user-abc-123';
  });

  it('reports configured:false when AURORA_DATABASE_URL is unset, without touching withAuroraRlsContext', async () => {
    mockGetAuroraPool.mockReturnValue(null);

    const res = await request(app).get('/api/v1/admin/aurora-rls-health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, configured: false });
    expect(mockWithAuroraRlsContext).not.toHaveBeenCalled();
  });

  it('returns ok:true when the login role is unprivileged and auth.uid() resolves to the caller', async () => {
    mockGetAuroraPool.mockReturnValue({});
    mockWithAuroraRlsContext.mockResolvedValue({
      db_user: 'authenticator',
      rolsuper: false,
      rolbypassrls: false,
      resolved_uid: 'user-abc-123',
    });

    const res = await request(app).get('/api/v1/admin/aurora-rls-health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      configured: true,
      db_user: 'authenticator',
      rolsuper: false,
      rolbypassrls: false,
      auth_uid_matches_caller: true,
    });
    // The RLS context must be built from the CALLER's own identity, not a
    // fixed/service identity — otherwise this check would validate nothing
    // about per-request isolation.
    expect(mockWithAuroraRlsContext).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'authenticated', claims: expect.objectContaining({ sub: 'user-abc-123' }) }),
      expect.any(Function),
    );
  });

  it('returns 503 when the pooled login role has BYPASSRLS (would silently skip every policy)', async () => {
    mockGetAuroraPool.mockReturnValue({});
    mockWithAuroraRlsContext.mockResolvedValue({
      db_user: 'some_role',
      rolsuper: false,
      rolbypassrls: true,
      resolved_uid: 'user-abc-123',
    });

    const res = await request(app).get('/api/v1/admin/aurora-rls-health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, rolbypassrls: true });
  });

  it('returns 503 when the pooled login role is superuser', async () => {
    mockGetAuroraPool.mockReturnValue({});
    mockWithAuroraRlsContext.mockResolvedValue({
      db_user: 'postgres',
      rolsuper: true,
      rolbypassrls: false,
      resolved_uid: 'user-abc-123',
    });

    const res = await request(app).get('/api/v1/admin/aurora-rls-health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, rolsuper: true });
  });

  it('returns 503 when auth.uid() resolves to null (claims not reaching the session GUC)', async () => {
    mockGetAuroraPool.mockReturnValue({});
    mockWithAuroraRlsContext.mockResolvedValue({
      db_user: 'authenticator',
      rolsuper: false,
      rolbypassrls: false,
      resolved_uid: null,
    });

    const res = await request(app).get('/api/v1/admin/aurora-rls-health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, auth_uid_matches_caller: false });
  });

  it('returns 503 when auth.uid() resolves to a DIFFERENT user (pooled-connection context leak)', async () => {
    mockGetAuroraPool.mockReturnValue({});
    mockWithAuroraRlsContext.mockResolvedValue({
      db_user: 'authenticator',
      rolsuper: false,
      rolbypassrls: false,
      resolved_uid: 'someone-else-entirely',
    });

    const res = await request(app).get('/api/v1/admin/aurora-rls-health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, auth_uid_matches_caller: false });
  });

  it('returns 503 with the error message when the query itself throws', async () => {
    mockGetAuroraPool.mockReturnValue({});
    mockWithAuroraRlsContext.mockRejectedValue(new Error('permission denied for schema public'));

    const res = await request(app).get('/api/v1/admin/aurora-rls-health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, configured: true, error: 'permission denied for schema public' });
  });
});

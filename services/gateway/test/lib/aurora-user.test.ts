const mockGetAuroraPool = jest.fn();

jest.mock('../../src/lib/aurora', () => ({
  getAuroraPool: mockGetAuroraPool,
}));

function makeClient(overrides: { rolbypassrls?: boolean; rolsuper?: boolean; noRoleRow?: boolean } = {}) {
  const { rolbypassrls = false, rolsuper = false, noRoleRow = false } = overrides;
  const calls: string[] = [];

  const query = jest.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes('pg_roles')) {
      return { rows: noRoleRow ? [] : [{ rolname: 'authenticated', rolbypassrls, rolsuper }] };
    }
    return { rows: [] };
  });

  return {
    query,
    release: jest.fn(),
    __calls: calls,
  };
}

function makePool(client: ReturnType<typeof makeClient>) {
  return { connect: jest.fn(async () => client) };
}

describe('lib/aurora-user withUserClaims', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAuroraPool.mockReset();
  });

  it('throws when the Aurora pool is unavailable', async () => {
    mockGetAuroraPool.mockReturnValue(null);
    const { withUserClaims } = require('../../src/lib/aurora-user');

    await expect(withUserClaims({ sub: 'u1' }, async () => 'x')).rejects.toThrow(
      /AURORA_DATABASE_URL not configured/
    );
  });

  it('runs BEGIN, the bypass check, claims injection, the callback, then COMMIT, and releases the client', async () => {
    const client = makeClient();
    mockGetAuroraPool.mockReturnValue(makePool(client));
    const { withUserClaims } = require('../../src/lib/aurora-user');

    const fn = jest.fn(async () => 'result');
    const result = await withUserClaims({ sub: 'user-123', role: 'authenticated', email: 'a@b.com' }, fn);

    expect(result).toBe('result');
    expect(client.__calls[0]).toBe('BEGIN');
    expect(client.__calls[1]).toMatch(/pg_roles/);
    expect(client.__calls[2]).toMatch(/set_config/);
    expect(client.__calls[3]).toBe('COMMIT');
    expect(fn).toHaveBeenCalledWith(client);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('injects the full claims payload as request.jwt.claims and extracts sub/role/email', async () => {
    const client = makeClient();
    mockGetAuroraPool.mockReturnValue(makePool(client));
    const { withUserClaims } = require('../../src/lib/aurora-user');

    const claims = { sub: 'user-123', role: 'authenticated', email: 'a@b.com', app_metadata: { exafy_admin: true } };
    await withUserClaims(claims, async () => null);

    const setConfigCall = client.query.mock.calls.find((c: any[]) => c[0].includes('set_config'));
    expect(setConfigCall[1]).toEqual([JSON.stringify(claims), 'user-123', 'authenticated', 'a@b.com']);
  });

  it('defaults role to "authenticated" and sub/email to empty string when missing or non-string', async () => {
    const client = makeClient();
    mockGetAuroraPool.mockReturnValue(makePool(client));
    const { withUserClaims } = require('../../src/lib/aurora-user');

    await withUserClaims({ sub: 12345 as any }, async () => null);

    const setConfigCall = client.query.mock.calls.find((c: any[]) => c[0].includes('set_config'));
    expect(setConfigCall[1]).toEqual([JSON.stringify({ sub: 12345 }), '', 'authenticated', '']);
  });

  it('refuses to proceed and rolls back when the connected role has rolbypassrls=true', async () => {
    const client = makeClient({ rolbypassrls: true });
    mockGetAuroraPool.mockReturnValue(makePool(client));
    const { withUserClaims } = require('../../src/lib/aurora-user');

    const fn = jest.fn();
    await expect(withUserClaims({ sub: 'u1' }, fn)).rejects.toThrow(/Refusing to run user-scoped queries/);

    expect(fn).not.toHaveBeenCalled();
    expect(client.__calls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('refuses to proceed when the connected role is a superuser', async () => {
    const client = makeClient({ rolsuper: true });
    mockGetAuroraPool.mockReturnValue(makePool(client));
    const { withUserClaims } = require('../../src/lib/aurora-user');

    await expect(withUserClaims({ sub: 'u1' }, jest.fn())).rejects.toThrow(/Refusing to run user-scoped queries/);
  });

  it('throws if pg_roles returns no row for current_user', async () => {
    const client = makeClient({ noRoleRow: true });
    mockGetAuroraPool.mockReturnValue(makePool(client));
    const { withUserClaims } = require('../../src/lib/aurora-user');

    await expect(withUserClaims({ sub: 'u1' }, jest.fn())).rejects.toThrow(/Could not resolve current_user/);
  });

  it('rolls back and rethrows when the callback throws, still releasing the client', async () => {
    const client = makeClient();
    mockGetAuroraPool.mockReturnValue(makePool(client));
    const { withUserClaims } = require('../../src/lib/aurora-user');

    await expect(
      withUserClaims({ sub: 'u1' }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(client.__calls).toContain('ROLLBACK');
    expect(client.__calls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('only runs the bypass-RLS check once per process, not once per call', async () => {
    const client = makeClient();
    mockGetAuroraPool.mockReturnValue(makePool(client));
    const { withUserClaims } = require('../../src/lib/aurora-user');

    await withUserClaims({ sub: 'u1' }, async () => null);
    await withUserClaims({ sub: 'u2' }, async () => null);

    const roleChecks = client.query.mock.calls.filter((c: any[]) => c[0].includes('pg_roles'));
    expect(roleChecks).toHaveLength(1);
  });
});

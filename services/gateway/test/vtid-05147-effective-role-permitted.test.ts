/**
 * VTID-05147 — Track S / S-M, gateway defence in depth.
 *
 * role_preferences and user_tenants.active_role were writable by the member
 * themself, and the gateway took them as the effective role: a member who
 * wrote role='developer' passed developerGate on POST /api/v1/orb/tool and ran
 * the developer voice tools with the service-role client. Now:
 *  - resolveEffectiveRole intersects the picked role with the permitted set
 *    (user_permitted_roles ∪ active memberships ∪ community); outside it, or
 *    when that set cannot be read, the caller acts as 'community'. Exafy
 *    callers are unchanged (their roles have no permitted rows);
 *  - /orb/tool passes req.identity.exafy_admin, so a forged preference reaches
 *    developerGate as 'community' and dev_list_vtids answers
 *    developer_role_required;
 *  - admin-users' inline tenant-admin check also requires a permitted admin.
 * Maxina unchanged: a community member stays community, a permitted
 * professional stays professional.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';

// Same module-boundary mocks as test/routes/orb-live.test.ts (orb-live.ts has
// many I/O-performing siblings).
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/orb-memory-bridge', () => ({
  isMemoryBridgeEnabled: jest.fn(() => false),
  isDevSandbox: jest.fn(() => false),
  fetchDevMemoryContext: jest.fn(),
  fetchMemoryContextWithIdentity: jest.fn(),
  buildMemoryEnhancedInstruction: jest.fn(),
  getDebugSnapshot: jest.fn(),
  writeDevMemoryItem: jest.fn(),
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
  fetchRecentConversationTranscript: jest.fn(),
  fetchRecentOrbUserTurns: jest.fn().mockResolvedValue([]),
  formatRecentTurnsBlock: jest.fn(() => ''),
  DEV_IDENTITY: {
    USER_ID: '00000000-0000-0000-0000-000000000099',
    TENANT_ID: '00000000-0000-0000-0000-000000000001',
    ACTIVE_ROLE: 'community',
  },
  MEMORY_CONFIG: { MAX_AGE_HOURS: 24, DEFAULT_CONTEXT_LIMIT: 20 },
}));
jest.mock('../src/services/user-context-profiler', () => ({
  getUserContextSummary: jest.fn().mockResolvedValue({ summary: '', version: 0, cached: false, warnings: [] }),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn() }));
jest.mock('../src/navigation/nav-action-memory', () => ({
  writeNavigatorActionMemory: jest.fn().mockResolvedValue(undefined),
}));
// The real developer gate, reached through the shared dispatcher.
jest.mock('../src/services/orb-tools-shared', () => ({
  dispatchOrbTool: jest.fn(async (name: string, args: any, id: any, sb: any) => {
    const dev = jest.requireActual('../src/services/orb-tools/developer-tools');
    if (name === 'dev_list_vtids') return dev.dev_list_vtids(args, id, sb);
    return { ok: false, error: `unknown tool: ${name}` };
  }),
  dispatchOrbToolForVertex: jest.fn(),
}));
// The caller is fixed per test through `currentIdentity`.
let currentIdentity: any = null;
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.identity = currentIdentity;
      next();
    },
  };
});
const mockGetUser = jest.fn();
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(() => ({ auth: { getUser: () => mockGetUser() } })),
}));

import express from 'express';
import request from 'supertest';
import { resolveEffectiveRole } from '../src/routes/orb-live';
import orbToolRouter from '../src/routes/orb-tool';
import adminUsersRouter from '../src/routes/admin-users';
import { getSupabase } from '../src/lib/supabase';
import { computePermittedRoles, fetchPermittedRoles } from '../src/lib/permitted-roles';
import { computePermittedRoles as jevCompute, JEV_SWITCHER_ROLES } from '../src/services/jev/jev-caller';

const mockFetch = global.fetch as jest.Mock;
const mockGetSupabase = getSupabase as jest.Mock;

const TENANT = '0000000a-0000-0000-0000-000000005147';

/** Service-role REST reads of resolveEffectiveRole (role_preferences, user_tenants). */
function storedRoles(pref: string | null, active: string | null) {
  mockFetch.mockImplementation((url: string) => {
    const u = String(url);
    const rows = u.includes('role_preferences')
      ? pref ? [{ role: pref }] : []
      : u.includes('user_tenants')
        ? active ? [{ active_role: active }] : []
        : [];
    return Promise.resolve({ ok: true, status: 200, json: async () => rows });
  });
}

/** Fake service client. `tables[t]` is the awaited result, `singles[t]` the .single() one. */
function serviceClient(tables: Record<string, { data: any; error: any }>, singles: Record<string, any> = {}) {
  const from = jest.fn((table: string) => {
    const c: any = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is']) c[m] = jest.fn(() => c);
    c.single = jest.fn(async () => singles[table] ?? { data: null, error: { message: 'No rows' } });
    c.maybeSingle = c.single;
    c.then = (resolve: any, reject: any) =>
      Promise.resolve(tables[table] ?? { data: [], error: null }).then(resolve, reject);
    return c;
  });
  return { from };
}

function grants(roles: string[], memberships: string[] = []) {
  return serviceClient({
    user_permitted_roles: { data: roles.map((role) => ({ role })), error: null },
    memberships: { data: memberships.map((role) => ({ role })), error: null },
  });
}

beforeEach(() => {
  mockGetSupabase.mockReset();
  mockFetch.mockReset();
  currentIdentity = null;
});

describe('lib/permitted-roles', () => {
  it('is the same set Jev used (moved, re-exported unchanged)', () => {
    expect(jevCompute).toBe(computePermittedRoles);
    expect(JEV_SWITCHER_ROLES).toEqual(['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra']);
    expect(computePermittedRoles([{ role: 'developer' }, { role: 'bogus' }], [{ role: 'staff' }])).toEqual(['community', 'staff', 'developer']);
  });

  it('fails closed: no client or a read error gives roles null', async () => {
    await expect(fetchPermittedRoles(null, 'u', TENANT)).resolves.toMatchObject({ roles: null });
    const sb = serviceClient({ user_permitted_roles: { data: null, error: { message: 'boom' } } });
    await expect(fetchPermittedRoles(sb as any, 'u', TENANT)).resolves.toEqual({ roles: null, error: 'boom' });
  });
});

describe('resolveEffectiveRole clamps to the permitted set', () => {
  it('a developer preference that is not permitted resolves to community', async () => {
    mockGetSupabase.mockReturnValue(grants([]));
    storedRoles('developer', 'community');
    await expect(resolveEffectiveRole('u-member', TENANT)).resolves.toBe('community');
  });

  it('a forged user_tenants.active_role=admin without a preference resolves to community', async () => {
    mockGetSupabase.mockReturnValue(grants([]));
    storedRoles(null, 'admin');
    await expect(resolveEffectiveRole('u-member', TENANT)).resolves.toBe('community');
  });

  it('a permitted developer resolves to developer (grant or active membership)', async () => {
    mockGetSupabase.mockReturnValue(grants(['developer']));
    storedRoles('developer', 'community');
    await expect(resolveEffectiveRole('u-dev', TENANT)).resolves.toBe('developer');
    mockGetSupabase.mockReturnValue(grants([], ['developer']));
    await expect(resolveEffectiveRole('u-dev', TENANT)).resolves.toBe('developer');
  });

  it('an exafy caller keeps developer with no permitted rows, and the set is not read', async () => {
    const sb = grants([]);
    mockGetSupabase.mockReturnValue(sb);
    storedRoles('developer', 'developer');
    await expect(resolveEffectiveRole('u-exafy', TENANT, { exafyAdmin: true })).resolves.toBe('developer');
    expect(sb.from).not.toHaveBeenCalled();
  });

  it('a permitted-role read error resolves to community', async () => {
    mockGetSupabase.mockReturnValue(serviceClient({ user_permitted_roles: { data: null, error: { message: 'timeout' } } }));
    storedRoles('developer', 'developer');
    await expect(resolveEffectiveRole('u-dev', TENANT)).resolves.toBe('community');
    mockGetSupabase.mockReturnValue(null);
    await expect(resolveEffectiveRole('u-dev', TENANT)).resolves.toBe('community');
  });

  it('Maxina unchanged: a community member stays community, a permitted professional stays professional', async () => {
    mockGetSupabase.mockReturnValue(grants([]));
    storedRoles('community', 'community');
    await expect(resolveEffectiveRole('u-member', TENANT)).resolves.toBe('community');
    mockGetSupabase.mockReturnValue(grants(['professional']));
    storedRoles('professional', 'community');
    await expect(resolveEffectiveRole('u-pro', TENANT)).resolves.toBe('professional');
  });

  it('no stored role is still null (orb-tool falls back as before)', async () => {
    mockGetSupabase.mockReturnValue(grants([]));
    storedRoles(null, null);
    await expect(resolveEffectiveRole('u-new', TENANT)).resolves.toBeNull();
  });
});

describe('POST /api/v1/orb/tool with a forged developer preference', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', orbToolRouter);

  it('dev_list_vtids answers developer_role_required for a member', async () => {
    currentIdentity = { user_id: 'u-member', tenant_id: TENANT, role: 'authenticated', exafy_admin: false };
    mockGetSupabase.mockReturnValue(grants([]));
    storedRoles('developer', 'community');
    const r = await request(app).post('/api/v1/orb/tool').send({ name: 'dev_list_vtids', args: {} });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, error: 'developer_role_required' });
  });

  it('an exafy admin still passes the developer gate', async () => {
    currentIdentity = { user_id: 'u-exafy', tenant_id: TENANT, role: 'authenticated', exafy_admin: true };
    mockGetSupabase.mockReturnValue(serviceClient({ vtid_ledger: { data: [], error: null } }));
    storedRoles('developer', 'developer');
    const r = await request(app).post('/api/v1/orb/tool').send({ name: 'dev_list_vtids', args: {} });
    expect(r.body.error).not.toBe('developer_role_required');
  });
});

describe('admin-users: the inline tenant-admin check requires a permitted admin', () => {
  const app = express();
  app.use('/api/v1/admin/users', adminUsersRouter);

  const asTenantUser = () =>
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u-admin', email: 'a@t.io', app_metadata: { active_tenant_id: TENANT } } },
      error: null,
    });

  it('active_role=admin without a permitted admin role → 403', async () => {
    asTenantUser();
    mockGetSupabase.mockReturnValue(
      serviceClient(
        { user_permitted_roles: { data: [], error: null }, memberships: { data: [], error: null } },
        { user_tenants: { data: { active_role: 'admin' }, error: null } },
      ),
    );
    const r = await request(app).get('/api/v1/admin/users/roles-summary').set('Authorization', 'Bearer t');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('FORBIDDEN');
  });

  it('a permitted tenant admin passes', async () => {
    asTenantUser();
    mockGetSupabase.mockReturnValue(
      serviceClient(
        {
          user_permitted_roles: { data: [{ role: 'admin' }], error: null },
          memberships: { data: [], error: null },
          user_tenants: { data: [{ active_role: 'admin' }], error: null },
        },
        { user_tenants: { data: { active_role: 'admin' }, error: null } },
      ),
    );
    const r = await request(app).get('/api/v1/admin/users/roles-summary').set('Authorization', 'Bearer t');
    expect(r.status).toBe(200);
  });
});

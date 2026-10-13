/**
 * VTID-05149 (multi-tenant M0, lane A) — one primary-tenant resolver, a
 * TenantContext on the request, the default tenant instead of "the oldest",
 * and the report-only morning row 21b.
 *
 *  - resolvePrimaryTenant: deterministic query (is_primary desc, created_at,
 *    tenant_id, limit 1), tagged result per variant, membership_fallback log.
 *  - getTenantMeta / getDefaultTenantId: 60 s cache, errors never cached.
 *  - requireTenant / requireAuthWithTenant set req.tenant (token, exafy_admin
 *    token, primary, Cognito); identity.tenant_id unchanged; metadata failure
 *    never fails the request; getTenantContext() resolves lazily and memoises.
 *  - /auth/me auto-provision upserts the membership into the is_default tenant
 *    (alkalma first with the same created_at does not matter); no default → no
 *    membership + a log line; no tenants … order('created_at') anywhere in src.
 *  - universal-cart resolvePrimaryTenantId delegates to the resolver.
 *  - morning row 21b: the step's own bash against fixture replies is always
 *    INFO, never FAIL, and TOTAL_CHECKS stays 22.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

jest.mock('jose');

// One fresh chain per from() call; the response is chosen when the chain is
// awaited, from the table and every call made on it (the VTID-05043 suite's
// per-table thenable fake, extended with a call log).
type Op = [string, any[]];
type Responder = (table: string, ops: Op[]) => any;
let responder: Responder = () => ({ data: null, error: null });
const calls: Array<{ table: string; ops: Op[] }> = [];
const makeChain = (table: string) => {
  const ops: Op[] = [];
  calls.push({ table, ops });
  const chain: any = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'abortSignal', 'single', 'maybeSingle', 'upsert', 'update', 'insert', 'in']) {
    chain[m] = jest.fn((...args: any[]) => {
      ops.push([m, args]);
      return chain;
    });
  }
  chain.then = (resolve: (v: any) => any, reject?: (e: any) => any) => {
    try {
      return Promise.resolve(responder(table, ops)).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).then(resolve, reject);
    }
  };
  return chain;
};
const mockSupabase: any = { from: jest.fn((table: string) => makeChain(table)) };
const mockGetSupabase = jest.fn(() => mockSupabase);

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockGetSupabase() }));
jest.mock('../src/services/guide/active-usage', () => ({ upsertActiveDay: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/cognito-auth-client', () => ({
  isCognitoAuthConfigured: jest.fn(() => false),
  cognitoLogin: jest.fn(),
  cognitoRefresh: jest.fn(),
}));

import {
  resolvePrimaryTenant,
  getTenantMeta,
  getDefaultTenantId,
  clearTenantMetaCache,
  type PrimaryTenantResult,
} from '../src/services/tenancy/tenant-context';
import {
  requireAuth,
  requireTenant,
  requireAuthWithTenant,
  getTenantContext,
  clearTenantMembershipCache,
  type AuthenticatedRequest,
} from '../src/middleware/auth-supabase-jwt';
import authRouter from '../src/routes/auth';
import { resolvePrimaryTenantId } from '../src/routes/universal-cart';

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(__dirname, '../src');
const MAXINA = '2e7528b8-472a-4356-88da-0280d4639cce';
const ALKALMA = '73cc592f-84ec-457a-b0f7-25a082d7e011';
const TIE = '2025-08-30T16:27:07.760873+00:00';
const TENANT_ROWS = [
  { tenant_id: ALKALMA, slug: 'alkalma', is_default: false, is_platform: false, created_at: TIE },
  { tenant_id: MAXINA, slug: 'maxina', is_default: true, is_platform: false, created_at: TIE },
];

const opsOf = (table: string) => calls.filter((c) => c.table === table).map((c) => c.ops);
const has = (ops: Op[], m: string) => ops.some(([name]) => name === m);
const primaryLookups = () => opsOf('user_tenants').filter((o) => has(o, 'order'));
const membershipLookups = () => opsOf('user_tenants').filter((o) => has(o, 'maybeSingle'));

/** Standard world: tenants answer TENANT_ROWS; user_tenants answers per query kind. */
function world(opts: {
  primary?: any;
  membership?: any;
  tenants?: any;
  appUsers?: any;
} = {}) {
  responder = (table, ops) => {
    if (table === 'tenants') return opts.tenants ?? { data: TENANT_ROWS, error: null };
    if (table === 'user_tenants') {
      if (has(ops, 'order')) return opts.primary ?? { data: [], error: null };
      if (has(ops, 'maybeSingle')) return opts.membership ?? { data: null, error: null };
    }
    if (table === 'app_users') return opts.appUsers ?? { data: null, error: null };
    return { data: null, error: null };
  };
}

let sub = 0;
const uniqueSub = (l: string) => `${l}-${++sub}`;
function claims(s: string, appMetadata: Record<string, unknown> = { active_tenant_id: MAXINA, exafy_admin: false }) {
  return { sub: s, email: 'user@example.com', role: 'authenticated', aud: ['authenticated'], exp: 1893456000, iat: 1893452400, app_metadata: appMetadata };
}
const verified = (payload: object) => (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });

const echo = (req: any, res: any) => res.json({ ok: true, identity: req.identity ?? null, tenant: req.tenant ?? null });
const app = express();
app.get('/tenant', requireAuth, requireTenant, echo);
app.get('/auth-tenant', requireAuthWithTenant, echo);
app.get('/lazy', requireAuth, async (req: AuthenticatedRequest, res) => {
  const first = await getTenantContext(req);
  const second = await getTenantContext(req);
  res.json({ ok: true, first, same: first === second, identity_tenant: req.identity?.tenant_id ?? null });
});
app.use('/auth', authRouter);

let warn: jest.SpyInstance;
let log: jest.SpyInstance;
beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.TENANT_MEMBERSHIP_CHECK_MODE;
  calls.length = 0;
  mockGetSupabase.mockReturnValue(mockSupabase);
  mockSupabase.from.mockImplementation((table: string) => makeChain(table));
  clearTenantMetaCache();
  clearTenantMembershipCache();
  world();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const warned = (event: string) =>
  warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(`"event":"${event}"`)).map((m) => JSON.parse(m));

// ===========================================================================
describe('resolvePrimaryTenant', () => {
  it('asks for is_primary desc, created_at, tenant_id with limit(1) and the abort signal', async () => {
    world({ primary: { data: [{ tenant_id: MAXINA, active_role: 'community', is_primary: true }], error: null } });
    const signal = new AbortController().signal;
    const r = await resolvePrimaryTenant('u1', { signal });
    expect(r).toEqual({ status: 'found', tenantId: MAXINA, role: 'community', source: 'primary' });
    const ops = primaryLookups()[0];
    expect(ops).toEqual([
      ['select', ['tenant_id, active_role, is_primary']],
      ['eq', ['user_id', 'u1']],
      ['order', ['is_primary', { ascending: false }]],
      ['order', ['created_at', { ascending: true }]],
      ['order', ['tenant_id', { ascending: true }]],
      ['limit', [1]],
      ['abortSignal', [signal]],
    ]);
    expect(has(ops, 'single')).toBe(false);
  });

  it('0 rows → none', async () => {
    world({ primary: { data: [], error: null } });
    expect(await resolvePrimaryTenant('u1')).toEqual({ status: 'none' });
  });

  it('an error, a throw (abort) or no client → unavailable', async () => {
    world({ primary: { data: null, error: { message: 'boom' } } });
    expect(await resolvePrimaryTenant('u1')).toEqual({ status: 'unavailable' });
    responder = () => {
      throw new Error('The operation was aborted');
    };
    expect(await resolvePrimaryTenant('u1')).toEqual({ status: 'unavailable' });
    mockGetSupabase.mockReturnValue(null as any);
    expect(await resolvePrimaryTenant('u1')).toEqual({ status: 'unavailable' });
  });

  it('a non-primary hit → membership_fallback + tenant_primary_missing log', async () => {
    world({ primary: { data: [{ tenant_id: ALKALMA, active_role: 'staff', is_primary: false }], error: null } });
    expect(await resolvePrimaryTenant('u-np')).toEqual({ status: 'found', tenantId: ALKALMA, role: 'staff', source: 'membership_fallback' });
    expect(warned('tenant_primary_missing')).toEqual([
      { event: 'tenant_primary_missing', vtid: 'VTID-05149', user_id: 'u-np', tenant_id: ALKALMA },
    ]);
  });

  it('the result type is exhaustive (a new variant is a compile error)', () => {
    const label = (r: PrimaryTenantResult): string => {
      switch (r.status) {
        case 'found':
          return r.source;
        case 'none':
          return 'none';
        case 'unavailable':
          return 'unavailable';
        default: {
          const x: never = r;
          return x;
        }
      }
    };
    expect(label({ status: 'none' })).toBe('none');
  });
});

describe('getTenantMeta / getDefaultTenantId', () => {
  it('reads slug and flags once per 60 s', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(await getTenantMeta(MAXINA)).toEqual({ slug: 'maxina', isPlatform: false, isDefault: true });
    expect(await getDefaultTenantId()).toBe(MAXINA);
    expect(opsOf('tenants')).toHaveLength(1);
    expect(opsOf('tenants')[0][0]).toEqual(['select', ['tenant_id, slug, is_default, is_platform']]);
    spy.mockReturnValue(now + 61_000);
    await getTenantMeta(MAXINA);
    expect(opsOf('tenants')).toHaveLength(2);
  });

  it('never caches an error; unknown tenant → null', async () => {
    world({ tenants: { data: null, error: { message: 'column tenants.is_default does not exist' } } });
    expect(await getTenantMeta(MAXINA)).toBeNull();
    expect(await getDefaultTenantId()).toBeNull();
    world();
    expect(await getDefaultTenantId()).toBe(MAXINA);
    expect(await getTenantMeta('no-such-tenant')).toBeNull();
    expect(opsOf('tenants')).toHaveLength(3);
  });
});

// ===========================================================================
describe.each([
  ['requireTenant', '/tenant'],
  ['requireAuthWithTenant', '/auth-tenant'],
])('%s sets req.tenant', (_name, route) => {
  it('maxina member, token tenant = maxina → source token with the membership role', async () => {
    verified(claims(uniqueSub('tok')));
    world({ membership: { data: { tenant_id: MAXINA, active_role: 'community' }, error: null } });
    const res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.tenant).toEqual({ tenantId: MAXINA, slug: 'maxina', role: 'community', source: 'token', isPlatform: false });
    expect(res.body.identity.tenant_id).toBe(MAXINA);
    expect(primaryLookups()).toHaveLength(0);
    expect(membershipLookups()[0][0]).toEqual(['select', ['tenant_id, active_role']]);
  });

  it('no claim → source primary, identity.tenant_id from the primary row as before', async () => {
    verified(claims(uniqueSub('noclaim'), {}));
    world({ primary: { data: [{ tenant_id: MAXINA, active_role: 'professional', is_primary: true }], error: null } });
    const res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.identity.tenant_id).toBe(MAXINA);
    expect(res.body.tenant).toEqual({ tenantId: MAXINA, slug: 'maxina', role: 'professional', source: 'primary', isPlatform: false });
    expect(membershipLookups()).toHaveLength(0);
  });

  it('exafy_admin token → source exafy_admin_token, role null, no membership lookup', async () => {
    verified(claims(uniqueSub('exafy'), { active_tenant_id: ALKALMA, exafy_admin: true }));
    const res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.tenant).toEqual({ tenantId: ALKALMA, slug: 'alkalma', role: null, source: 'exafy_admin_token', isPlatform: false });
    expect(membershipLookups()).toHaveLength(0);
  });

  it('two primary rows → deterministic first row (no longer 400; was .single())', async () => {
    verified(claims(uniqueSub('two'), {}));
    world({ primary: { data: [{ tenant_id: ALKALMA, active_role: 'community', is_primary: true }], error: null } });
    const res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.identity.tenant_id).toBe(ALKALMA);
    expect(has(primaryLookups()[0], 'single')).toBe(false);
  });

  it('no primary row but another membership → membership_fallback', async () => {
    verified(claims(uniqueSub('fallback'), {}));
    world({ primary: { data: [{ tenant_id: ALKALMA, active_role: 'community', is_primary: false }], error: null } });
    const res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.tenant.source).toBe('membership_fallback');
  });

  it('no membership → 400 TENANT_REQUIRED; lookup unavailable → 400 TENANT_REQUIRED', async () => {
    verified(claims(uniqueSub('none'), {}));
    world({ primary: { data: [], error: null } });
    let res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TENANT_REQUIRED');
    world({ primary: { data: null, error: { message: 'timeout' } } });
    res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TENANT_REQUIRED');
  });

  it('tenant metadata unavailable → slug null, isPlatform false, warning, request still succeeds', async () => {
    verified(claims(uniqueSub('nometa')));
    world({
      membership: { data: { tenant_id: MAXINA, active_role: 'community' }, error: null },
      tenants: { data: null, error: { message: 'boom' } },
    });
    const res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.tenant).toEqual({ tenantId: MAXINA, slug: null, role: 'community', source: 'token', isPlatform: false });
    expect(warned('tenant_meta_unavailable')).toHaveLength(1);
  });

  it('VTID-05043 unchanged: a non-member claim is still 403 and no tenant context is set', async () => {
    verified(claims(uniqueSub('stranger')));
    const res = await request(app).get(route).set('Authorization', 'Bearer good');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('TENANT_NOT_MEMBER');
  });
});

describe('Cognito identity (tenant_id null) → primary', () => {
  beforeEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.COGNITO_USER_POOL_ID = 'eu-central-1_TestPool';
    process.env.COGNITO_REGION = 'eu-central-1';
    process.env.COGNITO_APP_CLIENT_ID = 'test-app-client-id';
    (jose.createRemoteJWKSet as jest.Mock).mockReturnValue('cognito-jwks-sentinel');
  });
  afterEach(() => {
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_REGION;
    delete process.env.COGNITO_APP_CLIENT_ID;
  });

  it('requireAuthWithTenant resolves the primary tenant for a Cognito token', async () => {
    verified({ sub: 'cognito-sub', token_use: 'id', email: 'm@example.com', aud: 'test-app-client-id', exp: 1893456000, iat: 1893452400, 'custom:legacy_user_id': 'legacy-1' });
    world({ primary: { data: [{ tenant_id: MAXINA, active_role: 'community', is_primary: true }], error: null } });
    const res = await request(app).get('/auth-tenant').set('Authorization', 'Bearer cognito');
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ tenantId: MAXINA, source: 'primary', slug: 'maxina' });
    expect(primaryLookups()[0]).toContainEqual(['eq', ['user_id', 'legacy-1']]);
  });
});

describe('getTenantContext (lazy, for requireAuth routes)', () => {
  it('no claim → primary, memoised on req.tenant, identity.tenant_id untouched', async () => {
    verified(claims(uniqueSub('lazy'), {}));
    world({ primary: { data: [{ tenant_id: MAXINA, active_role: 'community', is_primary: true }], error: null } });
    const res = await request(app).get('/lazy').set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.first).toMatchObject({ tenantId: MAXINA, source: 'primary' });
    expect(res.body.same).toBe(true);
    expect(res.body.identity_tenant).toBeNull();
    expect(primaryLookups()).toHaveLength(1);
  });

  it('token tenant the caller is not a member of → null (never a context from an unverified claim)', async () => {
    verified(claims(uniqueSub('lazy-stranger')));
    const res = await request(app).get('/lazy').set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.first).toBeNull();
  });

  it('token tenant + membership → source token', async () => {
    verified(claims(uniqueSub('lazy-member')));
    world({ membership: { data: { tenant_id: MAXINA, active_role: 'staff' }, error: null } });
    const res = await request(app).get('/lazy').set('Authorization', 'Bearer good');
    expect(res.body.first).toEqual({ tenantId: MAXINA, slug: 'maxina', role: 'staff', source: 'token', isPlatform: false });
  });
});

// ===========================================================================
describe('/auth/me auto-provision uses the default tenant', () => {
  /** A signed-in user with no app_users row and no user_tenants membership. */
  function missingRecordsWorld(tenants: any) {
    responder = (table, ops) => {
      if (table === 'tenants') return tenants;
      if (table === 'app_users' && has(ops, 'upsert')) return { data: { display_name: 'user', avatar_url: null, bio: null }, error: null };
      if (table === 'app_users' && has(ops, 'single')) return { data: null, error: { message: 'no rows' } };
      if (table === 'user_tenants' && has(ops, 'upsert')) {
        const row = ops.find(([m]) => m === 'upsert')![1][0];
        return { data: { tenant_id: row.tenant_id, active_role: row.active_role, is_primary: row.is_primary }, error: null };
      }
      if (table === 'user_tenants') return { data: [], error: null };
      return { data: null, error: null };
    };
  }
  const upserts = (table: string) =>
    opsOf(table).flatMap((o) => o.filter(([m]) => m === 'upsert').map(([, a]) => a[0]));

  it('alkalma listed first with the same created_at, maxina is_default → the membership goes to maxina', async () => {
    verified(claims(uniqueSub('me'), {}));
    missingRecordsWorld({ data: TENANT_ROWS, error: null });
    const res = await request(app).get('/auth/me').set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(upserts('user_tenants')).toEqual([{ tenant_id: MAXINA, user_id: expect.any(String), active_role: 'community', is_primary: true }]);
    expect(upserts('app_users')[0]).toMatchObject({ tenant_id: MAXINA });
    expect(res.body.memberships).toEqual([{ tenant_id: MAXINA, role: 'community', is_primary: true }]);
    for (const ops of opsOf('tenants')) expect(has(ops, 'order')).toBe(false);
  });

  it('no default tenant → no user_tenants upsert, app_users upsert with tenant_id null, default_tenant_unresolved logged', async () => {
    verified(claims(uniqueSub('me-nodefault'), {}));
    missingRecordsWorld({ data: TENANT_ROWS.map((t) => ({ ...t, is_default: false })), error: null });
    const res = await request(app).get('/auth/me').set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(upserts('user_tenants')).toEqual([]);
    expect(upserts('app_users')[0]).toMatchObject({ tenant_id: null });
    expect(warned('default_tenant_unresolved')).toHaveLength(1);
  });

  it('source pin: nothing in src orders tenants by created_at, and fetchOldestTenant is gone', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const s = fs.readFileSync(p, 'utf8');
          if (/from\(\s*['"]tenants['"]\s*\)[^;]*?\.order\(\s*['"]created_at['"]/s.test(s) || s.includes('fetchOldestTenant')) {
            offenders.push(path.relative(SRC, p));
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe('universal-cart resolvePrimaryTenantId', () => {
  it('returns the resolver tenant; none/unavailable → null', async () => {
    world({ primary: { data: [{ tenant_id: ALKALMA, active_role: 'community', is_primary: true }], error: null } });
    expect(await resolvePrimaryTenantId('u-cart')).toBe(ALKALMA);
    expect(primaryLookups()).toHaveLength(1);
    world({ primary: { data: [], error: null } });
    expect(await resolvePrimaryTenantId('u-cart')).toBeNull();
    world({ primary: { data: null, error: { message: 'x' } } });
    expect(await resolvePrimaryTenantId('u-cart')).toBeNull();
  });

  it('the old repository function is removed (single caller delegated)', () => {
    const repoSrc = fs.readFileSync(path.join(SRC, 'routes/universal-cart-context-repository.ts'), 'utf8');
    expect(repoSrc).not.toContain('fetchPrimaryTenantId');
  });
});

// ===========================================================================
describe('morning row 21b (report-only)', () => {
  const WF_TEXT = fs.readFileSync(path.join(ROOT, '.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml'), 'utf8');
  const STEP = "21b. Tenant isolation health (report-only, VTID-05149)";
  const script = (): string => {
    const wf = yaml.load(WF_TEXT) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
    for (const job of Object.values(wf.jobs)) {
      const step = job.steps.find((s) => s.name === STEP);
      if (step?.run) return step.run;
    }
    throw new Error('row 21b step not found');
  };
  /** Runs row 21b with curl replaced by a stub serving `body` with `status`. */
  const run21b = (status: number, body: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05149-'));
    const fixture = path.join(dir, 'rpc.json');
    fs.writeFileSync(fixture, body);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/bash\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${fixture}" "$2"; shift; fi; shift; done\nprintf ${status}\n`,
      { mode: 0o755 },
    );
    const report = path.join(dir, 'report.md');
    execFileSync('bash', ['-c', script()], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPORT: report, SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE: 'k' },
    });
    return fs.readFileSync(report, 'utf8').trim();
  };

  it('200 with counts → one INFO row with the numbers', () => {
    const line = run21b(200, JSON.stringify({
      foreign_tenant_rows: 3628,
      foreign_tenant_tables: [{ table: 'memory_facts', rows: 1067 }, { table: 'mem_facts', rows: 1066 }, { table: 'vitana_index_scores', rows: 708 }, { table: 'chat_messages', rows: 305 }],
      null_tenant_rows: 2158,
      users_zero_primary: 0,
      users_multi_primary: 0,
      memberships_not_in_user_tenants: 0,
      user_tenants_not_in_memberships: 18,
      default_tenant_count: 1,
      scan_errors: [],
    }));
    expect(line).toBe(
      '| 21b | Tenant isolation health | INFO | foreign 3628 (top: memory_facts 1067, mem_facts 1066, vitana_index_scores 708), null 2158, primary 0/2+: 0/0, drift 0/18, default=1 |',
    );
  });

  it('scan errors are named in the row, still INFO', () => {
    const line = run21b(200, JSON.stringify({ foreign_tenant_rows: 0, foreign_tenant_tables: [], scan_errors: [{ table: 't', sqlstate: '57014' }], default_tenant_count: 1 }));
    expect(line).toContain('| INFO |');
    expect(line).toContain('scan errors 1');
  });

  it('404 (not applied yet) and malformed JSON → INFO, never FAIL', () => {
    const notApplied = run21b(404, '{"message":"not found"}');
    expect(notApplied).toBe('| 21b | Tenant isolation health | INFO | RPC HTTP 404 (not applied yet?) |');
    const malformed = run21b(200, 'not json at all');
    expect(malformed).toMatch(/^\| 21b \| Tenant isolation health \| INFO \|/);
    for (const l of [notApplied, malformed]) expect(l).not.toContain('| FAIL |');
  });

  it('the step can never write FAIL, sits between 21 and 22, and TOTAL_CHECKS stays 22', () => {
    const i = WF_TEXT.indexOf(`- name: '${STEP}'`);
    expect(i).toBeGreaterThan(WF_TEXT.indexOf("- name: '21. Memory system health (VTID-04345)'"));
    expect(i).toBeLessThan(WF_TEXT.indexOf("- name: '22. Scheduled-workflow self-audit'"));
    expect(script()).not.toContain('FAIL');
    expect(script()).toContain('/rest/v1/rpc/ci_tenant_isolation_health');
    expect(WF_TEXT).toMatch(/TOTAL_CHECKS: 22\n/);
  });
});

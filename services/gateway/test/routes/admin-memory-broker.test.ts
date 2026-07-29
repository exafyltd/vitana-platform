/**
 * Tests for src/routes/admin-memory-broker.ts (VTID-02026 / VTID-02631 /
 * VTID-02632 / VTID-02636).
 *
 * Auth: `/admin/memory/*` and `/admin/consolidator/*` are path-scoped
 * behind requireAuth + requireExafyAdmin (auth-supabase-jwt), verified via
 * jose.jwtVerify — same pattern as test/routes/admin-notification-categories.test.ts.
 * We assert the admin gate refuses BEFORE any downstream service/DB call
 * is made, per the admin-denial pattern in
 * test/services/orb-tools/admin-users-rbac-tools.test.ts.
 */
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

jest.mock('jose');

// Fire-and-forget active-day tracker invoked by requireAuth — keep it inert.
jest.mock('../../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
  countActiveUsageDays: jest.fn().mockResolvedValue(0),
}));

const mockGetMemoryContext = jest.fn();
jest.mock('../../src/services/memory-broker', () => ({
  getMemoryContext: (...args: unknown[]) => mockGetMemoryContext(...args),
}));

const mockBuildAgentProfile = jest.fn();
jest.mock('../../src/services/agent-profile-service', () => ({
  buildAgentProfile: (...args: unknown[]) => mockBuildAgentProfile(...args),
}));

const mockRunConsolidator = jest.fn();
jest.mock('../../src/services/nightly-consolidator', () => ({
  runConsolidator: (...args: unknown[]) => mockRunConsolidator(...args),
}));

const mockGetSystemControl = jest.fn();
jest.mock('../../src/services/system-controls-service', () => ({
  getSystemControl: (...args: unknown[]) => mockGetSystemControl(...args),
}));

// Per-table thenable query-chain mock for getSupabase()
const createChain = () => {
  let resolved: any = { data: [], error: null, count: 0 };
  const chain: any = {
    select: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    ilike: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    then: (resolve: (v: any) => any, reject: (e: any) => any) => Promise.resolve(resolved).then(resolve, reject),
    mockResolvedValue(v: any) {
      resolved = v;
      return chain;
    },
  };
  return chain;
};

const tableChains: Record<string, ReturnType<typeof createChain>> = {};
const chainFor = (table: string) => (tableChains[table] ??= createChain());
const mockSupabase = { from: jest.fn((table: string) => chainFor(table)) };
const mockGetSupabase = jest.fn(() => mockSupabase as any);

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

import router from '../../src/routes/admin-memory-broker';

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

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const USER_A = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPABASE_JWT_SECRET = 'test-secret';
  delete process.env.SUPABASE_AUTH_JWKS_URL;
  mockInvalidJwt();
  mockGetSupabase.mockReturnValue(mockSupabase as any);
  for (const chain of Object.values(tableChains)) chain.mockResolvedValue({ data: [], error: null, count: 0 });
  mockGetSystemControl.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Admin gate — every /admin/memory/* and /admin/consolidator/* route
// ---------------------------------------------------------------------------

describe('admin gate (applies to every route in this router)', () => {
  const cases: Array<[string, string, object | undefined]> = [
    ['get', '/admin/memory/context?tenant_id=t&user_id=u', undefined],
    ['post', '/admin/memory/context', { tenant_id: TENANT_A, user_id: USER_A }],
    ['get', '/admin/memory/profile?tenant_id=t&user_id=u', undefined],
    ['post', '/admin/memory/profile', { tenant_id: TENANT_A, user_id: USER_A }],
    ['get', '/admin/memory/health', undefined],
    ['get', '/admin/memory/graph-sample', undefined],
    ['get', '/admin/memory/embeddings', undefined],
    ['post', '/admin/consolidator/run', {}],
  ];

  // NOTE: requireAuth itself does a best-effort `app_users` lookup
  // (resolveVitanaId) on every successfully-verified token, independent of
  // the admin gate — so "no DB access at all" isn't the right assertion.
  // What must be true is that none of the ROUTE's own business logic
  // (service calls, or any *other* table) ever runs.
  function businessTablesTouched(): string[] {
    return mockSupabase.from.mock.calls.map((c: any[]) => c[0]).filter((t: string) => t !== 'app_users');
  }

  it.each(cases)('%s %s returns 401 with no Authorization header, and calls no downstream service', async (method, path) => {
    const res = await (request(app) as any)[method](path).send();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(mockGetMemoryContext).not.toHaveBeenCalled();
    expect(mockBuildAgentProfile).not.toHaveBeenCalled();
    expect(mockRunConsolidator).not.toHaveBeenCalled();
    expect(businessTablesTouched()).toEqual([]);
  });

  it.each(cases)('%s %s returns 403 for a non-admin caller, and calls no downstream service', async (method, path, body) => {
    mockVerifiedJwt(NON_ADMIN_CLAIMS);
    const res = await (request(app) as any)[method](path)
      .set('Authorization', 'Bearer valid-non-admin-token')
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockGetMemoryContext).not.toHaveBeenCalled();
    expect(mockBuildAgentProfile).not.toHaveBeenCalled();
    expect(mockRunConsolidator).not.toHaveBeenCalled();
    expect(businessTablesTouched()).toEqual([]);
  });

  it('returns 401 for an invalid/expired token even with exafy_admin-shaped claims never verified', async () => {
    mockInvalidJwt();
    const res = await request(app).get('/admin/memory/context?tenant_id=t&user_id=u').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(mockGetMemoryContext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET/POST /admin/memory/context
// ---------------------------------------------------------------------------

describe('GET /admin/memory/context', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('requires tenant_id and user_id', async () => {
    const res = await request(app).get('/admin/memory/context').set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(400);
    expect(mockGetMemoryContext).not.toHaveBeenCalled();
  });

  it('rejects an unknown intent', async () => {
    const res = await request(app)
      .get(`/admin/memory/context?tenant_id=${TENANT_A}&user_id=${USER_A}&intent=not_a_real_intent`)
      .set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(400);
    expect(mockGetMemoryContext).not.toHaveBeenCalled();
  });

  it('forwards the exact tenant_id/user_id/intent to getMemoryContext, admin channel/role', async () => {
    mockGetMemoryContext.mockResolvedValue({ ok: true, blocks: [] });
    const res = await request(app)
      .get(`/admin/memory/context?tenant_id=${TENANT_A}&user_id=${USER_A}&intent=identity&budget_ms=500`)
      .set('Authorization', 'Bearer valid-admin-token');

    expect(res.status).toBe(200);
    expect(mockGetMemoryContext).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      user_id: USER_A,
      intent: 'identity',
      channel: 'admin',
      role: 'admin',
      latency_budget_ms: 500,
    });
  });

  it('defaults intent to recall_history and budget to 1500ms', async () => {
    mockGetMemoryContext.mockResolvedValue({ ok: true, blocks: [] });
    await request(app)
      .get(`/admin/memory/context?tenant_id=${TENANT_A}&user_id=${USER_A}`)
      .set('Authorization', 'Bearer valid-admin-token');
    expect(mockGetMemoryContext).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'recall_history', latency_budget_ms: 1500 }),
    );
  });
});

describe('POST /admin/memory/context', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('requires tenant_id and user_id in body', async () => {
    const res = await request(app).post('/admin/memory/context').set('Authorization', 'Bearer valid-admin-token').send({});
    expect(res.status).toBe(400);
    expect(mockGetMemoryContext).not.toHaveBeenCalled();
  });

  it('forwards required_blocks when provided as an array', async () => {
    mockGetMemoryContext.mockResolvedValue({ ok: true, blocks: [] });
    await request(app)
      .post('/admin/memory/context')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ tenant_id: TENANT_A, user_id: USER_A, required_blocks: ['identity', 'recent_episodes'] });
    expect(mockGetMemoryContext).toHaveBeenCalledWith(
      expect.objectContaining({ required_blocks: ['identity', 'recent_episodes'] }),
    );
  });

  it('leaves required_blocks undefined when not an array', async () => {
    mockGetMemoryContext.mockResolvedValue({ ok: true, blocks: [] });
    await request(app)
      .post('/admin/memory/context')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ tenant_id: TENANT_A, user_id: USER_A, required_blocks: 'not-an-array' });
    expect(mockGetMemoryContext).toHaveBeenCalledWith(
      expect.objectContaining({ required_blocks: undefined }),
    );
  });

  it('two different admins requesting different users each get their own scoped call (no cross-user bleed)', async () => {
    mockGetMemoryContext.mockResolvedValue({ ok: true, blocks: [] });
    const USER_B = '55555555-5555-5555-5555-555555555555';
    await request(app).post('/admin/memory/context').set('Authorization', 'Bearer t').send({ tenant_id: TENANT_A, user_id: USER_A });
    await request(app).post('/admin/memory/context').set('Authorization', 'Bearer t').send({ tenant_id: TENANT_A, user_id: USER_B });
    expect(mockGetMemoryContext.mock.calls[0][0].user_id).toBe(USER_A);
    expect(mockGetMemoryContext.mock.calls[1][0].user_id).toBe(USER_B);
  });
});

// ---------------------------------------------------------------------------
// GET/POST /admin/memory/profile
// ---------------------------------------------------------------------------

describe('GET /admin/memory/profile', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('requires tenant_id and user_id', async () => {
    const res = await request(app).get('/admin/memory/profile').set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(400);
    expect(mockBuildAgentProfile).not.toHaveBeenCalled();
  });

  it('forwards tenant_id/user_id/budget/max_chars to buildAgentProfile', async () => {
    mockBuildAgentProfile.mockResolvedValue({ ok: true, markdown: 'profile' });
    const res = await request(app)
      .get(`/admin/memory/profile?tenant_id=${TENANT_A}&user_id=${USER_A}&budget_ms=800&max_chars=2000`)
      .set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(200);
    expect(mockBuildAgentProfile).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      user_id: USER_A,
      latency_budget_ms: 800,
      max_chars: 2000,
    });
  });
});

describe('POST /admin/memory/profile', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('requires tenant_id and user_id in body', async () => {
    const res = await request(app).post('/admin/memory/profile').set('Authorization', 'Bearer valid-admin-token').send({});
    expect(res.status).toBe(400);
    expect(mockBuildAgentProfile).not.toHaveBeenCalled();
  });

  it('forwards the body scoping fields through', async () => {
    mockBuildAgentProfile.mockResolvedValue({ ok: true, markdown: 'profile' });
    await request(app)
      .post('/admin/memory/profile')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ tenant_id: TENANT_A, user_id: USER_A, max_chars: 500 });
    expect(mockBuildAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_A, user_id: USER_A, max_chars: 500 }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /admin/memory/health
// ---------------------------------------------------------------------------

describe('GET /admin/memory/health', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('returns ok:false without querying tables when supabase is unavailable', async () => {
    // Permanently null (not *Once*) — requireAuth's own resolveVitanaId
    // also calls getSupabase() before the handler runs, and it degrades
    // gracefully (vitana_id stays null), so this doesn't affect the gate.
    mockGetSupabase.mockReturnValue(null as any);
    const res = await request(app).get('/admin/memory/health').set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('falls back to null for a table whose count query errors, without failing the whole response', async () => {
    chainFor('mem_episodes').mockResolvedValue({ data: null, error: { message: 'relation does not exist' }, count: null });
    chainFor('memory_items').mockResolvedValue({ data: null, error: null, count: 42 });
    const res = await request(app).get('/admin/memory/health').set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.table_counts.mem_episodes).toBeNull();
    expect(res.body.table_counts.memory_items).toBe(42);
  });

  it('reports each flag from getSystemControl, null on lookup failure', async () => {
    mockGetSystemControl.mockImplementation(async (key: string) => {
      if (key === 'memory_broker_enabled') return { enabled: true };
      if (key === 'consolidator_enabled') throw new Error('boom');
      return { enabled: false };
    });
    const res = await request(app).get('/admin/memory/health').set('Authorization', 'Bearer valid-admin-token');
    expect(res.body.flags.memory_broker_enabled).toBe(true);
    expect(res.body.flags.consolidator_enabled).toBeNull();
    expect(res.body.flags.cognee_extraction_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/memory/graph-sample
// ---------------------------------------------------------------------------

describe('GET /admin/memory/graph-sample', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('scopes mem_graph_edges to the given user_id when provided', async () => {
    chainFor('mem_graph_edges').mockResolvedValue({ data: [{ id: 'e1' }], error: null });
    chainFor('relationship_edges').mockResolvedValue({ data: [], error: null });
    const res = await request(app)
      .get(`/admin/memory/graph-sample?user_id=${USER_A}`)
      .set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(200);
    expect(chainFor('mem_graph_edges').eq).toHaveBeenCalledWith('user_id', USER_A);
    expect(chainFor('relationship_edges').eq).toHaveBeenCalledWith('source_id', USER_A);
    expect(res.body.mem_graph_edges).toEqual([{ id: 'e1' }]);
  });

  it('does not scope by user_id when none is given', async () => {
    const res = await request(app).get('/admin/memory/graph-sample').set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(200);
    expect(chainFor('mem_graph_edges').eq).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /admin/memory/embeddings
// ---------------------------------------------------------------------------

describe('GET /admin/memory/embeddings', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('reports vector counts per collection, error status on failure', async () => {
    chainFor('memory_items').mockResolvedValue({ data: null, error: null, count: 10 });
    chainFor('mem_episodes').mockResolvedValue({ data: null, error: { message: 'x' }, count: null });
    chainFor('memory_diary_entries').mockResolvedValue({ data: null, error: null, count: 0 });
    const res = await request(app).get('/admin/memory/embeddings').set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.collections.map((c: any) => [c.key, c]));
    expect(byKey.memory_items.vectors).toBe(10);
    expect(byKey.memory_items.status).toBe('active');
    expect(byKey.mem_episodes.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// POST /admin/consolidator/run
// ---------------------------------------------------------------------------

describe('POST /admin/consolidator/run', () => {
  beforeEach(() => mockVerifiedJwt(ADMIN_CLAIMS));

  it('scopes to a single user when both tenant_id and user_id are given', async () => {
    mockRunConsolidator.mockResolvedValue({ ok: true, summary: 'ran' });
    await request(app)
      .post('/admin/consolidator/run')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ tenant_id: TENANT_A, user_id: USER_A, loops: ['loop1'] });
    expect(mockRunConsolidator).toHaveBeenCalledWith({
      triggered_by: 'admin',
      user_scope: { tenant_id: TENANT_A, user_id: USER_A },
      loops: ['loop1'],
    });
  });

  it('sweeps all users (user_scope undefined) when only tenant_id is given', async () => {
    mockRunConsolidator.mockResolvedValue({ ok: true, summary: 'ran' });
    await request(app)
      .post('/admin/consolidator/run')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ tenant_id: TENANT_A });
    expect(mockRunConsolidator).toHaveBeenCalledWith(
      expect.objectContaining({ user_scope: undefined }),
    );
  });

  it('leaves loops undefined when not an array', async () => {
    mockRunConsolidator.mockResolvedValue({ ok: true, summary: 'ran' });
    await request(app)
      .post('/admin/consolidator/run')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ loops: 'not-an-array' });
    expect(mockRunConsolidator).toHaveBeenCalledWith(
      expect.objectContaining({ loops: undefined }),
    );
  });
});

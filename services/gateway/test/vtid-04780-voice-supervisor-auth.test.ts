/**
 * VTID-04780 — tenant-scoped access to voice telemetry.
 *
 *   - /api/v1/voice/supervisor: exafy_admin sees every tenant (and may narrow
 *     with tenant_id); a tenant admin is forced to their own tenant whatever
 *     tenant_id says; any other signed-in user gets 403; no token 401.
 *   - /api/v1/voice-lab live sessions / healing / probe: a plain member is
 *     now refused (it used to be requireAuth only — every tenant's sessions
 *     for any signed-in user).
 *
 * Auth is mocked at the middleware boundary: the bearer token names the
 * caller ("admin", "tadmin", "member"). Data access is mocked at the
 * voice-supervisor-data boundary so the assertions see exactly which tenant
 * each read was scoped to.
 */

import request from 'supertest';
import express from 'express';

const T_OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const IDENTITIES: Record<string, any> = {
  admin: { user_id: '11111111-1111-4111-8111-111111111111', tenant_id: T_OWN, exafy_admin: true },
  tadmin: { user_id: '22222222-2222-4222-8222-222222222222', tenant_id: T_OWN, exafy_admin: false },
  member: { user_id: '33333333-3333-4333-8333-333333333333', tenant_id: T_OWN, exafy_admin: false },
};

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(async (req: any, res: any, next: any) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const id = IDENTITIES[token];
    if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { ...id };
    return next();
  }),
  optionalAuth: jest.fn((_req: any, _res: any, next: any) => next()),
  requireExafyAdmin: jest.fn((req: any, res: any, next: any) =>
    req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false })),
}));

jest.mock('../src/services/dependency-probe', () => ({
  withDependencyHealth: async (_deps: unknown, body: unknown) => body,
}));

const mockFetchFactRows = jest.fn();
const mockFetchOpenFactRows = jest.fn();
const mockFetchSessionsPage = jest.fn();
const mockFetchTenants = jest.fn();
const mockFetchDistinctDims = jest.fn();
const mockFetchCallerTenantRole = jest.fn();
const mockFetchFixes = jest.fn();
const mockFetchFix = jest.fn();

jest.mock('../src/services/voice-supervisor-data', () => {
  class SupervisorDataError extends Error {}
  return {
    MAX_FACT_ROWS: 50000,
    SupervisorDataError,
    fetchFactRows: (...a: any[]) => mockFetchFactRows(...a),
    fetchOpenFactRows: (...a: any[]) => mockFetchOpenFactRows(...a),
    fetchSessionsPage: (...a: any[]) => mockFetchSessionsPage(...a),
    fetchTenants: (...a: any[]) => mockFetchTenants(...a),
    fetchDistinctDims: (...a: any[]) => mockFetchDistinctDims(...a),
    fetchCallerTenantRole: (...a: any[]) => mockFetchCallerTenantRole(...a),
    fetchFixes: (...a: any[]) => mockFetchFixes(...a),
    fetchFix: (...a: any[]) => mockFetchFix(...a),
  };
});

import supervisorRouter from '../src/routes/voice-supervisor';
import voiceLabRouter from '../src/routes/voice-lab';

const app = express();
app.use(express.json());
app.use('/api/v1/voice/supervisor', supervisorRouter);
app.use('/api/v1/voice-lab', voiceLabRouter);

const auth = (who: string) => ({ Authorization: `Bearer ${who}` });

function fact(over: Record<string, unknown> = {}) {
  return {
    session_id: `live-${Math.random()}`,
    tenant_id: T_OWN,
    surface: 'vitanaland',
    role: 'community',
    provider: 'nova_sonic',
    lang: 'de',
    started_at: new Date(Date.now() - 600_000).toISOString(),
    ended_at: new Date(Date.now() - 500_000).toISOString(),
    outcome: 'ok',
    ttfa_ms: 1000,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchCallerTenantRole.mockImplementation(async (userId: string) =>
    userId === IDENTITIES.tadmin.user_id ? 'admin' : 'community');
  mockFetchFactRows.mockResolvedValue({ rows: [fact()], truncated: false });
  mockFetchOpenFactRows.mockResolvedValue([]);
  mockFetchSessionsPage.mockResolvedValue([]);
  mockFetchTenants.mockResolvedValue([{ tenant_id: T_OWN, name: 'Maxina', slug: 'maxina' }]);
  mockFetchDistinctDims.mockResolvedValue({ surfaces: [], roles: ['community'], providers: ['nova_sonic'], langs: ['de'] });
  mockFetchFixes.mockResolvedValue([]);
});

describe('VTID-04780 voice supervisor access', () => {
  test('no token → 401', async () => {
    const res = await request(app).get('/api/v1/voice/supervisor/overview');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  test('a plain member → 403 on every endpoint', async () => {
    for (const p of ['meta', 'overview', 'segments', 'sessions', 'fixes', 'fixes/healing_history:00000000-0000-4000-8000-000000000000/impact']) {
      const res = await request(app).get(`/api/v1/voice/supervisor/${p}`).set(auth('member'));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    }
    expect(mockFetchFactRows).not.toHaveBeenCalled();
  });

  test('platform admin: all tenants by default, may narrow with tenant_id', async () => {
    let res = await request(app).get('/api/v1/voice/supervisor/overview').set(auth('admin'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockFetchFactRows.mock.calls[0][0].tenant_id).toBeNull();

    mockFetchFactRows.mockClear();
    res = await request(app).get(`/api/v1/voice/supervisor/overview?tenant_id=${T_OTHER}`).set(auth('admin'));
    expect(res.status).toBe(200);
    expect(mockFetchFactRows.mock.calls[0][0].tenant_id).toBe(T_OTHER);

    res = await request(app).get('/api/v1/voice/supervisor/meta').set(auth('admin'));
    expect(res.body.scope).toEqual({ is_platform_admin: true, tenant_id: null });
    expect(mockFetchTenants).toHaveBeenCalledWith(null);
  });

  test('tenant admin is forced to their own tenant whatever tenant_id says', async () => {
    const res = await request(app).get(`/api/v1/voice/supervisor/overview?tenant_id=${T_OTHER}`).set(auth('tadmin'));
    expect(res.status).toBe(200);
    expect(mockFetchFactRows.mock.calls[0][0].tenant_id).toBe(T_OWN);
    expect(mockFetchOpenFactRows.mock.calls[0][0].tenant_id).toBe(T_OWN);
    expect(res.body.scope).toEqual({ is_platform_admin: false, tenant_id: T_OWN });

    for (const p of [`segments?tenant_id=${T_OTHER}`, `sessions?tenant_id=${T_OTHER}`]) {
      mockFetchFactRows.mockClear();
      mockFetchSessionsPage.mockClear();
      const r = await request(app).get(`/api/v1/voice/supervisor/${p}`).set(auth('tadmin'));
      expect(r.status).toBe(200);
      const call = (mockFetchFactRows.mock.calls[0] ?? mockFetchSessionsPage.mock.calls[0])[0];
      expect(call.tenant_id).toBe(T_OWN);
    }

    const meta = await request(app).get('/api/v1/voice/supervisor/meta').set(auth('tadmin'));
    expect(meta.body.scope).toEqual({ is_platform_admin: false, tenant_id: T_OWN });
    expect(mockFetchTenants).toHaveBeenCalledWith([T_OWN]);
    expect(mockFetchDistinctDims.mock.calls[0][1]).toBe(T_OWN);
  });

  test('tenant admin: fixes limited to platform-wide + own tenant, without VTID/PR links', async () => {
    mockFetchFixes.mockResolvedValue([
      { fix_id: 'healing_history:1', source: 'healing_history', title: 'a', vtid: 'VTID-1', pr_url: 'https://x', fixed_at: new Date().toISOString(), failure_class: 'voice.model_stall', segment: { tenant_id: T_OTHER }, status: 'ok' },
      { fix_id: 'healing_history:2', source: 'healing_history', title: 'b', vtid: 'VTID-2', pr_url: 'https://y', fixed_at: new Date().toISOString(), failure_class: 'voice.model_stall', segment: { tenant_id: T_OWN }, status: 'ok' },
      { fix_id: 'architecture_report:3', source: 'architecture_report', title: 'c', vtid: 'VTID-3', pr_url: 'https://z', fixed_at: new Date().toISOString(), failure_class: 'voice.no_engagement', segment: {}, status: 'merged' },
    ]);
    const t = await request(app).get('/api/v1/voice/supervisor/fixes').set(auth('tadmin'));
    expect(t.body.fixes.map((f: any) => f.fix_id)).toEqual(['healing_history:2', 'architecture_report:3']);
    expect(t.body.fixes.every((f: any) => f.vtid === null && f.pr_url === null)).toBe(true);

    const a = await request(app).get('/api/v1/voice/supervisor/fixes').set(auth('admin'));
    expect(a.body.fixes).toHaveLength(3);
    expect(a.body.fixes[0].pr_url).toBe('https://x');
  });

  test('impact: a tenant admin cannot read another tenant\'s fix', async () => {
    mockFetchFix.mockResolvedValue({ fix_id: 'healing_history:1', source: 'healing_history', title: 'a', vtid: null, pr_url: null, fixed_at: new Date(Date.now() - 86_400_000).toISOString(), failure_class: 'voice.model_stall', segment: { tenant_id: T_OTHER }, status: 'ok' });
    const res = await request(app).get('/api/v1/voice/supervisor/fixes/healing_history:1/impact').set(auth('tadmin'));
    expect(res.status).toBe(404);
  });

  test('impact: compares the fix segment before vs after', async () => {
    const fixedAt = Date.now() - 3 * 86_400_000;
    mockFetchFix.mockResolvedValue({ fix_id: 'healing_history:9', source: 'healing_history', title: 'a', vtid: null, pr_url: null, fixed_at: new Date(fixedAt).toISOString(), failure_class: 'voice.model_stall', segment: { tenant_id: T_OWN }, status: 'ok' });
    const before = Array.from({ length: 30 }, (_, i) => fact({ started_at: new Date(fixedAt - (i + 1) * 3600_000).toISOString(), ...(i < 12 ? { outcome: 'silent', failure_class: 'voice.model_stall' } : {}) }));
    const after = Array.from({ length: 30 }, (_, i) => fact({ started_at: new Date(fixedAt + (i + 1) * 3600_000).toISOString(), ...(i < 2 ? { outcome: 'silent', failure_class: 'voice.model_stall' } : {}) }));
    mockFetchFactRows.mockResolvedValue({ rows: [...before, ...after], truncated: false });
    const res = await request(app).get('/api/v1/voice/supervisor/fixes/healing_history:9/impact?days=7').set(auth('admin'));
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('improved');
    expect(res.body.min_sample).toBe(20);
    expect(res.body.before.kpis.sessions).toBe(30);
    expect(res.body.after.kpis.sessions).toBe(30);
    expect(res.body.delta.silent_rate).toBeCloseTo(2 / 30 - 12 / 30);
    expect(mockFetchFactRows.mock.calls[0][0].tenant_id).toBe(T_OWN);
  });

  test('a failed read is a 502, never an empty healthy answer', async () => {
    const { SupervisorDataError } = jest.requireMock('../src/services/voice-supervisor-data');
    mockFetchFactRows.mockRejectedValue(new SupervisorDataError('voice_session_facts read failed: 404'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/v1/voice/supervisor/overview').set(auth('admin'));
    err.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
  });
});

describe('VTID-04780 voice-lab is developer-only', () => {
  test('a plain member is refused on live sessions, healing and probe', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [method, path] of [
      ['get', '/api/v1/voice-lab/live/sessions'],
      ['get', '/api/v1/voice-lab/live/sessions/live-1'],
      ['get', '/api/v1/voice-lab/healing/overview'],
      ['get', '/api/v1/voice-lab/healing/reports'],
      ['post', '/api/v1/voice-lab/probe'],
      ['post', '/api/v1/voice-lab/healing/gchat-ping-test'],
      ['get', '/api/v1/voice-lab/debug/events'],
    ] as const) {
      const res = await (request(app) as any)[method](path).set(auth('member'));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    }
    warn.mockRestore();
  });

  test('a tenant admin is refused too (all-tenant data)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).get('/api/v1/voice-lab/live/sessions').set(auth('tadmin'));
    warn.mockRestore();
    expect(res.status).toBe(403);
  });

  test('no token is still 401; /health stays public', async () => {
    expect((await request(app).get('/api/v1/voice-lab/live/sessions')).status).toBe(401);
    expect((await request(app).get('/api/v1/voice-lab/health')).status).toBe(200);
  });

  test('exafy_admin passes the gate', async () => {
    const { requireVoiceLabDevAccess } = require('../src/routes/voice-lab');
    const next = jest.fn();
    const req: any = { headers: { authorization: 'Bearer admin' }, get: () => undefined, method: 'GET', path: '/x' };
    const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
    await requireVoiceLabDevAccess(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

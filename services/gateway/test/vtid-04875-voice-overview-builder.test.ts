/**
 * VTID-04875 — Overview Phase 1a: characterization of
 * GET /api/v1/voice/supervisor/overview across the extraction of its inline
 * handler into services/voice-supervisor-overview.ts (buildVoiceOverview).
 *
 * The "route" block was written FIRST and run against the old inline
 * handler; its snapshots record status, content-type, the exact JSON text,
 * and the exact arguments every data-layer read received (so tenant scoping
 * provably did not move). After the refactor it is re-run with `--ci`.
 *
 * The "builder" block proves buildVoiceOverview() — no req — returns the
 * same body, and that scope `{ is_platform_admin: true }` means unscoped.
 *
 * Date is frozen (only Date). Auth and data access are mocked at the same
 * boundaries test/routes/voice-supervisor.test.ts uses; no network, no DB.
 */

import request from 'supertest';
import express from 'express';

const T_OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const IDENTITIES: Record<string, any> = {
  admin: { user_id: '11111111-1111-4111-8111-111111111111', tenant_id: T_OWN, exafy_admin: true },
  tadmin: { user_id: '22222222-2222-4222-8222-222222222222', tenant_id: T_OWN, exafy_admin: false },
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

const mockFetchFactRows = jest.fn();
const mockFetchOpenFactRows = jest.fn();
const mockFetchTenants = jest.fn();
const mockFetchCallerTenantRole = jest.fn();

jest.mock('../src/services/voice-supervisor-data', () => {
  class SupervisorDataError extends Error {}
  return {
    MAX_FACT_ROWS: 50000,
    SupervisorDataError,
    fetchFactRows: (...a: any[]) => mockFetchFactRows(...a),
    fetchOpenFactRows: (...a: any[]) => mockFetchOpenFactRows(...a),
    fetchSessionsPage: jest.fn(),
    fetchTenants: (...a: any[]) => mockFetchTenants(...a),
    fetchDistinctDims: jest.fn(),
    fetchCallerTenantRole: (...a: any[]) => mockFetchCallerTenantRole(...a),
    fetchFixes: jest.fn(),
    fetchFix: jest.fn(),
  };
});

import supervisorRouter from '../src/routes/voice-supervisor';
import { SupervisorDataError } from '../src/services/voice-supervisor-data';

const app = express();
app.use(express.json());
app.use('/api/v1/voice/supervisor', supervisorRouter);

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3600_000;

let seq = 0;
function fact(over: Record<string, unknown> = {}) {
  seq++;
  return {
    session_id: `s-${seq}`,
    tenant_id: T_OWN,
    surface: 'vitanaland',
    role: 'community',
    provider: 'nova_sonic',
    lang: 'de',
    started_at: ago(10 * 60_000),
    ended_at: ago(9 * 60_000),
    outcome: 'ok',
    ttfa_ms: 1000,
    ...over,
  };
}

function richRows() {
  seq = 0;
  const rows: any[] = [];
  // current window: mix of providers/tenants/outcomes so verdicts fire
  for (let i = 0; i < 12; i++) rows.push(fact({ started_at: ago((i + 1) * 60_000), ended_at: ago(i * 60_000 + 30_000) }));
  for (let i = 0; i < 8; i++) {
    rows.push(fact({ tenant_id: T_OTHER, provider: 'cascade', lang: 'ru', outcome: i < 5 ? 'silent' : 'ok', started_at: ago((i + 2) * 120_000), ended_at: ago((i + 2) * 120_000 - 30_000), ttfa_ms: i < 5 ? null : 2500 }));
  }
  rows.push(fact({ surface: 'admin', role: 'admin', outcome: 'error', started_at: ago(3 * H) }));
  // previous window (24h–48h ago)
  for (let i = 0; i < 6; i++) rows.push(fact({ started_at: ago(30 * H + i * 60_000), ended_at: ago(30 * H + i * 60_000 - 20_000) }));
  return rows;
}

function openRows() {
  return [
    fact({ ended_at: null, outcome: null, started_at: ago(60_000), last_seen_at: ago(5_000) }),
    fact({ ended_at: null, outcome: null, surface: 'command-hub', provider: 'vertex', started_at: ago(120_000), last_seen_at: ago(3_000) }),
    fact({ ended_at: null, outcome: null, surface: null, provider: null, started_at: ago(30_000), last_seen_at: ago(1_000) }),
  ];
}

type Scenario = { name: string; who: string; qs: string; setup: () => void };

const SCENARIOS: Scenario[] = [
  {
    name: 'platform admin, default window, no filters',
    who: 'admin',
    qs: '',
    setup: () => {
      mockFetchFactRows.mockResolvedValue({ rows: richRows(), truncated: false });
      mockFetchOpenFactRows.mockResolvedValue(openRows());
    },
  },
  {
    name: 'platform admin, window=7d, tenant_id + filters, truncated',
    who: 'admin',
    qs: `?window=7d&tenant_id=${T_OTHER}&provider=cascade&lang=ru&surface=vitanaland&role=community&assistant=vitana`,
    setup: () => {
      mockFetchFactRows.mockResolvedValue({ rows: richRows().filter((r) => r.tenant_id === T_OTHER), truncated: true });
      mockFetchOpenFactRows.mockResolvedValue([]);
    },
  },
  {
    name: 'platform admin, bogus window + non-uuid tenant_id fall back',
    who: 'admin',
    qs: '?window=13y&tenant_id=not-a-uuid',
    setup: () => {
      mockFetchFactRows.mockResolvedValue({ rows: [], truncated: false });
      mockFetchOpenFactRows.mockResolvedValue([]);
    },
  },
  {
    name: 'tenant admin is forced to own tenant whatever tenant_id says',
    who: 'tadmin',
    qs: `?window=1h&tenant_id=${T_OTHER}`,
    setup: () => {
      mockFetchFactRows.mockResolvedValue({ rows: richRows().filter((r) => r.tenant_id === T_OWN), truncated: false });
      mockFetchOpenFactRows.mockResolvedValue(openRows());
    },
  },
  {
    name: 'data layer SupervisorDataError → 502',
    who: 'admin',
    qs: '?window=30d',
    setup: () => {
      mockFetchFactRows.mockRejectedValue(new SupervisorDataError('voice_session_facts read failed: 500'));
      mockFetchOpenFactRows.mockResolvedValue([]);
    },
  },
  {
    name: 'unexpected Error → 500',
    who: 'admin',
    qs: '',
    setup: () => {
      mockFetchFactRows.mockResolvedValue({ rows: richRows(), truncated: false });
      mockFetchOpenFactRows.mockRejectedValue(new Error('boom'));
    },
  },
  {
    name: 'tenant name lookup fails → 502',
    who: 'admin',
    qs: '',
    setup: () => {
      mockFetchFactRows.mockResolvedValue({ rows: richRows(), truncated: false });
      mockFetchOpenFactRows.mockResolvedValue([]);
      mockFetchTenants.mockRejectedValue(new SupervisorDataError('tenants read failed'));
    },
  },
];

beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
      'clearInterval', 'setTimeout', 'clearTimeout',
    ],
  });
});
afterAll(() => jest.useRealTimers());

let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.setSystemTime(NOW);
  mockFetchFactRows.mockReset();
  mockFetchOpenFactRows.mockReset();
  mockFetchTenants.mockReset();
  mockFetchCallerTenantRole.mockReset();
  mockFetchCallerTenantRole.mockImplementation(async (userId: string) =>
    userId === IDENTITIES.tadmin.user_id ? 'admin' : 'community');
  mockFetchTenants.mockImplementation(async (ids: string[] | null) =>
    [{ tenant_id: T_OWN, name: 'Maxina', slug: 'maxina' }, { tenant_id: T_OTHER, name: 'Other', slug: 'other' }]
      .filter((t) => !ids || ids.includes(t.tenant_id)));
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errSpy.mockRestore());

function dataCalls() {
  return {
    fetchFactRows: mockFetchFactRows.mock.calls,
    fetchOpenFactRows: mockFetchOpenFactRows.mock.calls,
    fetchTenants: mockFetchTenants.mock.calls,
  };
}

describe('VTID-04875 GET /voice/supervisor/overview — characterization (old handler == new wrapper)', () => {
  for (const sc of SCENARIOS) {
    it(`route: ${sc.name}`, async () => {
      sc.setup();
      const res = await request(app)
        .get(`/api/v1/voice/supervisor/overview${sc.qs}`)
        .set('Authorization', `Bearer ${sc.who}`);
      expect({
        status: res.status,
        content_type: res.headers['content-type'],
        body_text: res.text,
        data_calls: dataCalls(),
        console_error: errSpy.mock.calls.map((c) => c[0]),
      }).toMatchSnapshot();
    });
  }
});

describe('VTID-04875 buildVoiceOverview() — in-process, no req', () => {
  it('platform-admin scope with no filters equals the route body for an exafy_admin with no query', async () => {
    SCENARIOS[0].setup();
    const viaRoute = await request(app).get('/api/v1/voice/supervisor/overview').set('Authorization', 'Bearer admin');
    const routeCalls = dataCalls();
    mockFetchFactRows.mockClear();
    mockFetchOpenFactRows.mockClear();
    mockFetchTenants.mockClear();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildVoiceOverview } = require('../src/services/voice-supervisor-overview');
    const body = await buildVoiceOverview({ window: '24h', scope: { is_platform_admin: true } });
    expect(JSON.stringify(body)).toBe(viaRoute.text);
    expect(dataCalls()).toEqual(routeCalls);
    // unscoped: tenant_id null on both reads
    expect(mockFetchFactRows.mock.calls[0][0].tenant_id).toBeNull();
    expect(mockFetchOpenFactRows.mock.calls[0][0].tenant_id).toBeNull();
  });

  it('window defaults to 24h and accepts a parsed window object', async () => {
    SCENARIOS[0].setup();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildVoiceOverview } = require('../src/services/voice-supervisor-overview');
    const a = await buildVoiceOverview({ scope: { is_platform_admin: true } });
    const b = await buildVoiceOverview({ window: { key: '24h', ms: 86_400_000 }, scope: { is_platform_admin: true, tenant_id: null } });
    expect(a.window).toBe('24h');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('equals the route for every scenario that succeeds, given the same scope + filters', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildVoiceOverview } = require('../src/services/voice-supervisor-overview');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { scopedFilters, parseWindow } = require('../src/routes/voice-supervisor');
    for (const sc of SCENARIOS.slice(0, 4)) {
      sc.setup();
      const viaRoute = await request(app).get(`/api/v1/voice/supervisor/overview${sc.qs}`).set('Authorization', `Bearer ${sc.who}`);
      const query = Object.fromEntries(new URLSearchParams(sc.qs.replace(/^\?/, '')));
      const scope = sc.who === 'admin' ? { is_platform_admin: true, tenant_id: null } : { is_platform_admin: false, tenant_id: T_OWN };
      sc.setup();
      const body = await buildVoiceOverview({ window: parseWindow(query.window), scope, filters: scopedFilters(scope, query) });
      expect(JSON.stringify(body)).toBe(viaRoute.text);
    }
  });

  it('throws the data-layer error unchanged (the route maps it to 502)', async () => {
    SCENARIOS[4].setup();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildVoiceOverview } = require('../src/services/voice-supervisor-overview');
    await expect(buildVoiceOverview({ scope: { is_platform_admin: true } })).rejects.toBeInstanceOf(SupervisorDataError);
  });

  it('a non-platform scope without explicit filters is confined to its tenant', async () => {
    SCENARIOS[0].setup();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildVoiceOverview } = require('../src/services/voice-supervisor-overview');
    const body = await buildVoiceOverview({ scope: { is_platform_admin: false, tenant_id: T_OWN } });
    expect(body.scope).toEqual({ is_platform_admin: false, tenant_id: T_OWN });
    expect(mockFetchFactRows.mock.calls[0][0].tenant_id).toBe(T_OWN);
  });

  it('a non-platform scope cannot widen its reads through filters.tenant_id', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildVoiceOverview } = require('../src/services/voice-supervisor-overview');
    const base = { surface: null, role: null, provider: null, lang: null, assistant: null };
    for (const tenant_id of [T_OTHER, null]) {
      SCENARIOS[0].setup();
      mockFetchFactRows.mockClear();
      mockFetchOpenFactRows.mockClear();
      const body = await buildVoiceOverview({
        scope: { is_platform_admin: false, tenant_id: T_OWN },
        filters: { ...base, tenant_id },
      });
      expect(body.scope.tenant_id).toBe(T_OWN);
      expect(mockFetchFactRows.mock.calls[0][0].tenant_id).toBe(T_OWN);
      expect(mockFetchOpenFactRows.mock.calls[0][0].tenant_id).toBe(T_OWN);
    }
  });

  it('a non-platform scope without tenant_id is refused, never read unscoped', async () => {
    SCENARIOS[0].setup();
    mockFetchFactRows.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildVoiceOverview } = require('../src/services/voice-supervisor-overview');
    await expect(buildVoiceOverview({ scope: { is_platform_admin: false, tenant_id: null } })).rejects.toThrow(/requires tenant_id/);
    expect(mockFetchFactRows).not.toHaveBeenCalled();
  });
});

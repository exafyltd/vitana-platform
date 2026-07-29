import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Mocks — dev-autopilot.ts auths via requireAuth (auth-supabase-jwt), which
// verifies the JWT with jose. The router itself does NOT use the supabase-js
// client for its own data access — it does raw `fetch()` calls against
// SUPABASE_URL (see supaGet/supaPost/supaPatch helpers in the route file),
// so we mock global.fetch per-test instead of a supabase-js chain. All
// service-layer collaborators (synthesis/planning/execute/bridge/safety/
// oasis-event/outcomes) are mocked at the module boundary.
// ---------------------------------------------------------------------------

jest.mock('jose');

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => null),
}));

jest.mock('../../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
  countActiveUsageDays: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../src/services/dev-autopilot-synthesis', () => ({
  ingestScan: jest.fn(),
}));
jest.mock('../../src/services/dev-autopilot-planning', () => ({
  generatePlanVersion: jest.fn(),
}));
jest.mock('../../src/services/dev-autopilot-execute', () => ({
  approveAutoExecute: jest.fn(),
  cancelExecution: jest.fn(),
}));
jest.mock('../../src/services/dev-autopilot-bridge', () => ({
  bridgeFailureToSelfHealing: jest.fn(),
}));
jest.mock('../../src/services/dev-autopilot-self-heal-log', () => ({
  writeAutopilotFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/dev-autopilot-safety', () => ({
  dryRunPreflight: jest.fn(),
}));
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' }),
}));
jest.mock('../../src/services/dev-autopilot-outcomes', () => ({
  recordOutcome: jest.fn().mockResolvedValue(undefined),
}));

import { ingestScan } from '../../src/services/dev-autopilot-synthesis';
import { generatePlanVersion } from '../../src/services/dev-autopilot-planning';
import { approveAutoExecute, cancelExecution } from '../../src/services/dev-autopilot-execute';
import { bridgeFailureToSelfHealing } from '../../src/services/dev-autopilot-bridge';
import { writeAutopilotFailure } from '../../src/services/dev-autopilot-self-heal-log';
import { dryRunPreflight } from '../../src/services/dev-autopilot-safety';
import { emitOasisEvent } from '../../src/services/oasis-event-service';
import { recordOutcome } from '../../src/services/dev-autopilot-outcomes';

// SCAN_TOKEN is captured as a module-level constant at import time
// (`const SCAN_TOKEN = process.env.DEV_AUTOPILOT_SCAN_TOKEN || '';`), so the
// env var MUST be set before the router module is first required. Using a
// plain `require()` here (rather than a static `import`) guarantees this
// assignment runs first under ts-jest's CommonJS output, regardless of any
// import-hoisting ambiguity.
const SCAN_TOKEN = 'test-scan-token-xyz';
process.env.DEV_AUTOPILOT_SCAN_TOKEN = SCAN_TOKEN;
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../src/routes/dev-autopilot').default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/dev-autopilot', router);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ ok: false, error: err.message });
  });
  return app;
}

const app = buildApp();

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

function jsonRes(status: number, body: any, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type Route = (url: string, opts: any) => any | undefined;

function setFetchRoutes(routes: Route[], fallback: any = jsonRes(200, [])) {
  (global.fetch as jest.Mock).mockImplementation((url: any, opts?: any) => {
    const urlStr = String(url);
    for (const r of routes) {
      const result = r(urlStr, opts || {});
      if (result !== undefined) return Promise.resolve(result);
    }
    return Promise.resolve(fallback);
  });
}

function method(opts: any): string {
  return (opts && opts.method) || 'GET';
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

const ADMIN_CLAIMS = {
  sub: 'dev-admin-1',
  email: 'dev@example.com',
  role: 'authenticated',
  app_metadata: { exafy_admin: true },
};

const NON_ADMIN_CLAIMS = {
  sub: 'user-1',
  email: 'user@example.com',
  role: 'authenticated',
  app_metadata: { exafy_admin: false },
};

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}
function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

function asAdmin(req: request.Test): request.Test {
  return req.set('Authorization', 'Bearer admin-token');
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
  delete process.env.SUPABASE_AUTH_JWKS_URL;
  delete process.env.LOVABLE_JWT_SECRET;
  delete process.env.GATEWAY_INTERNAL_TOKEN;
  mockVerifiedJwt(ADMIN_CLAIMS);
  (global.fetch as jest.Mock).mockReset();
  setFetchRoutes([]);
  (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true, event_id: 'evt-1' });
  (recordOutcome as jest.Mock).mockResolvedValue(undefined);
  (writeAutopilotFailure as jest.Mock).mockResolvedValue(undefined);
});

// =============================================================================
// Governance gate #1: requireDevRole (auth + exafy_admin) on every dev-only
// endpoint. This is the primary access-control gate for the entire dev
// autopilot surface (queue browsing, approvals, kill switch).
// =============================================================================

describe('requireDevRole governance gate', () => {
  const protectedEndpoints: Array<{ method: 'get' | 'post'; url: string; body?: any }> = [
    { method: 'get', url: '/api/v1/dev-autopilot/runs' },
    { method: 'get', url: '/api/v1/dev-autopilot/runs/run-1' },
    { method: 'get', url: '/api/v1/dev-autopilot/scanners' },
    { method: 'get', url: '/api/v1/dev-autopilot/impact-rules' },
    { method: 'get', url: '/api/v1/dev-autopilot/auto-approve' },
    { method: 'get', url: '/api/v1/dev-autopilot/pending-approvals' },
    { method: 'get', url: '/api/v1/dev-autopilot/pending-approvals/count' },
    { method: 'get', url: '/api/v1/dev-autopilot/queue' },
    { method: 'get', url: '/api/v1/dev-autopilot/findings/f1' },
    { method: 'post', url: '/api/v1/dev-autopilot/findings/f1/generate-plan' },
    { method: 'post', url: '/api/v1/dev-autopilot/findings/f1/continue-planning', body: { feedback: 'x' } },
    { method: 'post', url: '/api/v1/dev-autopilot/findings/f1/reject' },
    { method: 'post', url: '/api/v1/dev-autopilot/findings/batch-reject', body: { ids: ['f1'] } },
    { method: 'post', url: '/api/v1/dev-autopilot/findings/f1/snooze' },
    { method: 'post', url: '/api/v1/dev-autopilot/findings/batch-snooze', body: { ids: ['f1'], hours: 1 } },
    { method: 'post', url: '/api/v1/dev-autopilot/findings/f1/approve-auto-execute' },
    { method: 'post', url: '/api/v1/dev-autopilot/findings/batch-approve-auto-execute', body: { ids: ['f1'] } },
    { method: 'post', url: '/api/v1/dev-autopilot/executions/e1/cancel' },
    { method: 'post', url: '/api/v1/dev-autopilot/executions/e1/bridge', body: { failure_stage: 'ci' } },
    { method: 'get', url: '/api/v1/dev-autopilot/executions/e1/lineage' },
    { method: 'get', url: '/api/v1/dev-autopilot/executions' },
    { method: 'get', url: '/api/v1/dev-autopilot/config' },
    { method: 'post', url: '/api/v1/dev-autopilot/config/kill-switch' },
  ];

  it.each(protectedEndpoints)(
    'blocks $method $url with 401 UNAUTHENTICATED when no Authorization header is present',
    async ({ method: m, url, body }) => {
      const res = await (request(app)[m](url) as request.Test).send(body || {});
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    },
  );

  it.each(protectedEndpoints)(
    'blocks $method $url with 401 UNAUTHENTICATED when the JWT fails verification',
    async ({ method: m, url, body }) => {
      mockInvalidJwt();
      const res = await asAdmin(request(app)[m](url) as request.Test).send(body || {});
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    },
  );

  it.each(protectedEndpoints)(
    'blocks $method $url with 403 when the caller is authenticated but not exafy_admin',
    async ({ method: m, url, body }) => {
      mockVerifiedJwt(NON_ADMIN_CLAIMS);
      const res = await asAdmin(request(app)[m](url) as request.Test).send(body || {});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Dev Autopilot requires developer access (exafy_admin)');
    },
  );

  it('allows an exafy_admin through to the handler', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_runs') ? jsonRes(200, []) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/runs'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('lets X-Gateway-Internal bypass auth entirely when it matches GATEWAY_INTERNAL_TOKEN', async () => {
    process.env.GATEWAY_INTERNAL_TOKEN = 'internal-secret';
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_runs') ? jsonRes(200, []) : undefined)]);
    const res = await request(app)
      .get('/api/v1/dev-autopilot/runs')
      .set('X-Gateway-Internal', 'internal-secret');
    expect(res.status).toBe(200);
    // No JWT was ever verified for this request.
    expect(jose.jwtVerify).not.toHaveBeenCalled();
  });

  it('does NOT bypass when X-Gateway-Internal is wrong, even with GATEWAY_INTERNAL_TOKEN configured', async () => {
    process.env.GATEWAY_INTERNAL_TOKEN = 'internal-secret';
    const res = await request(app)
      .get('/api/v1/dev-autopilot/runs')
      .set('X-Gateway-Internal', 'wrong-value');
    expect(res.status).toBe(401);
  });

  it('adversarial: does NOT bypass on the fallback sentinel "__dev__" when GATEWAY_INTERNAL_TOKEN is unset', async () => {
    // GATEWAY_INTERNAL_TOKEN is deliberately unset in this test (see beforeEach).
    // The route computes `req.get('X-Gateway-Internal') === (process.env.GATEWAY_INTERNAL_TOKEN || '__dev__')`
    // — an attacker who knows the '__dev__' fallback string must NOT be able to
    // bypass auth just because the env var happens to be unset.
    const res = await request(app)
      .get('/api/v1/dev-autopilot/runs')
      .set('X-Gateway-Internal', '__dev__');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });
});

// =============================================================================
// Governance gate #2: requireScanToken on POST /scan and POST /impact-ingest
// — these are hit by the GitHub Actions workflow, not a logged-in user, so
// they're gated by a shared-secret header instead of a JWT.
// =============================================================================

describe('requireScanToken governance gate — POST /scan', () => {
  it('blocks with 401 when the token header is missing', async () => {
    const res = await request(app).post('/api/v1/dev-autopilot/scan').send({ signals: [] });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid scan token');
  });

  it('blocks with 401 when the token header is wrong', async () => {
    const res = await request(app)
      .post('/api/v1/dev-autopilot/scan')
      .set('X-DevAutopilot-Scan-Token', 'not-the-token')
      .send({ signals: [] });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid scan token');
  });

  it('rejects a body without signals[] even with a valid token', async () => {
    const res = await request(app)
      .post('/api/v1/dev-autopilot/scan')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('body must include signals[]');
  });

  it('ingests successfully with a valid token and forwards the synthesis result', async () => {
    (ingestScan as jest.Mock).mockResolvedValue({ ok: true, findings_created: 2 });
    const res = await request(app)
      .post('/api/v1/dev-autopilot/scan')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({ signals: [{ type: 'lint' }], triggered_by: 'ci' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, findings_created: 2 });
    expect(ingestScan).toHaveBeenCalledWith({
      signals: [{ type: 'lint' }],
      triggered_by: 'ci',
      metadata: {},
    });
  });

  it('surfaces a synthesis ok:false result as 500 and logs an autopilot failure', async () => {
    (ingestScan as jest.Mock).mockResolvedValue({ ok: false, error: 'bad signal shape' });
    const res = await request(app)
      .post('/api/v1/dev-autopilot/scan')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({ signals: [{ type: 'lint' }] });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    // dev-autopilot.ts has its own local getSupabase() (reads SUPABASE_URL /
    // SUPABASE_SERVICE_ROLE directly) — independent of the mocked
    // '../../src/lib/supabase' module used by the auth middleware.
    expect(writeAutopilotFailure).toHaveBeenCalledWith(
      { url: 'http://localhost:54321', key: 'test-service-role-key-mock' },
      expect.objectContaining({
        stage: 'scan_ingest',
        failure_class: 'dev_autopilot_scan_ingest_failed',
        outcome: 'escalated',
      }),
    );
  });

  it('handles a thrown error from ingestScan as 500 and logs a distinct failure_class', async () => {
    (ingestScan as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await request(app)
      .post('/api/v1/dev-autopilot/scan')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({ signals: [{ type: 'lint' }] });
    expect(res.status).toBe(500);
    expect(writeAutopilotFailure).toHaveBeenCalledWith(
      { url: 'http://localhost:54321', key: 'test-service-role-key-mock' },
      expect.objectContaining({ failure_class: 'dev_autopilot_scan_ingest_threw' }),
    );
  });

  it('returns 503 (never 200) when DEV_AUTOPILOT_SCAN_TOKEN is unset on the server, even with a token header', async () => {
    // A fresh module instance with the env var cleared before load —
    // demonstrates the route refuses to silently accept-all when
    // misconfigured, rather than falling back to an open endpoint.
    let unconfiguredRouter: any;
    jest.isolateModules(() => {
      const prev = process.env.DEV_AUTOPILOT_SCAN_TOKEN;
      delete process.env.DEV_AUTOPILOT_SCAN_TOKEN;
      unconfiguredRouter = require('../../src/routes/dev-autopilot').default;
      process.env.DEV_AUTOPILOT_SCAN_TOKEN = prev;
    });
    const isolatedApp = express();
    isolatedApp.use(express.json());
    isolatedApp.use('/api/v1/dev-autopilot', unconfiguredRouter);

    const res = await request(isolatedApp)
      .post('/api/v1/dev-autopilot/scan')
      .set('X-DevAutopilot-Scan-Token', 'anything')
      .send({ signals: [] });
    expect(res.status).toBe(503);
  });
});

describe('requireScanToken governance gate — POST /impact-ingest', () => {
  it('blocks with 401 when the token is wrong', async () => {
    const res = await request(app)
      .post('/api/v1/dev-autopilot/impact-ingest')
      .set('X-DevAutopilot-Scan-Token', 'nope')
      .send({ findings: [] });
    expect(res.status).toBe(401);
  });

  it('rejects a body without findings[]', async () => {
    const res = await request(app)
      .post('/api/v1/dev-autopilot/impact-ingest')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('body must include findings[]');
  });

  it('skips info-severity findings and counts them separately', async () => {
    const res = await request(app)
      .post('/api/v1/dev-autopilot/impact-ingest')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({ findings: [{ rule: 'r1', message: 'm1', severity: 'info' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, new_count: 0, updated_count: 0, skipped_info: 1 });
  });

  it('inserts a new finding for a blocker with auto_exec_eligible=true and risk_class=high', async () => {
    let insertedBody: any = null;
    setFetchRoutes([
      (url, opts) => {
        if (url.includes('/rest/v1/autopilot_recommendations') && method(opts) === 'GET') {
          return jsonRes(200, []); // no existing fingerprint match
        }
        if (url.includes('/rest/v1/autopilot_recommendations') && method(opts) === 'POST') {
          insertedBody = JSON.parse(opts.body);
          return jsonRes(201, {});
        }
        return undefined;
      },
    ]);

    const res = await request(app)
      .post('/api/v1/dev-autopilot/impact-ingest')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({
        findings: [
          { rule: 'no-any', category: 'semantic', severity: 'blocker', file_path: 'src/x.ts', message: 'no explicit any' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.new_count).toBe(1);
    expect(insertedBody).toMatchObject({
      risk_class: 'high',
      risk_level: 'high',
      impact_score: 8,
      status: 'new',
      source_type: 'dev_autopilot_impact',
      auto_exec_eligible: true,
    });
  });

  it('inserts a warning finding with auto_exec_eligible=false and risk_class=medium', async () => {
    let insertedBody: any = null;
    setFetchRoutes([
      (url, opts) => {
        if (url.includes('/rest/v1/autopilot_recommendations') && method(opts) === 'GET') return jsonRes(200, []);
        if (url.includes('/rest/v1/autopilot_recommendations') && method(opts) === 'POST') {
          insertedBody = JSON.parse(opts.body);
          return jsonRes(201, {});
        }
        return undefined;
      },
    ]);

    const res = await request(app)
      .post('/api/v1/dev-autopilot/impact-ingest')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({ findings: [{ rule: 'r2', category: 'companion', severity: 'warning', message: 'm2' }] });

    expect(res.status).toBe(200);
    expect(insertedBody).toMatchObject({ risk_class: 'medium', auto_exec_eligible: false });
  });

  it('bumps seen_count via PATCH instead of inserting when a live fingerprint match exists', async () => {
    let patchedBody: any = null;
    setFetchRoutes([
      (url, opts) => {
        if (url.includes('/rest/v1/autopilot_recommendations') && method(opts) === 'GET') {
          return jsonRes(200, [{ id: 'existing-1', seen_count: 3 }]);
        }
        if (url.includes('/rest/v1/autopilot_recommendations?id=eq.existing-1') && method(opts) === 'PATCH') {
          patchedBody = JSON.parse(opts.body);
          return jsonRes(200, {});
        }
        return undefined;
      },
    ]);

    const res = await request(app)
      .post('/api/v1/dev-autopilot/impact-ingest')
      .set('X-DevAutopilot-Scan-Token', SCAN_TOKEN)
      .send({ findings: [{ rule: 'r3', severity: 'blocker', message: 'm3' }] });

    expect(res.status).toBe(200);
    expect(res.body.updated_count).toBe(1);
    expect(res.body.new_count).toBe(0);
    expect(patchedBody).toMatchObject({ seen_count: 4 });
  });
});

// =============================================================================
// GET /runs, GET /runs/:run_id
// =============================================================================

describe('GET /runs', () => {
  it('returns the runs list', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_runs') ? jsonRes(200, [{ run_id: 'r1' }]) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/runs'));
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([{ run_id: 'r1' }]);
  });

  it('clamps limit to a maximum of 100', async () => {
    let seenUrl = '';
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/dev_autopilot_runs')) {
          seenUrl = url;
          return jsonRes(200, []);
        }
        return undefined;
      },
    ]);
    await asAdmin(request(app).get('/api/v1/dev-autopilot/runs?limit=99999'));
    expect(seenUrl).toContain('limit=100');
  });

  it('returns 500 on a fetch error', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_runs') ? jsonRes(500, {}) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/runs'));
    expect(res.status).toBe(500);
  });
});

describe('GET /runs/:run_id', () => {
  it('returns 404 when the run does not exist', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_runs') ? jsonRes(200, []) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/runs/missing'));
    expect(res.status).toBe(404);
  });

  it('returns the run when found', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_runs') ? jsonRes(200, [{ run_id: 'r1' }]) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/runs/r1'));
    expect(res.status).toBe(200);
    expect(res.body.run).toEqual({ run_id: 'r1' });
  });
});

// =============================================================================
// GET /scanners
// =============================================================================

describe('GET /scanners', () => {
  it('aggregates open findings, last-seen, and auto_approve status per scanner', async () => {
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/dev_autopilot_scanners')) {
          return jsonRes(200, [{ scanner: 'lint-any', category: 'quality' }]);
        }
        if (url.includes('/rest/v1/autopilot_recommendations')) {
          return jsonRes(200, [{ spec_snapshot: { scanner: 'lint-any' } }, { spec_snapshot: { scanner: 'lint-any' } }]);
        }
        if (url.includes('/rest/v1/dev_autopilot_signals')) {
          return jsonRes(200, [{ scanner: 'lint-any', created_at: '2026-07-01T00:00:00Z' }]);
        }
        if (url.includes('/rest/v1/dev_autopilot_config')) {
          return jsonRes(200, [{ auto_approve_enabled: true, auto_approve_scanners: ['lint-any'] }]);
        }
        return undefined;
      },
    ]);

    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/scanners'));
    expect(res.status).toBe(200);
    const row = res.body.scanners.find((s: any) => s.scanner === 'lint-any');
    expect(row.open_findings).toBe(2);
    expect(row.last_signal_at).toBe('2026-07-01T00:00:00Z');
    expect(row.auto_approved).toBe(true);
    expect(row.in_auto_approve_list).toBe(true);
  });

  it('reports auto_approved=false when the master switch is off, even if listed', async () => {
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/dev_autopilot_scanners')) return jsonRes(200, [{ scanner: 's1' }]);
        if (url.includes('/rest/v1/autopilot_recommendations')) return jsonRes(200, []);
        if (url.includes('/rest/v1/dev_autopilot_signals')) return jsonRes(200, []);
        if (url.includes('/rest/v1/dev_autopilot_config')) {
          return jsonRes(200, [{ auto_approve_enabled: false, auto_approve_scanners: ['s1'] }]);
        }
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/scanners'));
    const row = res.body.scanners.find((s: any) => s.scanner === 's1');
    expect(row.auto_approved).toBe(false);
    expect(row.in_auto_approve_list).toBe(true);
  });
});

// =============================================================================
// GET /auto-approve — master-switch + budget view
// =============================================================================

describe('GET /auto-approve', () => {
  it('returns 500 when the dev_autopilot_config row is missing (misconfigured deployment)', async () => {
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/dev_autopilot_config')) return jsonRes(200, []);
        if (url.includes('/rest/v1/dev_autopilot_scanners')) return jsonRes(200, []);
        if (url.includes('/rest/v1/dev_autopilot_impact_rules')) return jsonRes(200, []);
        if (url.includes('/rest/v1/dev_autopilot_executions')) return jsonRes(200, []);
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/auto-approve'));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('dev_autopilot_config missing');
  });

  it('computes autonomy_percent from opted-in scanners + rules', async () => {
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/dev_autopilot_config')) {
          return jsonRes(200, [{
            auto_approve_enabled: true,
            auto_approve_max_effort: 5,
            auto_approve_risk_classes: ['low'],
            auto_approve_scanners: ['s1'],
            auto_approve_impact_enabled: false,
            auto_approve_impact_rules: [],
            daily_budget: 10,
            concurrency_cap: 2,
            kill_switch: false,
          }]);
        }
        if (url.includes('/rest/v1/dev_autopilot_scanners')) return jsonRes(200, [{ scanner: 's1' }, { scanner: 's2' }]);
        if (url.includes('/rest/v1/dev_autopilot_impact_rules')) return jsonRes(200, [{ rule: 'r1' }]);
        if (url.includes('approved_at=gte')) return jsonRes(200, [{ id: 'x' }]);
        if (url.includes('status=in.(running')) return jsonRes(200, []);
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/auto-approve'));
    expect(res.status).toBe(200);
    // 1 of (2 scanners + 1 rule) = 33%
    expect(res.body.progress.total_surfaces).toBe(3);
    expect(res.body.progress.auto_approved_surfaces).toBe(1);
    expect(res.body.progress.autonomy_percent).toBe(33);
    expect(res.body.budget.approved_today).toBe(1);
    expect(res.body.config.kill_switch).toBe(false);
  });
});

// =============================================================================
// GET /pending-approvals, GET /pending-approvals/count
// =============================================================================

describe('GET /pending-approvals', () => {
  it('queries with the not-auto-exec-eligible + not-snoozed predicate', async () => {
    let seenUrl = '';
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/autopilot_recommendations')) {
          seenUrl = url;
          return jsonRes(200, [{ id: 'a1' }]);
        }
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/pending-approvals'));
    expect(res.status).toBe(200);
    expect(res.body.recommendations).toEqual([{ id: 'a1' }]);
    expect(seenUrl).toContain('auto_exec_eligible=not.is.true');
    expect(seenUrl).toContain('status=eq.new');
  });
});

describe('GET /pending-approvals/count', () => {
  it('parses the exact count from Content-Range', async () => {
    setFetchRoutes([
      (url) => (url.includes('/rest/v1/autopilot_recommendations') ? jsonRes(200, [], { 'content-range': '0-0/42' }) : undefined),
    ]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/pending-approvals/count'));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(42);
  });

  it('defaults to 0 when Content-Range is absent', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/autopilot_recommendations') ? jsonRes(200, []) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/pending-approvals/count'));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});

// =============================================================================
// GET /queue — safety pre-flight annotation (VTID-01974)
// =============================================================================

describe('GET /queue', () => {
  it('annotates each finding with the dry-run preflight result', async () => {
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/autopilot_recommendations')) {
          return jsonRes(200, [
            { id: 'f1', risk_class: 'high', spec_snapshot: { file_path: 'services/gateway/src/x.ts' } },
          ]);
        }
        if (url.includes('/rest/v1/dev_autopilot_config')) {
          return jsonRes(200, [{ allow_scope: ['services/gateway'], deny_scope: [] }]);
        }
        return undefined;
      },
    ]);
    (dryRunPreflight as jest.Mock).mockReturnValue({
      auto_actionable: false,
      block_reason: 'risk_too_high',
      block_message: 'High risk requires manual review',
    });

    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/queue'));
    expect(res.status).toBe(200);
    expect(res.body.findings[0]).toMatchObject({
      auto_actionable: false,
      block_reason: 'risk_too_high',
      block_message: 'High risk requires manual review',
    });
    expect(dryRunPreflight).toHaveBeenCalledWith({
      file_path: 'services/gateway/src/x.ts',
      risk_class: 'high',
      allow_scope: ['services/gateway'],
      deny_scope: [],
    });
  });

  it('defaults risk_class to medium when the finding has none', async () => {
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/autopilot_recommendations')) return jsonRes(200, [{ id: 'f1', spec_snapshot: {} }]);
        if (url.includes('/rest/v1/dev_autopilot_config')) return jsonRes(200, []);
        return undefined;
      },
    ]);
    (dryRunPreflight as jest.Mock).mockReturnValue({ auto_actionable: true });
    await asAdmin(request(app).get('/api/v1/dev-autopilot/queue'));
    expect(dryRunPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ risk_class: 'medium', file_path: '' }),
    );
  });
});

// =============================================================================
// GET /findings/:id
// =============================================================================

describe('GET /findings/:id', () => {
  it('returns 404 when the finding does not exist', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/autopilot_recommendations') ? jsonRes(200, []) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/findings/missing'));
    expect(res.status).toBe(404);
  });

  it('returns the finding with its plan versions', async () => {
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/autopilot_recommendations')) return jsonRes(200, [{ id: 'f1' }]);
        if (url.includes('/rest/v1/dev_autopilot_plan_versions')) return jsonRes(200, [{ version: 1 }]);
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/findings/f1'));
    expect(res.status).toBe(200);
    expect(res.body.finding).toEqual({ id: 'f1' });
    expect(res.body.plan_versions).toEqual([{ version: 1 }]);
  });
});

// =============================================================================
// POST /findings/:id/generate-plan, POST /findings/:id/continue-planning
// =============================================================================

describe('POST /findings/:id/generate-plan', () => {
  it('delegates to generatePlanVersion and forwards the result', async () => {
    (generatePlanVersion as jest.Mock).mockResolvedValue({ ok: true, plan_markdown: '# plan' });
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/generate-plan'));
    expect(res.status).toBe(200);
    expect(generatePlanVersion).toHaveBeenCalledWith('f1');
  });

  it('returns 500 when the planning service reports ok:false', async () => {
    (generatePlanVersion as jest.Mock).mockResolvedValue({ ok: false, error: 'llm failed' });
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/generate-plan'));
    expect(res.status).toBe(500);
  });

  it('returns 500 when generatePlanVersion throws', async () => {
    (generatePlanVersion as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/generate-plan'));
    expect(res.status).toBe(500);
  });
});

describe('POST /findings/:id/continue-planning', () => {
  it('requires non-empty feedback', async () => {
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/continue-planning').send({ feedback: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('feedback required');
  });

  it('rejects feedback over 4000 chars', async () => {
    const res = await asAdmin(
      request(app)
        .post('/api/v1/dev-autopilot/findings/f1/continue-planning')
        .send({ feedback: 'x'.repeat(4001) }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('feedback must be ≤ 4000 chars');
  });

  it('passes feedback_note through to generatePlanVersion', async () => {
    (generatePlanVersion as jest.Mock).mockResolvedValue({ ok: true });
    const res = await asAdmin(
      request(app).post('/api/v1/dev-autopilot/findings/f1/continue-planning').send({ feedback: 'try again' }),
    );
    expect(res.status).toBe(200);
    expect(generatePlanVersion).toHaveBeenCalledWith('f1', { feedback_note: 'try again' });
  });
});

// =============================================================================
// POST /findings/:id/reject, POST /findings/batch-reject
// =============================================================================

describe('POST /findings/:id/reject', () => {
  it('rejects the finding, emits an OASIS event, and records the outcome', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/autopilot_recommendations') ? jsonRes(200, {}) : undefined)]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/reject'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dev_autopilot.finding.rejected', payload: { finding_id: 'f1' } }),
    );
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ finding_id: 'f1', decision: 'rejected' }),
    );
  });

  it('returns 500 and skips side-effects when the PATCH fails', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/autopilot_recommendations') ? jsonRes(500, {}) : undefined)]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/reject'));
    expect(res.status).toBe(500);
    expect(emitOasisEvent).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });
});

describe('POST /findings/batch-reject', () => {
  it('requires a non-empty ids[] array', async () => {
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/batch-reject').send({ ids: [] }));
    expect(res.status).toBe(400);
  });

  it('reports both successful and failed ids independently', async () => {
    setFetchRoutes([
      (url, opts) => {
        if (url.includes('id=eq.good')) return jsonRes(200, {});
        if (url.includes('id=eq.bad')) return jsonRes(500, {});
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/batch-reject').send({ ids: ['good', 'bad'] }));
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual(['good']);
    expect(res.body.failed).toEqual([{ id: 'bad', reason: expect.any(String) }]);
  });
});

// =============================================================================
// POST /findings/:id/snooze, POST /findings/batch-snooze
// =============================================================================

describe('POST /findings/:id/snooze', () => {
  it.each([0, -1, 24 * 30 + 1])('rejects an out-of-range hours value (%s)', async (hours) => {
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/snooze').send({ hours }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric hours value', async () => {
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/snooze').send({ hours: 'abc' }));
    expect(res.status).toBe(400);
  });

  it('defaults to 24 hours when omitted and patches snoozed_until', async () => {
    let patchedBody: any = null;
    setFetchRoutes([
      (url, opts) => {
        if (url.includes('/rest/v1/autopilot_recommendations')) {
          patchedBody = JSON.parse(opts.body);
          return jsonRes(200, {});
        }
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/snooze').send({}));
    expect(res.status).toBe(200);
    expect(patchedBody.status).toBe('snoozed');
    expect(patchedBody.snoozed_until).toBeDefined();
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'dev_autopilot.finding.snoozed' }));
  });
});

describe('POST /findings/batch-snooze', () => {
  it('requires ids[] and a positive hours value', async () => {
    const res1 = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/batch-snooze').send({ ids: [] , hours: 1 }));
    expect(res1.status).toBe(400);
    const res2 = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/batch-snooze').send({ ids: ['a'], hours: 0 }));
    expect(res2.status).toBe(400);
  });

  it('snoozes each id independently', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/autopilot_recommendations') ? jsonRes(200, {}) : undefined)]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/batch-snooze').send({ ids: ['a', 'b'], hours: 12 }));
    expect(res.status).toBe(200);
    expect(res.body.snoozed).toEqual(['a', 'b']);
  });
});

// =============================================================================
// POST /findings/:id/approve-auto-execute, batch variant
// — the closest thing this file has to an execution-authorization gate.
// =============================================================================

describe('POST /findings/:id/approve-auto-execute', () => {
  it('returns 200 and the execution when approval succeeds', async () => {
    (approveAutoExecute as jest.Mock).mockResolvedValue({ ok: true, execution: { id: 'exec-1' } });
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/approve-auto-execute'));
    expect(res.status).toBe(200);
    expect(res.body.execution).toEqual({ id: 'exec-1' });
  });

  it('returns 400 (not 500) when the safety decision blocks the approval', async () => {
    (approveAutoExecute as jest.Mock).mockResolvedValue({
      ok: false,
      error: 'blocked by safety gate',
      decision: { violations: ['deny_scope_match'] },
    });
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/approve-auto-execute'));
    expect(res.status).toBe(400);
    expect(res.body.decision.violations).toEqual(['deny_scope_match']);
  });

  it('returns 500 when the service throws', async () => {
    (approveAutoExecute as jest.Mock).mockRejectedValue(new Error('unexpected'));
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/f1/approve-auto-execute'));
    expect(res.status).toBe(500);
  });
});

describe('POST /findings/batch-approve-auto-execute', () => {
  it('requires ids[]', async () => {
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/findings/batch-approve-auto-execute').send({ ids: [] }));
    expect(res.status).toBe(400);
  });

  it('emits exactly one first_failure OASIS event even when multiple approvals fail', async () => {
    (approveAutoExecute as jest.Mock)
      .mockResolvedValueOnce({ ok: false, error: 'blocked', decision: { violations: ['v1'] } })
      .mockResolvedValueOnce({ ok: false, error: 'blocked', decision: { violations: ['v2'] } });

    const res = await asAdmin(
      request(app).post('/api/v1/dev-autopilot/findings/batch-approve-auto-execute').send({ ids: ['a', 'b'] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.failed).toHaveLength(2);
    const firstFailureCalls = (emitOasisEvent as jest.Mock).mock.calls.filter(
      (c) => c[0].type === 'dev_autopilot.batch.first_failure',
    );
    expect(firstFailureCalls).toHaveLength(1);
    expect(firstFailureCalls[0][0].payload.finding_id).toBe('a');
  });

  it('separates approved and failed ids in the response', async () => {
    (approveAutoExecute as jest.Mock)
      .mockResolvedValueOnce({ ok: true, execution: { id: 'exec-a' } })
      .mockResolvedValueOnce({ ok: false, error: 'blocked' });
    const res = await asAdmin(
      request(app).post('/api/v1/dev-autopilot/findings/batch-approve-auto-execute').send({ ids: ['a', 'b'] }),
    );
    expect(res.body.approved).toEqual([{ id: 'a', execution: { id: 'exec-a' } }]);
    expect(res.body.failed).toEqual([{ id: 'b', reason: 'blocked', violations: undefined }]);
  });
});

// =============================================================================
// POST /executions/:id/cancel, POST /executions/:id/bridge
// =============================================================================

describe('POST /executions/:id/cancel', () => {
  it('forwards the cancellation result', async () => {
    (cancelExecution as jest.Mock).mockResolvedValue({ ok: true });
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/executions/e1/cancel'));
    expect(res.status).toBe(200);
    expect(cancelExecution).toHaveBeenCalledWith('e1');
  });

  it('returns 400 when cancellation is rejected', async () => {
    (cancelExecution as jest.Mock).mockResolvedValue({ ok: false, error: 'already terminal' });
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/executions/e1/cancel'));
    expect(res.status).toBe(400);
  });
});

describe('POST /executions/:id/bridge', () => {
  it.each(['boom', 'unknown-stage'])('rejects an invalid failure_stage (%s)', async (stage) => {
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/executions/e1/bridge').send({ failure_stage: stage }));
    expect(res.status).toBe(400);
  });

  it('falls back to the ci default (not a 400) for an empty-string failure_stage, per `|| \'ci\'`', async () => {
    // `String(req.body?.failure_stage || 'ci')` treats '' as falsy, so it
    // silently becomes 'ci' rather than failing validation — documenting
    // this as current behavior rather than assuming '' is rejected.
    (bridgeFailureToSelfHealing as jest.Mock).mockResolvedValue({ ok: true });
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/executions/e1/bridge').send({ failure_stage: '' }));
    expect(res.status).toBe(200);
    expect(bridgeFailureToSelfHealing).toHaveBeenCalledWith(expect.objectContaining({ failure_stage: 'ci' }));
  });

  it.each(['ci', 'deploy', 'verification'])('accepts a valid failure_stage (%s)', async (stage) => {
    (bridgeFailureToSelfHealing as jest.Mock).mockResolvedValue({ ok: true });
    const res = await asAdmin(
      request(app).post('/api/v1/dev-autopilot/executions/e1/bridge').send({ failure_stage: stage, error: 'ci failed' }),
    );
    expect(res.status).toBe(200);
    expect(bridgeFailureToSelfHealing).toHaveBeenCalledWith(
      expect.objectContaining({ execution_id: 'e1', failure_stage: stage, error: 'ci failed' }),
    );
  });

  it('defaults failure_stage to ci when omitted', async () => {
    (bridgeFailureToSelfHealing as jest.Mock).mockResolvedValue({ ok: true });
    await asAdmin(request(app).post('/api/v1/dev-autopilot/executions/e1/bridge').send({}));
    expect(bridgeFailureToSelfHealing).toHaveBeenCalledWith(expect.objectContaining({ failure_stage: 'ci' }));
  });
});

// =============================================================================
// GET /executions/:id/lineage — parent-chain walk with cycle protection
// =============================================================================

describe('GET /executions/:id/lineage', () => {
  it('returns 404 when the execution id does not exist', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_executions') ? jsonRes(200, []) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/executions/missing/lineage'));
    expect(res.status).toBe(404);
  });

  it('walks up multiple parent hops to find the root, then returns the full lineage', async () => {
    const rows: Record<string, any> = {
      'exec-3': { id: 'exec-3', finding_id: 'f1', parent_execution_id: 'exec-2' },
      'exec-2': { id: 'exec-2', finding_id: 'f1', parent_execution_id: 'exec-1' },
      'exec-1': { id: 'exec-1', finding_id: 'f1', parent_execution_id: null },
    };
    setFetchRoutes([
      (url) => {
        if (url.includes('finding_id=eq.f1&order=created_at.asc')) {
          return jsonRes(200, Object.values(rows));
        }
        const m = url.match(/id=eq\.([^&]+)/);
        if (m && url.includes('/rest/v1/dev_autopilot_executions')) {
          const row = rows[m[1]];
          return jsonRes(200, row ? [row] : []);
        }
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/executions/exec-3/lineage'));
    expect(res.status).toBe(200);
    expect(res.body.root_id).toBe('exec-1');
    expect(res.body.lineage).toHaveLength(3);
  });

  it('does not infinite-loop on a cyclic parent chain (defensive visited-set check)', async () => {
    // Pathological/corrupt data: exec-a points to exec-b and vice-versa.
    const rows: Record<string, any> = {
      'exec-a': { id: 'exec-a', finding_id: 'f1', parent_execution_id: 'exec-b' },
      'exec-b': { id: 'exec-b', finding_id: 'f1', parent_execution_id: 'exec-a' },
    };
    setFetchRoutes([
      (url) => {
        if (url.includes('finding_id=eq.f1&order=created_at.asc')) return jsonRes(200, Object.values(rows));
        const m = url.match(/id=eq\.([^&]+)/);
        if (m && url.includes('/rest/v1/dev_autopilot_executions')) {
          const row = rows[m[1]];
          return jsonRes(200, row ? [row] : []);
        }
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/executions/exec-a/lineage'));
    // Must terminate (loop breaks via `visited` set) rather than hang the test.
    expect(res.status).toBe(200);
    expect(['exec-a', 'exec-b']).toContain(res.body.root_id);
  });
});

// =============================================================================
// GET /executions — status filter
// =============================================================================

describe('GET /executions', () => {
  it('defaults to the active-status clause', async () => {
    let seenUrl = '';
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/dev_autopilot_executions')) {
          seenUrl = url;
          return jsonRes(200, []);
        }
        return undefined;
      },
    ]);
    await asAdmin(request(app).get('/api/v1/dev-autopilot/executions'));
    expect(seenUrl).toContain('status=in.(cooling,running,ci,merging,deploying,verifying)');
  });

  it('omits the status clause entirely for ?status=all', async () => {
    let seenUrl = '';
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/dev_autopilot_executions')) {
          seenUrl = url;
          return jsonRes(200, []);
        }
        return undefined;
      },
    ]);
    await asAdmin(request(app).get('/api/v1/dev-autopilot/executions?status=all'));
    expect(seenUrl).not.toContain('status=');
  });

  it('applies an exact-status clause for any other status value', async () => {
    let seenUrl = '';
    setFetchRoutes([
      (url) => {
        if (url.includes('/rest/v1/dev_autopilot_executions')) {
          seenUrl = url;
          return jsonRes(200, []);
        }
        return undefined;
      },
    ]);
    await asAdmin(request(app).get('/api/v1/dev-autopilot/executions?status=failed'));
    expect(seenUrl).toContain('status=eq.failed');
  });
});

// =============================================================================
// GET /config, POST /config/kill-switch — the dev-autopilot kill switch is
// the closest analogue in this file to autopilot.ts's EXECUTION_DISARMED gate:
// it's the manual override that (dis)arms the auto-exec pipeline.
// =============================================================================

describe('GET /config', () => {
  it('returns 404 when the config row is missing', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_config') ? jsonRes(200, []) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/config'));
    expect(res.status).toBe(404);
  });

  it('returns the config row when present', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_config') ? jsonRes(200, [{ id: 1, kill_switch: false }]) : undefined)]);
    const res = await asAdmin(request(app).get('/api/v1/dev-autopilot/config'));
    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ id: 1, kill_switch: false });
  });
});

describe('POST /config/kill-switch', () => {
  it('arms the kill switch and emits an "activated" OASIS event', async () => {
    let patchedBody: any = null;
    setFetchRoutes([
      (url, opts) => {
        if (url.includes('/rest/v1/dev_autopilot_config')) {
          patchedBody = JSON.parse(opts.body);
          return jsonRes(200, {});
        }
        return undefined;
      },
    ]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/config/kill-switch').send({ armed: true }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, armed: true });
    expect(patchedBody.kill_switch).toBe(true);
    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dev_autopilot.kill_switch.activated', status: 'warning' }),
    );
  });

  it('disarms the kill switch and emits a "deactivated" OASIS event', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_config') ? jsonRes(200, {}) : undefined)]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/config/kill-switch').send({ armed: false }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, armed: false });
    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dev_autopilot.kill_switch.deactivated' }),
    );
  });

  it('treats a missing "armed" field as false (Boolean(undefined) === false)', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_config') ? jsonRes(200, {}) : undefined)]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/config/kill-switch').send({}));
    expect(res.status).toBe(200);
    expect(res.body.armed).toBe(false);
  });

  it('returns 500 and does not emit an event when the PATCH fails', async () => {
    setFetchRoutes([(url) => (url.includes('/rest/v1/dev_autopilot_config') ? jsonRes(500, {}) : undefined)]);
    const res = await asAdmin(request(app).post('/api/v1/dev-autopilot/config/kill-switch').send({ armed: true }));
    expect(res.status).toBe(500);
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });
});

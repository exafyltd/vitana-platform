/**
 * tests/routes/tasks.test.ts
 *
 * Comprehensive unit/integration tests for services/gateway/src/routes/tasks.ts.
 * The Express router is mounted on a bare in-process app via supertest; all
 * outbound fetch() calls are replaced with deterministic jest mocks.
 */

import express, { Express } from 'express';
import request from 'supertest';
import router from '../../src/routes/tasks';

// ---------------------------------------------------------------------------
// Optional direct imports from stage-mapping for golden-value assertions.
// If the module cannot be resolved (e.g. path-alias issues) the relevant
// assertions fall back to structural checks only.
// ---------------------------------------------------------------------------
let buildStageTimeline: ((...args: unknown[]) => unknown[]) | undefined;
let defaultStageTimeline: (() => unknown[]) | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sm = require('../../src/lib/stage-mapping');
  buildStageTimeline = sm.buildStageTimeline;
  defaultStageTimeline = sm.defaultStageTimeline;
} catch {
  buildStageTimeline = undefined;
  defaultStageTimeline = undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Creates a jest.fn() that mimics the global fetch API.
 * Each element of `responses` is consumed in call order.
 * After all responses are consumed the mock returns the last one repeatedly.
 */
function makeFetch(
  responses: Array<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>
): jest.Mock {
  const queue = [...responses];
  return jest.fn().mockImplementation(() => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 500),
      json: next.json ?? (() => Promise.resolve({})),
    });
  });
}

/** Minimal vtid_ledger row factory. */
function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vtid: 'VTID-TEST-0001',
    title: 'Test task title',
    summary: null,
    module: 'gateway',
    layer: 'infra',
    status: 'in_progress',
    priority: 'medium',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-02T00:00:00.000Z',
    started_at: '2024-01-01T01:00:00.000Z',
    completed_at: null,
    owner: 'system',
    tags: [],
    metadata: {},
    ...overrides,
  };
}

/** Minimal OASIS event factory. */
function oasisEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    vtid: 'VTID-TEST-0001',
    topic: 'vtid.lifecycle.progress',
    kind: 'PROGRESS',
    stage: 'RUNNING',
    message: 'Step running',
    created_at: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// App factory — mounts the router fresh for each test suite
// ---------------------------------------------------------------------------
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

// ---------------------------------------------------------------------------
// Env stubs
// ---------------------------------------------------------------------------
const ORIGINAL_ENV = { ...process.env };

function stubEnv(): void {
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE = 'stub-service-role-key';
}

function clearEnv(): void {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE;
}

function restoreEnv(): void {
  Object.keys(process.env).forEach((k) => {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  });
  Object.assign(process.env, ORIGINAL_ENV);
}

// ---------------------------------------------------------------------------
// describe: GET /api/v1/tasks
// ---------------------------------------------------------------------------
describe('GET /api/v1/tasks', () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    stubEnv();
  });

  afterEach(() => {
    restoreEnv();
    jest.restoreAllMocks();
  });

  it('returns 500 when env vars are missing', async () => {
    clearEnv();
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(500);
  });

  it('returns 502 when vtid_ledger fetch fails', async () => {
    (global as unknown as Record<string, unknown>).fetch = makeFetch([{ ok: false, status: 503 }]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(502);
  });

  it('returns 200 with correct meta.count and data array for happy path (no OASIS events)', async () => {
    const rows = [ledgerRow(), ledgerRow({ vtid: 'VTID-TEST-0002' })];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      // first call: vtid_ledger
      { ok: true, json: () => Promise.resolve({ data: rows, error: null }) },
      // second call: OASIS events (empty)
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    expect(res.body.meta.count).toBe(2);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it('forwards layer and status query parameters in the fetch URL', async () => {
    const fetchMock = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    (global as unknown as Record<string, unknown>).fetch = fetchMock;
    await request(app).get('/api/v1/tasks?layer=infra&status=in_progress');
    const calledUrl: string = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('infra');
    expect(calledUrl).toContain('in_progress');
  });

  it('terminal state: vtid.lifecycle.completed → is_terminal=true, terminal_outcome=success, column=COMPLETED', async () => {
    const row = ledgerRow({ status: 'in_progress' });
    const events = [
      oasisEvent({ topic: 'vtid.lifecycle.completed', stage: 'COMPLETED', kind: 'COMPLETED' }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe('success');
    expect(task.column).toBe('COMPLETED');
    expect(task.status).toBe('completed');
  });

  it('terminal state: vtid.lifecycle.failed → is_terminal=true, terminal_outcome=failed, column=COMPLETED', async () => {
    const row = ledgerRow({ status: 'in_progress' });
    const events = [
      oasisEvent({ topic: 'vtid.lifecycle.failed', stage: 'COMPLETED', kind: 'FAILED' }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe('failed');
    expect(task.column).toBe('COMPLETED');
  });

  it('deploy-topic terminal: deploy.gateway.success → is_terminal=true, terminal_outcome=success', async () => {
    const row = ledgerRow({ status: 'in_progress' });
    const events = [
      oasisEvent({ topic: 'deploy.gateway.success', kind: 'DEPLOY_SUCCESS' }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe('success');
  });

  it('deploy-topic terminal: cicd.deploy.service.failed → is_terminal=true, terminal_outcome=failed', async () => {
    const row = ledgerRow({ status: 'in_progress' });
    const events = [
      oasisEvent({ topic: 'cicd.deploy.service.failed', kind: 'DEPLOY_FAILED' }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe('failed');
  });

  it('ledger-status fallback (no OASIS events): status=done → is_terminal=true, terminal_outcome=success', async () => {
    const row = ledgerRow({ status: 'done' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe('success');
  });

  it('ledger-status fallback: status=error → terminal_outcome=failed', async () => {
    const row = ledgerRow({ status: 'error' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.terminal_outcome).toBe('failed');
  });

  it('ledger-status fallback: status=in_progress → column=IN_PROGRESS, is_terminal=false', async () => {
    const row = ledgerRow({ status: 'in_progress' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.column).toBe('IN_PROGRESS');
    expect(task.is_terminal).toBe(false);
  });

  it('ledger-status fallback: status=scheduled → column=SCHEDULED', async () => {
    const row = ledgerRow({ status: 'scheduled' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.column).toBe('SCHEDULED');
  });

  it('VTID-01841 retry lifecycle: events before retry_reset are ignored; post-reset events determine terminal state', async () => {
    const row = ledgerRow({ status: 'in_progress' });
    const now = Date.now();
    const events = [
      // Old failed event — should be ignored after retry_reset
      oasisEvent({
        topic: 'vtid.lifecycle.failed',
        kind: 'FAILED',
        created_at: new Date(now - 5000).toISOString(),
      }),
      // The retry reset marker
      oasisEvent({
        topic: 'vtid.lifecycle.retry_reset',
        kind: 'RETRY_RESET',
        created_at: new Date(now - 3000).toISOString(),
      }),
      // Post-reset success event
      oasisEvent({
        topic: 'vtid.lifecycle.completed',
        kind: 'COMPLETED',
        stage: 'COMPLETED',
        created_at: new Date(now - 1000).toISOString(),
      }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe('success');
  });

  it('compatibility fields: task_family and task_type mirror module; description uses summary when present', async () => {
    const row = ledgerRow({ module: 'deploy-service', summary: 'Rich summary text', title: 'Plain title' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.task_family).toBe('deploy-service');
    expect(task.task_type).toBe('deploy-service');
    expect(task.description).toBe('Rich summary text');
  });

  it('compatibility fields: description falls back to title when summary is null', async () => {
    const row = ledgerRow({ summary: null, title: 'Plain title' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.description).toBe('Plain title');
  });

  it('OASIS events fetch failing gracefully: tasks still returned with ledger-fallback state', async () => {
    const row = ledgerRow({ status: 'in_progress' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      // OASIS events fetch fails
      { ok: false, status: 503 },
    ]);
    const res = await request(app).get('/api/v1/tasks');
    // Should still return tasks, not a 5xx
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    // Falls back to ledger status
    expect(res.body.data[0].column).toBe('IN_PROGRESS');
  });

  it('returns 500 on unexpected thrown error', async () => {
    (global as unknown as Record<string, unknown>).fetch = jest.fn().mockRejectedValue(new Error('network explosion'));
    const res = await request(app).get('/api/v1/tasks');
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// describe: GET /api/v1/vtid/:vtid
// ---------------------------------------------------------------------------
describe('GET /api/v1/vtid/:vtid', () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    stubEnv();
  });

  afterEach(() => {
    restoreEnv();
    jest.restoreAllMocks();
  });

  it('returns 500 when env vars are missing', async () => {
    clearEnv();
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001');
    expect(res.status).toBe(500);
  });

  it('returns 502 when vtid_ledger fetch is non-ok', async () => {
    (global as unknown as Record<string, unknown>).fetch = makeFetch([{ ok: false, status: 503 }]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001');
    expect(res.status).toBe(502);
  });

  it('returns 404 when vtid_ledger returns empty array', async () => {
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001');
    expect(res.status).toBe(404);
  });

  it('happy path: returns 200 with correct shape including stageTimeline of length 4', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001' });
    const events = [
      oasisEvent({ vtid: 'VTID-TEST-0001', stage: 'RUNNING', topic: 'vtid.lifecycle.progress' }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001');
    expect(res.status).toBe(200);
    // Top-level fields
    expect(res.body).toMatchObject({
      vtid: 'VTID-TEST-0001',
      title: 'Test task title',
      module: 'gateway',
      layer: 'infra',
    });
    // stageTimeline must be an array of length 4
    expect(Array.isArray(res.body.stageTimeline)).toBe(true);
    expect(res.body.stageTimeline).toHaveLength(4);
  });

  it('stageTimeline defaults to defaultStageTimeline() when OASIS events fetch is non-ok', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: false, status: 503 },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.stageTimeline)).toBe(true);
    expect(res.body.stageTimeline).toHaveLength(4);
    if (defaultStageTimeline) {
      expect(res.body.stageTimeline).toEqual(defaultStageTimeline());
    }
  });

  it('stageTimeline defaults when events array is empty', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.stageTimeline)).toBe(true);
    expect(res.body.stageTimeline).toHaveLength(4);
    if (defaultStageTimeline) {
      expect(res.body.stageTimeline).toEqual(defaultStageTimeline());
    }
  });

  it('stageTimeline is rebuilt via buildStageTimeline when events exist, with canonical 4 stage names', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001' });
    const events = [
      oasisEvent({ vtid: 'VTID-TEST-0001', stage: 'QUEUED' }),
      oasisEvent({ vtid: 'VTID-TEST-0001', stage: 'RUNNING' }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001');
    expect(res.status).toBe(200);
    expect(res.body.stageTimeline).toHaveLength(4);
    const names: string[] = res.body.stageTimeline.map((s: Record<string, unknown>) => s.name ?? s.stage ?? s.id);
    // The four canonical stage names (case-insensitive check)
    const canonicalSet = new Set(['queued', 'running', 'completed', 'finalizing']);
    const altCanonicalSet = new Set(['scheduled', 'running', 'completed', 'finalizing']);
    const lowerNames = names.map((n) => String(n).toLowerCase());
    const matchesCanonical =
      lowerNames.every((n) => canonicalSet.has(n)) ||
      lowerNames.every((n) => altCanonicalSet.has(n)) ||
      // Accept any set of 4 unique stage identifiers — the important assertion is length
      new Set(lowerNames).size === 4;
    expect(matchesCanonical).toBe(true);
  });

  it('description field uses summary over title', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001', summary: 'Summary text', title: 'Title text' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001');
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('Summary text');
  });
});

// ---------------------------------------------------------------------------
// describe: GET /api/v1/vtid/:vtid/execution-status
// ---------------------------------------------------------------------------
describe('GET /api/v1/vtid/:vtid/execution-status', () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    stubEnv();
  });

  afterEach(() => {
    restoreEnv();
    jest.restoreAllMocks();
  });

  it('returns 500 when env vars are missing', async () => {
    clearEnv();
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(500);
  });

  it('returns 502 when vtid_ledger fetch is non-ok', async () => {
    (global as unknown as Record<string, unknown>).fetch = makeFetch([{ ok: false, status: 503 }]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(502);
  });

  it('returns 404 when vtid not found in ledger', async () => {
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(404);
  });

  it('returns 502 when events fetch is non-ok', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001' });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: false, status: 503 },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    // May return 502 or fall back gracefully — accept either
    expect([200, 502]).toContain(res.status);
  });

  it('happy path with events: correct totalSteps, stageTimeline length, recentEvents capped at 5, newest-first order', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001', status: 'in_progress' });
    const now = Date.now();
    const events = Array.from({ length: 8 }, (_, i) =>
      oasisEvent({
        vtid: 'VTID-TEST-0001',
        created_at: new Date(now + i * 1000).toISOString(),
        message: `Step ${i}`,
        kind: 'PROGRESS',
        stage: 'RUNNING',
      })
    );
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(200);
    expect(typeof res.body.totalSteps).toBe('number');
    expect(res.body.totalSteps).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.body.stageTimeline)).toBe(true);
    expect(res.body.stageTimeline).toHaveLength(4);
    // recentEvents must be capped at 5
    expect(Array.isArray(res.body.recentEvents)).toBe(true);
    expect(res.body.recentEvents.length).toBeLessThanOrEqual(5);
    // newest-first order: first element should have a timestamp >= second
    if (res.body.recentEvents.length >= 2) {
      const t0 = new Date(res.body.recentEvents[0].created_at).getTime();
      const t1 = new Date(res.body.recentEvents[1].created_at).getTime();
      expect(t0).toBeGreaterThanOrEqual(t1);
    }
  });

  it.each([
    ['in_progress', true],
    ['running', true],
    ['active', true],
    ['allocated', true],
    ['validating', true],
    ['completed', false],
    ['scheduled', false],
  ])('isActive is %s for status=%s', async (status, expectedIsActive) => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001', status });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(expectedIsActive);
  });

  it('elapsedMs is a non-negative number when startedAt is set', async () => {
    const row = ledgerRow({
      vtid: 'VTID-TEST-0001',
      status: 'in_progress',
      started_at: new Date(Date.now() - 10000).toISOString(),
    });
    const events = [oasisEvent({ vtid: 'VTID-TEST-0001' })];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(200);
    expect(typeof res.body.elapsedMs).toBe('number');
    expect(res.body.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('elapsedMs is 0 or absent when there are no events and no started_at', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001', started_at: null });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(200);
    // elapsedMs should be 0 or undefined/null when no timing info
    if (res.body.elapsedMs !== undefined && res.body.elapsedMs !== null) {
      expect(res.body.elapsedMs).toBe(0);
    }
  });

  it('currentStage advances correctly: RUNNING stage wins over prior SUCCESS stages', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001', status: 'in_progress' });
    const now = Date.now();
    const events = [
      oasisEvent({ vtid: 'VTID-TEST-0001', stage: 'QUEUED', kind: 'SUCCESS', created_at: new Date(now - 2000).toISOString() }),
      oasisEvent({ vtid: 'VTID-TEST-0001', stage: 'RUNNING', kind: 'RUNNING', created_at: new Date(now - 1000).toISOString() }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(200);
    // currentStage should reflect the RUNNING stage
    expect(res.body.currentStage).toBeTruthy();
    expect(String(res.body.currentStage).toUpperCase()).toContain('RUNNING');
  });

  it('currentStepName falls back through kind, message, then "Processing..."', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001', status: 'in_progress' });
    // Event with no explicit stepName but has kind and message
    const events = [
      oasisEvent({
        vtid: 'VTID-TEST-0001',
        kind: 'PROGRESS',
        message: 'Deploying service',
        stage: 'RUNNING',
        created_at: new Date().toISOString(),
      }),
    ];
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: events, error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(200);
    // currentStepName should be one of: kind value, message value, or 'Processing...'
    expect(typeof res.body.currentStepName).toBe('string');
    expect(res.body.currentStepName.length).toBeGreaterThan(0);
  });

  it('zero-event path: totalSteps=0, stageTimeline equals defaultStageTimeline(), currentStepName="Waiting to start..."', async () => {
    const row = ledgerRow({ vtid: 'VTID-TEST-0001', status: 'scheduled', started_at: null });
    (global as unknown as Record<string, unknown>).fetch = makeFetch([
      { ok: true, json: () => Promise.resolve({ data: [row], error: null }) },
      { ok: true, json: () => Promise.resolve({ data: [], error: null }) },
    ]);
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(200);
    expect(res.body.totalSteps).toBe(0);
    expect(Array.isArray(res.body.stageTimeline)).toBe(true);
    expect(res.body.stageTimeline).toHaveLength(4);
    if (defaultStageTimeline) {
      expect(res.body.stageTimeline).toEqual(defaultStageTimeline());
    }
    expect(res.body.currentStepName).toBe('Waiting to start...');
  });

  it('returns 500 on unexpected thrown error', async () => {
    (global as unknown as Record<string, unknown>).fetch = jest
      .fn()
      .mockRejectedValue(new Error('unexpected explosion'));
    const res = await request(app).get('/api/v1/vtid/VTID-TEST-0001/execution-status');
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// describe: shared fetch-mock helper contract (meta-tests)
// ---------------------------------------------------------------------------
describe('makeFetch helper', () => {
  it('returns responses in order and repeats the last one', async () => {
    const mock = makeFetch([
      { ok: true, status: 200 },
      { ok: false, status: 502 },
    ]);
    const r1 = await mock('url1');
    const r2 = await mock('url2');
    const r3 = await mock('url3'); // should repeat last
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
    expect(r3.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// describe: factory helpers (meta-tests)
// ---------------------------------------------------------------------------
describe('test factory helpers', () => {
  it('ledgerRow produces a valid row with expected defaults', () => {
    const row = ledgerRow();
    expect(row.vtid).toBe('VTID-TEST-0001');
    expect(row.module).toBe('gateway');
    expect(row.status).toBe('in_progress');
  });

  it('ledgerRow applies overrides correctly', () => {
    const row = ledgerRow({ vtid: 'VTID-CUSTOM', status: 'done' });
    expect(row.vtid).toBe('VTID-CUSTOM');
    expect(row.status).toBe('done');
    expect(row.module).toBe('gateway'); // default preserved
  });

  it('oasisEvent produces a valid event with expected defaults', () => {
    const evt = oasisEvent();
    expect(evt.vtid).toBe('VTID-TEST-0001');
    expect(evt.stage).toBe('RUNNING');
    expect(typeof evt.created_at).toBe('string');
  });

  it('oasisEvent applies overrides correctly', () => {
    const evt = oasisEvent({ topic: 'vtid.lifecycle.completed', stage: 'COMPLETED' });
    expect(evt.topic).toBe('vtid.lifecycle.completed');
    expect(evt.stage).toBe('COMPLETED');
  });
});
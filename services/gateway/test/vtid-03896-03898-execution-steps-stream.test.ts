/**
 * VTID-03896: per-execution step feed (`GET /executions/:id/steps`).
 * VTID-03897: SSE live tail of the same feed (`GET /executions/:id/stream`),
 *   including the query-param bearer-token fallback `requireDevRoleForStream`
 *   needs because the browser's native EventSource cannot set a custom
 *   Authorization header.
 * VTID-03898: `GET /executions` enriched with a batched `last_event_at` per
 *   row, so the Command Hub can show a heartbeat instead of only a status
 *   badge for a long-running execution.
 *
 * All three reuse the same underlying `oasis_events` topic filter
 * (`topic=ilike.dev_autopilot.*` + `metadata->>execution_id=eq./in.(...)`),
 * so they're covered together against a mocked `global.fetch` (dev-autopilot.ts
 * talks to PostgREST directly, not via the supabase-js client) and a mocked
 * `requireAuth` (same pattern as test/journey-checklist.test.ts).
 */

import request from 'supertest';
import express from 'express';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (h === 'Bearer admin') { req.identity = { user_id: 'admin-1', exafy_admin: true }; return next(); }
    if (h === 'Bearer user') { req.identity = { user_id: 'user-1', exafy_admin: false }; return next(); }
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  },
}));

const ORIGINAL_ENV = process.env;
const EXECUTION_ID = 'exec-aaaa-bbbb-cccc-111111111111';

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any;
}

function makeApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const devAutopilotRouter = require('../src/routes/dev-autopilot').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/dev-autopilot', devAutopilotRouter);
  return app;
}

describe('VTID-03896: GET /executions/:id/steps', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('401 without a token', async () => {
    const r = await request(makeApp()).get(`/api/v1/dev-autopilot/executions/${EXECUTION_ID}/steps`);
    expect(r.status).toBe(401);
  });

  it('403 for a non-admin token', async () => {
    const r = await request(makeApp())
      .get(`/api/v1/dev-autopilot/executions/${EXECUTION_ID}/steps`)
      .set('Authorization', 'Bearer user');
    expect(r.status).toBe(403);
  });

  it('200: returns oasis_events filtered by execution_id, oldest first', async () => {
    let capturedUrl = '';
    global.fetch = jest.fn(async (url: any) => {
      capturedUrl = String(url);
      return jsonRes(200, [
        { id: 'e1', created_at: '2026-09-15T10:00:00Z', topic: 'dev_autopilot.execution.approved', message: 'approved' },
        { id: 'e2', created_at: '2026-09-15T10:01:00Z', topic: 'dev_autopilot.execution.running', message: 'running' },
      ]);
    }) as any;

    const r = await request(makeApp())
      .get(`/api/v1/dev-autopilot/executions/${EXECUTION_ID}/steps`)
      .set('Authorization', 'Bearer admin');

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.execution_id).toBe(EXECUTION_ID);
    expect(r.body.steps).toHaveLength(2);
    expect(capturedUrl).toContain(`metadata->>execution_id=eq.${EXECUTION_ID}`);
    expect(capturedUrl).toContain('topic=ilike.dev_autopilot.*');
    expect(capturedUrl).toContain('order=created_at.asc');
  });

  it('500 with the PostgREST error when the query fails', async () => {
    global.fetch = jest.fn(async () => jsonRes(500, { message: 'boom' })) as any;
    const r = await request(makeApp())
      .get(`/api/v1/dev-autopilot/executions/${EXECUTION_ID}/steps`)
      .set('Authorization', 'Bearer admin');
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
  });
});

describe('VTID-03897: GET /executions/:id/stream', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('401 without a token (no Authorization header, no access_token query param)', async () => {
    const r = await request(makeApp()).get(`/api/v1/dev-autopilot/executions/${EXECUTION_ID}/stream`);
    expect(r.status).toBe(401);
  });

  it('accepts the bearer token via ?access_token= (EventSource cannot set headers)', async () => {
    // First (and only, since it's terminal) poll returns one event whose
    // topic is in EXECUTION_STREAM_TERMINAL_TOPICS, so the route emits
    // connected + step + terminal and ends the response in the same tick
    // pollSteps() is awaited in — no setInterval/heartbeat left pending for
    // the test to hang on.
    global.fetch = jest.fn(async () =>
      jsonRes(200, [
        { id: 'e1', created_at: '2026-09-15T10:00:00Z', topic: 'dev_autopilot.execution.completed', message: 'done' },
      ]),
    ) as any;

    const r = await request(makeApp())
      .get(`/api/v1/dev-autopilot/executions/${EXECUTION_ID}/stream?access_token=admin`)
      .buffer(true);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.text).toContain('event: connected');
    expect(r.text).toContain('event: step');
    expect(r.text).toContain('"topic":"dev_autopilot.execution.completed"');
    expect(r.text).toContain('event: terminal');
  });

  it('403 via the query-token fallback for a non-admin token', async () => {
    const r = await request(makeApp()).get(`/api/v1/dev-autopilot/executions/${EXECUTION_ID}/stream?access_token=user`);
    expect(r.status).toBe(403);
  });

  it('does not let a query access_token override an explicit Authorization header', async () => {
    // requireDevRoleForStream only fills in the header when one isn't
    // already present — an explicit header (the normal fetch()/XHR case)
    // must win over a stray query param.
    const r = await request(makeApp())
      .get(`/api/v1/dev-autopilot/executions/${EXECUTION_ID}/stream?access_token=admin`)
      .set('Authorization', 'Bearer user');
    expect(r.status).toBe(403);
  });

});

describe('VTID-03898: GET /executions last_event_at enrichment', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('merges the most recent oasis_events row per execution id into last_event_at', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/dev_autopilot_executions?')) {
        return jsonRes(200, [
          { id: 'exec-1', status: 'running' },
          { id: 'exec-2', status: 'cooling' },
        ]);
      }
      if (u.includes('/oasis_events?')) {
        return jsonRes(200, [
          // Newest first (order=created_at.desc) — first row per id wins.
          { created_at: '2026-09-15T12:00:00Z', metadata: { execution_id: 'exec-1' } },
          { created_at: '2026-09-15T11:00:00Z', metadata: { execution_id: 'exec-1' } },
          { created_at: '2026-09-15T09:30:00Z', metadata: { execution_id: 'exec-2' } },
        ]);
      }
      return jsonRes(200, []);
    }) as any;

    const r = await request(makeApp())
      .get('/api/v1/dev-autopilot/executions?status=all')
      .set('Authorization', 'Bearer admin');

    expect(r.status).toBe(200);
    const byId: Record<string, any> = {};
    for (const e of r.body.executions) byId[e.id] = e;
    expect(byId['exec-1'].last_event_at).toBe('2026-09-15T12:00:00Z');
    expect(byId['exec-2'].last_event_at).toBe('2026-09-15T09:30:00Z');

    const oasisCall = calls.find((c) => c.includes('/oasis_events?'));
    expect(oasisCall).toBeDefined();
    expect(oasisCall).toContain('metadata->>execution_id=in.(exec-1,exec-2)');
    expect(oasisCall).toContain('order=created_at.desc');
  });

  it('an execution with no matching oasis_events row gets last_event_at: null', async () => {
    global.fetch = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/dev_autopilot_executions?')) {
        return jsonRes(200, [{ id: 'exec-lonely', status: 'running' }]);
      }
      if (u.includes('/oasis_events?')) {
        return jsonRes(200, []);
      }
      return jsonRes(200, []);
    }) as any;

    const r = await request(makeApp())
      .get('/api/v1/dev-autopilot/executions?status=all')
      .set('Authorization', 'Bearer admin');

    expect(r.status).toBe(200);
    expect(r.body.executions[0].last_event_at).toBeNull();
  });

  it('an empty execution list never queries oasis_events at all', async () => {
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      calls.push(String(url));
      if (String(url).includes('/dev_autopilot_executions?')) return jsonRes(200, []);
      return jsonRes(200, []);
    }) as any;

    const r = await request(makeApp())
      .get('/api/v1/dev-autopilot/executions?status=all')
      .set('Authorization', 'Bearer admin');

    expect(r.status).toBe(200);
    expect(r.body.executions).toEqual([]);
    expect(calls.some((c) => c.includes('/oasis_events?'))).toBe(false);
  });

  it('a failed enrichment query still returns the executions list (never a 500)', async () => {
    global.fetch = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/dev_autopilot_executions?')) return jsonRes(200, [{ id: 'exec-1', status: 'running' }]);
      if (u.includes('/oasis_events?')) return jsonRes(500, { message: 'boom' });
      return jsonRes(200, []);
    }) as any;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await request(makeApp())
      .get('/api/v1/dev-autopilot/executions?status=all')
      .set('Authorization', 'Bearer admin');

    expect(r.status).toBe(200);
    expect(r.body.executions[0].last_event_at).toBeNull();
    warnSpy.mockRestore();
  });
});

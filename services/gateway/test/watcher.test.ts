/**
 * VTID-03460 — Watcher Phase 1 route tests: /api/v1/watcher/*
 *
 * Covers auth, happy path and error paths for all three endpoints. The auth
 * cases matter most here: /session-step is a WRITE path into the development
 * timeline, and a timeline anything can forge is worse than no timeline —
 * Phase 2 distils lessons from these rows and Phase 3 injects them into
 * prompts, so a forged step becomes a reminder the whole pipeline trusts.
 */

import express from 'express';
import request from 'supertest';

const mockGetSupabase = jest.fn();
const mockWriteSteps = jest.fn();
const mockObserverTick = jest.fn();

jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

// requireAdminAuth is exercised for real in its own suite; here we only need
// a controllable gate so the route's own behaviour is what's under test.
let adminAllowed = true;
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (adminAllowed) return next();
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  },
}));

jest.mock('../src/services/watcher/watcher-observer', () => ({
  OBSERVER_TICK_MS: 60000,
  OVERLAP_MS: 300000,
  isObserverRunning: () => true,
  observerTick: (...args: unknown[]) => mockObserverTick(...args),
  writeSteps: (...args: unknown[]) => mockWriteSteps(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const watcherRouter = require('../src/routes/watcher').default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/watcher', watcherRouter);
  return app;
}

/** Minimal chainable stand-in for the supabase query builder. */
function stubSupabase(result: {
  data?: unknown;
  error?: { message: string } | null;
  /** For head+count queries, e.g. /health's watcher_lessons totals. */
  count?: number;
}) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gt', 'order', 'limit']) {
    chain[m] = jest.fn(() => chain);
  }
  // Awaiting the chain resolves to the result.
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? [], error: result.error ?? null, count: result.count ?? 0 });
  return { from: jest.fn(() => chain), __chain: chain };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  adminAllowed = true;
  process.env = { ...ORIGINAL_ENV };
  delete process.env.WATCHER_SESSION_TOKEN;
  delete process.env.WATCHER_OBSERVER_ENABLED;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('GET /api/v1/watcher/timeline', () => {
  it('401s when the admin gate rejects', async () => {
    adminAllowed = false;
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [] }));
    const res = await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01');
    expect(res.status).toBe(401);
  });

  it('400s when neither selector is supplied', async () => {
    const res = await request(buildApp()).get('/api/v1/watcher/timeline');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_SELECTOR');
  });

  it('400s when a selector is present but blank', async () => {
    const res = await request(buildApp()).get('/api/v1/watcher/timeline?vtid=%20%20');
    expect(res.status).toBe(400);
  });

  it('503s when Supabase is unavailable', async () => {
    mockGetSupabase.mockReturnValue(null);
    const res = await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('SUPABASE_UNAVAILABLE');
  });

  it('returns steps for a vtid selector', async () => {
    const rows = [{ id: 's1', step: 'ci', outcome: 'success' }];
    const sb = stubSupabase({ data: rows });
    mockGetSupabase.mockReturnValue(sb);

    const res = await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.selector).toEqual({ vtid: 'VTID-01' });
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.steps).toEqual(rows);
    expect(sb.from).toHaveBeenCalledWith('watcher_steps');
    expect(sb.__chain.eq).toHaveBeenCalledWith('vtid', 'VTID-01');
  });

  it('selects on work_unit_id when given instead of vtid', async () => {
    const sb = stubSupabase({ data: [] });
    mockGetSupabase.mockReturnValue(sb);
    const res = await request(buildApp()).get('/api/v1/watcher/timeline?work_unit_id=exec-9');
    expect(res.status).toBe(200);
    expect(sb.__chain.eq).toHaveBeenCalledWith('work_unit_id', 'exec-9');
  });

  it('reads a timeline forwards, not newest-first', async () => {
    // A timeline read in reverse is actively misleading — it inverts cause
    // and effect for whoever is reconstructing what happened.
    const sb = stubSupabase({ data: [] });
    mockGetSupabase.mockReturnValue(sb);
    await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01');
    expect(sb.__chain.order).toHaveBeenCalledWith('observed_at', { ascending: true });
  });

  it('flags truncation instead of silently capping', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ id: `s${i}` }));
    mockGetSupabase.mockReturnValue(stubSupabase({ data: rows }));
    const res = await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01&limit=2');
    expect(res.body.data.truncated).toBe(true);
  });

  it('does not flag truncation on a partial page', async () => {
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [{ id: 's0' }] }));
    const res = await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01&limit=50');
    expect(res.body.data.truncated).toBe(false);
  });

  it('clamps an absurd limit rather than letting it through', async () => {
    const sb = stubSupabase({ data: [] });
    mockGetSupabase.mockReturnValue(sb);
    await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01&limit=99999');
    expect(sb.__chain.limit).toHaveBeenCalledWith(500);
  });

  it('falls back to the default limit on a non-numeric value', async () => {
    const sb = stubSupabase({ data: [] });
    mockGetSupabase.mockReturnValue(sb);
    await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01&limit=abc');
    expect(sb.__chain.limit).toHaveBeenCalledWith(100);
  });

  it('500s and surfaces the detail when the query fails', async () => {
    mockGetSupabase.mockReturnValue(stubSupabase({ error: { message: 'relation missing' } }));
    const res = await request(buildApp()).get('/api/v1/watcher/timeline?vtid=VTID-01');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('QUERY_FAILED');
    expect(res.body.detail).toBe('relation missing');
  });
});

describe('GET /api/v1/watcher/health', () => {
  it('401s when the admin gate rejects', async () => {
    adminAllowed = false;
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [] }));
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.status).toBe(401);
  });

  it('reports enabled_resolved=true when the var is absent', async () => {
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [] }));
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.status).toBe(200);
    expect(res.body.data.observer.env_var_present).toBe(false);
    expect(res.body.data.observer.enabled_resolved).toBe(true);
  });

  /**
   * BOOTSTRAP-ORB-FASTSTART-DRIFT in miniature: the raw var and the resolved
   * value are reported side by side precisely because "the var is set" does
   * not mean "the feature is on". Two stacks must be diffable, not guessed at.
   */
  it('reports the raw var and the resolved value separately', async () => {
    process.env.WATCHER_OBSERVER_ENABLED = 'false';
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [] }));
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.body.data.observer.env_var_present).toBe(true);
    expect(res.body.data.observer.env_var_value).toBe('false');
    expect(res.body.data.observer.enabled_resolved).toBe(false);
  });

  it('surfaces per-source cursor state', async () => {
    const sources = [{ source: 'oasis_events', cursor_at: 'x', last_error: null, last_written: 3 }];
    mockGetSupabase.mockReturnValue(stubSupabase({ data: sources }));
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.body.data.sources).toEqual(sources);
  });

  it('reports learned-lesson counts alongside cursor health (VTID-03531)', async () => {
    // "The observer is healthy" and "the Watcher is learning" are independent
    // facts, and for three days they diverged completely — 591 steps recorded
    // against 0 lessons, because the distiller had no call site. Cursor state
    // alone could not show that, so /health has to report both.
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [], count: 7 }));
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.body.data.lessons).toEqual({ total: 7, injectable: 7 });
  });

  it('reports zeroed lesson counts rather than omitting them when nothing is learned', async () => {
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [], count: 0 }));
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    // An absent field reads as "not measured"; an explicit 0 reads as
    // "measured, and it is zero" — which is the alarming case.
    expect(res.body.data.lessons).toEqual({ total: 0, injectable: 0 });
  });

  it('reports state_error instead of failing when the cursor table errors', async () => {
    mockGetSupabase.mockReturnValue(stubSupabase({ error: { message: 'no such table' } }));
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.status).toBe(200);
    expect(res.body.data.state_error).toBe('no such table');
  });

  it('stays 200 with supabase_available=false when Supabase is missing', async () => {
    mockGetSupabase.mockReturnValue(null);
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.status).toBe(200);
    expect(res.body.data.supabase_available).toBe(false);
  });

  it('reports whether session ingestion is configured', async () => {
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [] }));
    let res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.body.data.session_ingest_configured).toBe(false);

    process.env.WATCHER_SESSION_TOKEN = 'abc';
    res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(res.body.data.session_ingest_configured).toBe(true);
  });

  it('does not tick unless explicitly asked', async () => {
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [] }));
    const res = await request(buildApp()).get('/api/v1/watcher/health');
    expect(mockObserverTick).not.toHaveBeenCalled();
    expect(res.body.data.forced_tick).toBeNull();
  });

  it('forces a scan on ?tick=true', async () => {
    mockGetSupabase.mockReturnValue(stubSupabase({ data: [] }));
    mockObserverTick.mockResolvedValue([{ source: 'oasis_events', scanned: 2, written: 1 }]);
    const res = await request(buildApp()).get('/api/v1/watcher/health?tick=true');
    expect(mockObserverTick).toHaveBeenCalledTimes(1);
    expect(res.body.data.forced_tick).toEqual([{ source: 'oasis_events', scanned: 2, written: 1 }]);
  });
});

describe('POST /api/v1/watcher/session-step — auth', () => {
  const validBody = { session_id: 'sess-1', step: 'doc_updated' };

  it('is CLOSED, not open, when no token is configured', async () => {
    // The critical case. An unset secret must not mean "anyone may write".
    const res = await request(buildApp()).post('/api/v1/watcher/session-step').send(validBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('SESSION_INGEST_DISABLED');
    expect(mockWriteSteps).not.toHaveBeenCalled();
  });

  it('401s with no Authorization header', async () => {
    process.env.WATCHER_SESSION_TOKEN = 'secret-token';
    const res = await request(buildApp()).post('/api/v1/watcher/session-step').send(validBody);
    expect(res.status).toBe(401);
    expect(mockWriteSteps).not.toHaveBeenCalled();
  });

  it('401s on a wrong token of the same length', async () => {
    process.env.WATCHER_SESSION_TOKEN = 'secret-token';
    const res = await request(buildApp())
      .post('/api/v1/watcher/session-step')
      .set('Authorization', 'Bearer secret-tokeX')
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it('401s on a token that is a prefix of the real one', async () => {
    process.env.WATCHER_SESSION_TOKEN = 'secret-token';
    const res = await request(buildApp())
      .post('/api/v1/watcher/session-step')
      .set('Authorization', 'Bearer secret')
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it('401s on a non-Bearer scheme', async () => {
    process.env.WATCHER_SESSION_TOKEN = 'secret-token';
    const res = await request(buildApp())
      .post('/api/v1/watcher/session-step')
      .set('Authorization', 'Basic secret-token')
      .send(validBody);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/watcher/session-step — validation and write', () => {
  beforeEach(() => {
    process.env.WATCHER_SESSION_TOKEN = 'secret-token';
    mockWriteSteps.mockResolvedValue({ ok: true, written: 1 });
  });

  const auth = (r: request.Test) => r.set('Authorization', 'Bearer secret-token');

  it('400s without a session_id', async () => {
    const res = await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({ step: 'doc_updated' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_SESSION_ID');
  });

  it('400s on an unknown step rather than writing an unconstrained row', async () => {
    // The DB CHECK would reject it anyway, but a 400 names the problem where
    // the caller can see it instead of failing inside a batch insert.
    const res = await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({ session_id: 's1', step: 'nonsense' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_STEP');
    expect(mockWriteSteps).not.toHaveBeenCalled();
  });

  it('400s on an unparseable observed_at', async () => {
    const res = await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({ session_id: 's1', step: 'doc_updated', observed_at: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_OBSERVED_AT');
  });

  it('writes a well-formed step', async () => {
    const res = await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({
        session_id: 'sess-1',
        step: 'doc_updated',
        outcome: 'success',
        vtid: 'VTID-03460',
        evidence: { files: ['CLAUDE.md'] },
        observed_at: '2026-07-31T12:00:00.000Z',
      });

    expect(res.status).toBe(200);
    expect(mockWriteSteps).toHaveBeenCalledTimes(1);
    expect(mockWriteSteps.mock.calls[0][0][0]).toMatchObject({
      work_unit_kind: 'session',
      work_unit_id: 'sess-1',
      vtid: 'VTID-03460',
      step: 'doc_updated',
      outcome: 'success',
      actor: 'claude-session',
      source: 'session_api',
      source_ref: 'sess-1:doc_updated',
      observed_at: '2026-07-31T12:00:00.000Z',
    });
  });

  it('defaults outcome to unknown rather than assuming success', async () => {
    await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({ session_id: 's1', step: 'running', outcome: 'bogus' });
    expect(mockWriteSteps.mock.calls[0][0][0].outcome).toBe('unknown');
  });

  it('treats a blank vtid as absent', async () => {
    await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({ session_id: 's1', step: 'running', vtid: '   ' });
    expect(mockWriteSteps.mock.calls[0][0][0].vtid).toBeNull();
  });

  it('uses a caller-supplied ref so one session can log a step more than once', async () => {
    await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({ session_id: 's1', step: 'doc_updated', ref: 'second-doc' });
    expect(mockWriteSteps.mock.calls[0][0][0].source_ref).toBe('s1:second-doc');
  });

  it('reports a deduplicated retry as success, not failure', async () => {
    // A hook that fires twice is normal. Surfacing that as an error would
    // train callers to retry harder, which is exactly backwards.
    mockWriteSteps.mockResolvedValue({ ok: true, written: 0 });
    const res = await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({ session_id: 's1', step: 'doc_updated' });
    expect(res.status).toBe(200);
    expect(res.body.data.deduplicated).toBe(true);
  });

  it('coerces a non-object evidence payload to an empty object', async () => {
    await auth(request(buildApp()).post('/api/v1/watcher/session-step'))
      .send({ session_id: 's1', step: 'running', evidence: 'oops' });
    expect(mockWriteSteps.mock.calls[0][0][0].evidence).toEqual({});
  });
});

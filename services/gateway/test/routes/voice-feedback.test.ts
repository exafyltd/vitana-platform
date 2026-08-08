/**
 * Tests for src/routes/voice-feedback.ts
 *
 *   POST /submit                       — any bearer token + valid Supabase user
 *   GET  /reports                      — any bearer token + valid Supabase user
 *   GET  /reports/:id                  — any bearer token + valid Supabase user
 *   POST /reports/:id/approve          — gated by requireAdminAuth (real JWT
 *   POST /reports/:id/reject             verification + exafy_admin claim
 *                                         check). Previously these two routes
 *                                         only checked for *presence* of a
 *                                         bearer token — a real authz bypass,
 *                                         fixed to use the codebase's
 *                                         canonical admin middleware.
 *   GET  /health                       — no auth
 *
 * /submit, /reports, /reports/:id remain on the bespoke getBearerToken +
 * per-request Supabase client pattern (RLS-scoped via the user's own JWT) —
 * a separate, lower-severity observation, not part of this fix.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: jest.fn((req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Missing or invalid Authorization header. Expected: Bearer <token>',
      });
    }
    if (authHeader.slice(7) === 'non-admin-tok') {
      return res.status(403).json({
        ok: false,
        error: 'FORBIDDEN',
        message: 'This endpoint requires exafy_admin privileges',
      });
    }
    req.identity = {
      user_id: 'admin-1',
      email: 'admin@test.com',
      tenant_id: null,
      exafy_admin: true,
      role: 'admin',
      aud: null,
      exp: null,
      iat: null,
    };
    next();
  }),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    range: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    then: jest.fn((resolve: (v: any) => any) => {
      const value = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      return Promise.resolve(value).then(resolve);
    }),
    mockResolvedValue(v: any) {
      defaultData = v;
      return chain;
    },
    mockResolvedValueOnce(v: any) {
      responseQueue.push(v);
      return chain;
    },
    mockReset() {
      responseQueue.length = 0;
      defaultData = { data: null, error: null };
    },
  };

  return chain;
};

const tableChains: Record<string, ReturnType<typeof createChain>> = {};
const chainFor = (table: string) => (tableChains[table] ??= createChain());

const mockGetUser = jest.fn();

const mockCreateClient = jest.fn(() => ({
  auth: { getUser: mockGetUser },
  from: jest.fn((table: string) => chainFor(table)),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

import router from '../../src/routes/voice-feedback';

const app = express();
app.use(express.json());
app.use('/api/v1/voice-feedback', router);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key-mock';
  for (const chain of Object.values(tableChains)) chain.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
});

// ---------------------------------------------------------------------------
// POST /submit
// ---------------------------------------------------------------------------
describe('POST /api/v1/voice-feedback/submit', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await request(app).post('/api/v1/voice-feedback/submit').send({ transcript: 'bug here' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 when transcript is missing', async () => {
    const res = await request(app)
      .post('/api/v1/voice-feedback/submit')
      .set('Authorization', 'Bearer tok')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when an attachment is not a valid URL', async () => {
    const res = await request(app)
      .post('/api/v1/voice-feedback/submit')
      .set('Authorization', 'Bearer tok')
      .send({ transcript: 'bug', attachments: ['not-a-url'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when more than 10 attachments are supplied', async () => {
    const attachments = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.png`);
    const res = await request(app)
      .post('/api/v1/voice-feedback/submit')
      .set('Authorization', 'Bearer tok')
      .send({ transcript: 'bug', attachments });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 503 when SUPABASE_ANON_KEY is not configured', async () => {
    delete process.env.SUPABASE_ANON_KEY;
    const res = await request(app)
      .post('/api/v1/voice-feedback/submit')
      .set('Authorization', 'Bearer tok')
      .send({ transcript: 'bug' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('GATEWAY_MISCONFIGURED');
  });

  it('returns 401 when the token does not resolve to a user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad token' } });
    const res = await request(app)
      .post('/api/v1/voice-feedback/submit')
      .set('Authorization', 'Bearer bad')
      .send({ transcript: 'bug' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('returns 500 when the insert fails', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: null, error: { message: 'insert failed' } });
    const res = await request(app)
      .post('/api/v1/voice-feedback/submit')
      .set('Authorization', 'Bearer tok')
      .send({ transcript: 'bug' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INSERT_FAILED');
  });

  it('inserts with defaults and returns 201 on success', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({
      data: { id: 'report-1', created_at: '2026-07-01T00:00:00Z' },
      error: null,
    });

    const res = await request(app)
      .post('/api/v1/voice-feedback/submit')
      .set('Authorization', 'Bearer tok')
      .send({ transcript: 'Voice cut out mid-sentence' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, report_id: 'report-1', created_at: '2026-07-01T00:00:00Z' });
    expect(chainFor('user_feedback_reports').insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        transcript: 'Voice cut out mid-sentence',
        report_type: 'bug_report',
        severity: 'medium',
        affected_screen: null,
        attachments: [],
      }),
    );
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'voice.feedback.submitted',
        payload: expect.objectContaining({ report_id: 'report-1', user_id: 'user-1' }),
      }),
    );
  });

  it('accepts explicit report_type/severity/affected_screen overrides', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({
      data: { id: 'report-2', created_at: '2026-07-01T00:00:00Z' },
      error: null,
    });

    const res = await request(app)
      .post('/api/v1/voice-feedback/submit')
      .set('Authorization', 'Bearer tok')
      .send({
        transcript: 'The Providers screen is confusing',
        report_type: 'ux_improvement',
        severity: 'critical',
        affected_screen: 'Providers & Voice',
      });

    expect(res.status).toBe(201);
    expect(chainFor('user_feedback_reports').insert).toHaveBeenCalledWith(
      expect.objectContaining({ report_type: 'ux_improvement', severity: 'critical', affected_screen: 'Providers & Voice' }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /reports
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice-feedback/reports', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await request(app).get('/api/v1/voice-feedback/reports');
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid status filter', async () => {
    const res = await request(app)
      .get('/api/v1/voice-feedback/reports?status=not_a_status')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when limit is out of range', async () => {
    const res = await request(app)
      .get('/api/v1/voice-feedback/reports?limit=0')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
  });

  it('returns 500 when the query fails', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: null, error: { message: 'query failed' } });
    const res = await request(app).get('/api/v1/voice-feedback/reports').set('Authorization', 'Bearer tok');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('QUERY_FAILED');
  });

  it('applies default pagination and returns the list', async () => {
    const rows = [{ id: 'r1' }, { id: 'r2' }];
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app).get('/api/v1/voice-feedback/reports').set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, reports: rows, count: 2 });
    expect(chainFor('user_feedback_reports').range).toHaveBeenCalledWith(0, 19);
  });

  it('filters by status when provided', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: [], error: null });
    await request(app)
      .get('/api/v1/voice-feedback/reports?status=in_progress&limit=5&offset=10')
      .set('Authorization', 'Bearer tok');
    expect(chainFor('user_feedback_reports').eq).toHaveBeenCalledWith('status', 'in_progress');
    expect(chainFor('user_feedback_reports').range).toHaveBeenCalledWith(10, 14);
  });
});

// ---------------------------------------------------------------------------
// GET /reports/:id
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice-feedback/reports/:id', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await request(app).get('/api/v1/voice-feedback/reports/r1');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the report is not found', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: null, error: { message: 'no rows' } });
    const res = await request(app).get('/api/v1/voice-feedback/reports/missing').set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns the report on success', async () => {
    const report = { id: 'r1', transcript: 'hi' };
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: report, error: null });
    const res = await request(app).get('/api/v1/voice-feedback/reports/r1').set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, report });
    expect(chainFor('user_feedback_reports').eq).toHaveBeenCalledWith('id', 'r1');
  });
});

// ---------------------------------------------------------------------------
// POST /reports/:id/approve
// ---------------------------------------------------------------------------
describe('POST /api/v1/voice-feedback/reports/:id/approve', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await request(app).post('/api/v1/voice-feedback/reports/r1/approve');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not exafy_admin', async () => {
    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/approve')
      .set('Authorization', 'Bearer non-admin-tok');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 503 when the service-role client is unavailable', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE;
    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/approve')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(503);
  });

  it('returns 404 when the report does not exist', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: null, error: { message: 'nf' } });
    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/missing/approve')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 409 when the report was already processed', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({
      data: { id: 'r1', status: 'fixed', report_type: 'bug_report', transcript: 't', severity: 'low', attachments: [] },
      error: null,
    });
    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/approve')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_PROCESSED');
    expect(res.body.status).toBe('fixed');
  });

  it('allocates VTID-01300 when the ledger has no existing rows, creates the task, and updates the report', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({
      data: {
        id: 'r1',
        status: 'received',
        report_type: 'bug_report',
        transcript: 'Wake word did not trigger twice in a row',
        severity: 'high',
        affected_screen: 'ORB',
        attachments: [],
      },
      error: null,
    });
    chainFor('vtid_ledger').mockResolvedValueOnce({ data: null, error: null }); // max vtid lookup: none found
    chainFor('vtid_ledger').mockResolvedValueOnce({ data: null, error: null }); // insert

    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/approve')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vtid).toBe('VTID-01300');
    expect(chainFor('vtid_ledger').insert).toHaveBeenCalledWith(
      expect.objectContaining({
        vtid: 'VTID-01300',
        status: 'pending',
        spec_status: 'draft',
        is_terminal: false,
        target_role: 'DEV',
        task_family: 'DEV',
        source: 'voice-feedback',
        header: expect.stringContaining('[Bug]'),
      }),
    );
    expect(chainFor('user_feedback_reports').update).toHaveBeenCalledWith({ status: 'in_progress', vtid: 'VTID-01300' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'voice.feedback.approved', payload: expect.objectContaining({ vtid: 'VTID-01300' }) }),
    );
  });

  it('increments off the highest existing VTID number', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({
      data: { id: 'r1', status: 'under_review', report_type: 'ux_improvement', transcript: 'UX', severity: 'low', attachments: [] },
      error: null,
    });
    chainFor('vtid_ledger').mockResolvedValueOnce({ data: { vtid: 'VTID-01345' }, error: null });
    chainFor('vtid_ledger').mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/approve')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.vtid).toBe('VTID-01346');
    expect(res.body.task_header).toContain('[UX]');
  });

  it('returns 500 when the ledger insert fails', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({
      data: { id: 'r1', status: 'received', report_type: 'bug_report', transcript: 't', severity: 'low', attachments: [] },
      error: null,
    });
    chainFor('vtid_ledger').mockResolvedValueOnce({ data: null, error: null });
    chainFor('vtid_ledger').mockResolvedValueOnce({ data: null, error: { message: 'ledger insert failed' } });

    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/approve')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('TASK_CREATION_FAILED');
  });
});

// ---------------------------------------------------------------------------
// POST /reports/:id/reject
// ---------------------------------------------------------------------------
describe('POST /api/v1/voice-feedback/reports/:id/reject', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await request(app).post('/api/v1/voice-feedback/reports/r1/reject').send({ reason: 'dup' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not exafy_admin', async () => {
    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/reject')
      .set('Authorization', 'Bearer non-admin-tok')
      .send({ reason: 'dup' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 400 when reason is missing', async () => {
    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/reject')
      .set('Authorization', 'Bearer tok')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 503 when the service-role client is unavailable', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE;
    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/reject')
      .set('Authorization', 'Bearer tok')
      .send({ reason: 'dup' });
    expect(res.status).toBe(503);
  });

  it('returns 404 when the report does not exist', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: null, error: { message: 'nf' } });
    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/missing/reject')
      .set('Authorization', 'Bearer tok')
      .send({ reason: 'dup' });
    expect(res.status).toBe(404);
  });

  it('marks the report wont_fix with the admin reason', async () => {
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: { id: 'r1', status: 'received' }, error: null });
    chainFor('user_feedback_reports').mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .post('/api/v1/voice-feedback/reports/r1/reject')
      .set('Authorization', 'Bearer tok')
      .send({ reason: 'Cannot reproduce' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'wont_fix' });
    expect(chainFor('user_feedback_reports').update).toHaveBeenCalledWith({
      status: 'wont_fix',
      admin_notes: 'Cannot reproduce',
    });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'voice.feedback.rejected' }));
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice-feedback/health', () => {
  it('returns ok without auth', async () => {
    const res = await request(app).get('/api/v1/voice-feedback/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('voice-feedback');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

/**
 * Tests for src/routes/voice-wake-timeline.ts (VTID-02917/02919/02927)
 *
 *   GET  /api/v1/voice/wake-timeline          — requireAuthWithTenant + requireExafyAdmin
 *   GET  /api/v1/voice/wake-timeline/recent   — requireAuthWithTenant + requireExafyAdmin
 *   POST /api/v1/voice/wake-timeline/event    — optionalAuth (anonymous-safe by design)
 *   GET  /api/v1/voice/wake-timeline/analysis — requireAuthWithTenant + requireExafyAdmin
 *
 * Auth here is global exafy_admin, not tenant-admin — userId/tenantId are
 * free-form query filters an admin may point at any tenant by design
 * ("crosses tenant boundaries" per the route's own doc comment), so there
 * is no per-tenant isolation check to assert (unlike tenant-admin/* routes).
 *
 * timeline-events.ts (isWakeTimelineEventName) is exercised for real since
 * it's a small pure validator central to the ingest endpoint's behavior;
 * the recorder and cohort-analysis services are mocked.
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockIdentity: { user_id: string; exafy_admin: boolean } | null = null;

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: jest.fn((req: any, res: any, next: any) => {
    if (!mockIdentity) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    req.identity = mockIdentity;
    next();
  }),
  requireExafyAdmin: jest.fn((req: any, res: any, next: any) => {
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    next();
  }),
  optionalAuth: jest.fn((req: any, _res: any, next: any) => {
    if (mockIdentity) req.identity = mockIdentity;
    next();
  }),
}));

const mockGetTimeline = jest.fn();
const mockListRecent = jest.fn();
const mockRecordEvent = jest.fn();
jest.mock('../../src/services/wake-timeline/wake-timeline-recorder', () => ({
  defaultWakeTimelineRecorder: {
    getTimeline: (...args: unknown[]) => mockGetTimeline(...args),
    listRecent: (...args: unknown[]) => mockListRecent(...args),
    recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
  },
}));

const mockAnalyzeReliabilityCohort = jest.fn();
jest.mock('../../src/services/wake-timeline/reliability-cohort-analysis', () => ({
  analyzeReliabilityCohort: (...args: unknown[]) => mockAnalyzeReliabilityCohort(...args),
}));

import router from '../../src/routes/voice-wake-timeline';

const app = express();
app.use(express.json());
app.use('/api/v1', router);

const ADMIN_IDENTITY = { user_id: 'admin-1', exafy_admin: true };
const NON_ADMIN_IDENTITY = { user_id: 'user-1', exafy_admin: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity = null;
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/wake-timeline
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/wake-timeline', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/v1/voice/wake-timeline?sessionId=s1');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin caller', async () => {
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).get('/api/v1/voice/wake-timeline?sessionId=s1');
    expect(res.status).toBe(403);
    expect(mockGetTimeline).not.toHaveBeenCalled();
  });

  it('returns 400 when sessionId is missing', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).get('/api/v1/voice/wake-timeline');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sessionId is required');
  });

  it('returns 404 when the timeline is not found', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockGetTimeline.mockResolvedValue(null);
    const res = await request(app).get('/api/v1/voice/wake-timeline?sessionId=missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('wake_timeline_not_found');
  });

  it('returns the timeline row on success', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const row = { session_id: 's1', events: [], aggregates: null };
    mockGetTimeline.mockResolvedValue(row);
    const res = await request(app).get('/api/v1/voice/wake-timeline?sessionId=s1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, vtid: 'VTID-02917', timeline: row });
    expect(mockGetTimeline).toHaveBeenCalledWith('s1');
  });

  it('returns 500 when the recorder throws', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockGetTimeline.mockRejectedValue(new Error('recorder down'));
    const res = await request(app).get('/api/v1/voice/wake-timeline?sessionId=s1');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('recorder down');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/wake-timeline/recent
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/wake-timeline/recent', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/v1/voice/wake-timeline/recent');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin caller', async () => {
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).get('/api/v1/voice/wake-timeline/recent');
    expect(res.status).toBe(403);
  });

  it('defaults limit to 20 and forwards userId/tenantId filters', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockListRecent.mockResolvedValue([]);
    await request(app).get('/api/v1/voice/wake-timeline/recent?userId=u1&tenantId=t1');
    expect(mockListRecent).toHaveBeenCalledWith({ userId: 'u1', tenantId: 't1', limit: 20 });
  });

  it('clamps limit above 100 down to 100', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockListRecent.mockResolvedValue([]);
    await request(app).get('/api/v1/voice/wake-timeline/recent?limit=500');
    expect(mockListRecent).toHaveBeenCalledWith({ userId: undefined, tenantId: undefined, limit: 100 });
  });

  it('falls back to the default 20 when limit is not a valid number', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockListRecent.mockResolvedValue([]);
    await request(app).get('/api/v1/voice/wake-timeline/recent?limit=notanumber');
    expect(mockListRecent).toHaveBeenCalledWith({ userId: undefined, tenantId: undefined, limit: 20 });
  });

  it('returns the timelines list on success', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const rows = [{ session_id: 's1' }, { session_id: 's2' }];
    mockListRecent.mockResolvedValue(rows);
    const res = await request(app).get('/api/v1/voice/wake-timeline/recent');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, vtid: 'VTID-02917', timelines: rows });
  });

  it('returns 500 when the recorder throws', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockListRecent.mockRejectedValue(new Error('list failed'));
    const res = await request(app).get('/api/v1/voice/wake-timeline/recent');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('list failed');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/voice/wake-timeline/event
// ---------------------------------------------------------------------------
describe('POST /api/v1/voice/wake-timeline/event', () => {
  it('is reachable without any Authorization header (optionalAuth)', async () => {
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: 's1', name: 'wake_clicked' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recorded: true, vtid: 'VTID-02919' });
  });

  it('returns 400 when sessionId is missing', async () => {
    const res = await request(app).post('/api/v1/voice/wake-timeline/event').send({ name: 'wake_clicked' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sessionId is required');
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown event name', async () => {
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: 's1', name: 'not_a_real_event' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown wake-timeline event name: not_a_real_event');
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it('records the event with metadata + at when supplied', async () => {
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: 's1', name: 'first_audio_output', metadata: { ms: 42 }, at: '2026-07-28T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(mockRecordEvent).toHaveBeenCalledWith({
      sessionId: 's1',
      name: 'first_audio_output',
      metadata: { ms: 42 },
      at: '2026-07-28T00:00:00Z',
    });
  });

  it('omits metadata when it is not a plain object', async () => {
    await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: 's1', name: 'wake_clicked', metadata: ['not', 'an', 'object'] });

    expect(mockRecordEvent).toHaveBeenCalledWith({ sessionId: 's1', name: 'wake_clicked' });
  });

  it('trims sessionId before recording', async () => {
    await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: '  s1  ', name: 'wake_clicked' });

    expect(mockRecordEvent).toHaveBeenCalledWith({ sessionId: 's1', name: 'wake_clicked' });
  });

  it('returns ok:true, recorded:false when the recorder throws (never a 5xx on the wake path)', async () => {
    mockRecordEvent.mockImplementation(() => {
      throw new Error('recorder busy');
    });
    const res = await request(app)
      .post('/api/v1/voice/wake-timeline/event')
      .send({ sessionId: 's1', name: 'wake_clicked' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recorded: false, reason: 'recorder busy', vtid: 'VTID-02919' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/wake-timeline/analysis
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/wake-timeline/analysis', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/v1/voice/wake-timeline/analysis');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin caller', async () => {
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).get('/api/v1/voice/wake-timeline/analysis');
    expect(res.status).toBe(403);
  });

  it('defaults limit to 200 and runs the cohort analysis over listRecent results', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const rows = [{ session_id: 's1' }];
    mockListRecent.mockResolvedValue(rows);
    const analysis = { total_sessions: 1 };
    mockAnalyzeReliabilityCohort.mockReturnValue(analysis);

    const res = await request(app).get('/api/v1/voice/wake-timeline/analysis');

    expect(res.status).toBe(200);
    expect(mockListRecent).toHaveBeenCalledWith({ userId: undefined, tenantId: undefined, limit: 200 });
    expect(mockAnalyzeReliabilityCohort).toHaveBeenCalledWith(rows);
    expect(res.body).toEqual({
      ok: true,
      vtid: 'VTID-02927',
      filters: { userId: null, tenantId: null, limit: 200 },
      analysis,
    });
  });

  it('clamps limit above 500 down to 500', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockListRecent.mockResolvedValue([]);
    mockAnalyzeReliabilityCohort.mockReturnValue({});
    await request(app).get('/api/v1/voice/wake-timeline/analysis?limit=10000');
    expect(mockListRecent).toHaveBeenCalledWith({ userId: undefined, tenantId: undefined, limit: 500 });
  });

  it('forwards userId/tenantId filters into both the query and the response filters block', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockListRecent.mockResolvedValue([]);
    mockAnalyzeReliabilityCohort.mockReturnValue({});
    const res = await request(app).get('/api/v1/voice/wake-timeline/analysis?userId=u1&tenantId=t1&limit=50');
    expect(mockListRecent).toHaveBeenCalledWith({ userId: 'u1', tenantId: 't1', limit: 50 });
    expect(res.body.filters).toEqual({ userId: 'u1', tenantId: 't1', limit: 50 });
  });

  it('returns 500 when the recorder throws', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockListRecent.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/api/v1/voice/wake-timeline/analysis');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
    expect(res.body.vtid).toBe('VTID-02927');
  });
});

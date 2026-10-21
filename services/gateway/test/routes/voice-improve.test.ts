/**
 * Tests for src/routes/voice-improve.ts (VTID-02865, VTID-02867)
 *
 *   GET  /api/v1/voice/improvement/briefing               — requireDevAccess
 *        (local helper: X-Gateway-Internal bypass OR requireAuth + exafy_admin)
 *   POST /api/v1/voice/improvement/items/:id/create-vtid   — requireAuthWithTenant
 *        + manual exafy_admin check; idempotent on source_action_item_id
 *   GET  /api/v1/voice/quality-by-provider                 — requireDevAccess
 *
 * requireDevAccess is defined inline in the route file (not exported) and
 * wraps the mocked requireAuth — we mock requireAuth generically so
 * requireDevAccess's own admin-check branch runs for real.
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockAuthed = false;
let mockIdentity: { user_id: string; exafy_admin: boolean } = { user_id: 'user-1', exafy_admin: false };

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(async (req: any, res: any, next: any) => {
    if (!mockAuthed) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    req.identity = mockIdentity;
    next();
  }),
  requireAuthWithTenant: jest.fn((req: any, res: any, next: any) => {
    if (!mockAuthed) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    req.identity = mockIdentity;
    next();
  }),
}));

const mockBuildBriefing = jest.fn();
jest.mock('../../src/services/voice-improvement-aggregator', () => ({
  buildVoiceImprovementBriefing: (...args: unknown[]) => mockBuildBriefing(...args),
}));

const mockGetRollup = jest.fn();
jest.mock('../../src/services/voice-quality-by-provider', () => ({
  getProviderQualityRollup: (...args: unknown[]) => mockGetRollup(...args),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

import router from '../../src/routes/voice-improve';

const app = express();
app.use(express.json());
app.use('/api/v1', router);

const ADMIN_IDENTITY = { user_id: 'admin-1', exafy_admin: true };
const NON_ADMIN_IDENTITY = { user_id: 'user-1', exafy_admin: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthed = false;
  mockIdentity = NON_ADMIN_IDENTITY;
  delete process.env.GATEWAY_INTERNAL_TOKEN;
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
  (global.fetch as jest.Mock).mockReset();
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/improvement/briefing
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/improvement/briefing', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/v1/voice/improvement/briefing');
    expect(res.status).toBe(401);
    expect(mockBuildBriefing).not.toHaveBeenCalled();
  });

  it('returns 403 for an authenticated non-admin', async () => {
    mockAuthed = true;
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).get('/api/v1/voice/improvement/briefing');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/exafy_admin/);
  });

  it('bypasses auth via the X-Gateway-Internal header when it matches GATEWAY_INTERNAL_TOKEN', async () => {
    process.env.GATEWAY_INTERNAL_TOKEN = 'shh-secret';
    mockBuildBriefing.mockResolvedValue({ generated_at: 'now', quality_score: 90, action_items: [] });

    const res = await request(app)
      .get('/api/v1/voice/improvement/briefing')
      .set('X-Gateway-Internal', 'shh-secret');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects a mismatched X-Gateway-Internal header (falls through to normal auth)', async () => {
    process.env.GATEWAY_INTERNAL_TOKEN = 'shh-secret';
    mockAuthed = false;
    const res = await request(app)
      .get('/api/v1/voice/improvement/briefing')
      .set('X-Gateway-Internal', 'wrong-value');
    expect(res.status).toBe(401);
  });

  it('returns the briefing for an admin caller and forwards ?max', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    mockBuildBriefing.mockResolvedValue({ generated_at: 'now', quality_score: 87, action_items: [{ id: 'a1' }] });

    const res = await request(app).get('/api/v1/voice/improvement/briefing?max=5');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.quality_score).toBe(87);
    expect(res.body.vtid).toBe('VTID-02865');
    expect(mockBuildBriefing).toHaveBeenCalledWith({ max: 5 });
  });

  it('returns 500 when the aggregator reports an internal error', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    mockBuildBriefing.mockResolvedValue({ error: 'quarantine table unreachable' });

    const res = await request(app).get('/api/v1/voice/improvement/briefing');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('quarantine table unreachable');
  });

  it('returns 500 when the aggregator throws', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    mockBuildBriefing.mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/api/v1/voice/improvement/briefing');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/quality-by-provider
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/quality-by-provider', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/v1/voice/quality-by-provider');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin caller', async () => {
    mockAuthed = true;
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).get('/api/v1/voice/quality-by-provider');
    expect(res.status).toBe(403);
  });

  it('defaults to a 7-day window', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    mockGetRollup.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/v1/voice/quality-by-provider');
    expect(res.status).toBe(200);
    expect(mockGetRollup).toHaveBeenCalledWith(7);
    expect(res.body.vtid).toBe('VTID-02867');
  });

  it('clamps days above 30 down to 30', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    mockGetRollup.mockResolvedValue({ rows: [] });
    await request(app).get('/api/v1/voice/quality-by-provider?days=999');
    expect(mockGetRollup).toHaveBeenCalledWith(30);
  });

  it('clamps days below 1 up to 1', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    mockGetRollup.mockResolvedValue({ rows: [] });
    await request(app).get('/api/v1/voice/quality-by-provider?days=0');
    expect(mockGetRollup).toHaveBeenCalledWith(1);
  });

  it('returns 500 when the rollup throws', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    mockGetRollup.mockRejectedValue(new Error('rollup failed'));
    const res = await request(app).get('/api/v1/voice/quality-by-provider');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('rollup failed');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/voice/improvement/items/:id/create-vtid
// ---------------------------------------------------------------------------
describe('POST /api/v1/voice/improvement/items/:id/create-vtid', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).post('/api/v1/voice/improvement/items/item1/create-vtid').send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin caller', async () => {
    mockAuthed = true;
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).post('/api/v1/voice/improvement/items/item1/create-vtid').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/exafy_admin/);
  });

  it('returns 400 for an item id longer than 256 chars', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    const longId = 'x'.repeat(257);
    const res = await request(app).post(`/api/v1/voice/improvement/items/${longId}/create-vtid`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid item id');
  });

  it('returns 500 when Supabase is not configured', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    delete process.env.SUPABASE_URL;
    const res = await request(app).post('/api/v1/voice/improvement/items/item1/create-vtid').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('supabase not configured');
  });

  it('returns the existing VTID when one was already allocated for this action item (idempotent)', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => [{ vtid: 'VTID-01500', status: 'scheduled', title: 'IMPROVE: existing' }],
    });

    const res = await request(app).post('/api/v1/voice/improvement/items/item1/create-vtid').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      idempotent: true,
      vtid: 'VTID-01500',
      existing_status: 'scheduled',
      existing_title: 'IMPROVE: existing',
      message: 'Action item already produced a VTID; returning the existing one.',
    });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('allocates a new VTID, patches the ledger row, and emits an OASIS event on success', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // idempotency check: none found
      .mockResolvedValueOnce({ ok: true, json: async () => [{ vtid: 'VTID-01777' }] }) // allocate RPC
      .mockResolvedValueOnce({ ok: true, json: async () => [] }); // patch ledger row

    const res = await request(app)
      .post('/api/v1/voice/improvement/items/item1/create-vtid')
      .send({ title: 'Fix wake-word regression', summary: 'Detailed repro', source_files: ['orb-live.ts'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, idempotent: false, vtid: 'VTID-01777', action_item_id: 'item1' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'voice.improvement.vtid_created',
        actor: 'admin-1',
        payload: expect.objectContaining({ vtid: 'VTID-01777', source_action_item_id: 'item1' }),
      }),
    );
  });

  it('returns 500 when VTID allocation fails (non-ok response)', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // idempotency check
      .mockResolvedValueOnce({ ok: false, status: 500 }); // allocate fails

    const res = await request(app).post('/api/v1/voice/improvement/items/item1/create-vtid').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('alloc_500');
  });

  it('returns 500 when the allocator responds without a vtid', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] }); // alloc returns empty array

    const res = await request(app).post('/api/v1/voice/improvement/items/item1/create-vtid').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('alloc_no_vtid_returned');
  });

  it('returns 500 with the allocated_vtid when the ledger PATCH fails', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ vtid: 'VTID-01778' }] })
      .mockResolvedValueOnce({ ok: false, status: 409 });

    const res = await request(app).post('/api/v1/voice/improvement/items/item1/create-vtid').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('patch_409');
    expect(res.body.allocated_vtid).toBe('VTID-01778');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('proceeds past a failed idempotency check (best-effort) and still allocates', async () => {
    mockAuthed = true;
    mockIdentity = ADMIN_IDENTITY;
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('network blip')) // idempotency check throws
      .mockResolvedValueOnce({ ok: true, json: async () => [{ vtid: 'VTID-01900' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    const res = await request(app).post('/api/v1/voice/improvement/items/item1/create-vtid').send({});
    expect(res.status).toBe(200);
    expect(res.body.vtid).toBe('VTID-01900');
  });
});

/**
 * routes/billing.ts — Founding 1000 endpoints (VTID-04859).
 *
 * GET /founding/me reports the signed-in member's seat (read-only; the seat
 * and the free year are granted by the database at signup), POST
 * /founding/celebrated records that the celebration was shown, and
 * GET /founding-status reports seats taken of 1,000 with no code.
 */

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({})),
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  ...jest.requireActual('../../src/middleware/auth-supabase-jwt'),
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.identity = { user_id: 'u1', tenant_id: 't1' };
    next();
  },
}));

const mockEmit = jest.fn(async () => ({ ok: true }));
jest.mock('../../src/services/oasis-event-service', () => ({
  ...jest.requireActual('../../src/services/oasis-event-service'),
  emitOasisEvent: (...a: unknown[]) => (mockEmit as any)(...a),
}));

const mockFetchFoundingMember = jest.fn();
const mockMarkCelebrated = jest.fn();
const mockCountSeats = jest.fn();
jest.mock('../../src/routes/billing-repository', () => ({
  ...jest.requireActual('../../src/routes/billing-repository'),
  fetchFoundingMember: (...a: unknown[]) => mockFetchFoundingMember(...a),
  rpcMarkFoundingCelebrated: (...a: unknown[]) => mockMarkCelebrated(...a),
  countFoundingSeats: (...a: unknown[]) => mockCountSeats(...a),
}));

import express from 'express';
import request from 'supertest';
import billingRouter from '../../src/routes/billing';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/billing', billingRouter);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /founding/me', () => {
  it('reports the seat, the year and whether the celebration was shown', async () => {
    mockFetchFoundingMember.mockResolvedValue({
      data: { seat_number: 347, grant_source: 'founding_1000', granted_until: '2027-10-03T00:00:00Z', value_cents: 11988, celebrated_at: null },
      error: null,
    });
    const res = await request(buildApp()).get('/api/v1/billing/founding/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true, founding: true, seat_number: 347, max_seats: 1000,
      granted_until: '2027-10-03T00:00:00Z', value_cents: 11988, currency: 'eur', celebrated: false,
    });
    expect(mockFetchFoundingMember).toHaveBeenCalledWith(expect.anything(), 'u1');
  });

  it('a member without a seat gets founding:false', async () => {
    mockFetchFoundingMember.mockResolvedValue({ data: null, error: null });
    const res = await request(buildApp()).get('/api/v1/billing/founding/me');
    expect(res.body).toMatchObject({ ok: true, founding: false, max_seats: 1000 });
  });

  it('a database error is a 500, never a silent founding:false', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchFoundingMember.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await request(buildApp()).get('/api/v1/billing/founding/me');
    expect(res.status).toBe(500);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('boom'));
    err.mockRestore();
  });
});

describe('POST /founding/celebrated', () => {
  it('marks the celebration for the signed-in member', async () => {
    mockMarkCelebrated.mockResolvedValue({ data: { ok: true, celebrated_at: '2026-10-03T10:00:00Z' }, error: null });
    const res = await request(buildApp()).post('/api/v1/billing/founding/celebrated');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, celebrated_at: '2026-10-03T10:00:00Z' });
    expect(mockMarkCelebrated).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-04859', type: 'billing.founding.celebrated', actor_id: 'u1',
    }));
  });

  it('a member without a seat gets 404', async () => {
    mockMarkCelebrated.mockResolvedValue({ data: { ok: false, error: 'NOT_A_FOUNDING_MEMBER' }, error: null });
    const res = await request(buildApp()).post('/api/v1/billing/founding/celebrated');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_A_FOUNDING_MEMBER');
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('GET /founding-status', () => {
  it('reports seats taken of 1,000 and never a code', async () => {
    mockCountSeats.mockResolvedValue({ count: 231, error: null });
    const res = await request(buildApp()).get('/api/v1/billing/founding-status');
    expect(res.body).toMatchObject({
      ok: true, active: true, uses_count: 231, max_uses: 1000, remaining: 769, code: null, campaign: 'founding_1000',
    });
  });

  it('is inactive once all 1,000 seats are taken', async () => {
    mockCountSeats.mockResolvedValue({ count: 1000, error: null });
    const res = await request(buildApp()).get('/api/v1/billing/founding-status');
    expect(res.body).toMatchObject({ active: false, remaining: 0, code: null });
  });
});

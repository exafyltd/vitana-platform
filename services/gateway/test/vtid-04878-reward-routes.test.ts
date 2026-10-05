/**
 * VTID-04878 — HTTP behaviour of the reward changes:
 *  - POST /api/v1/rewards/sweep: internal/exafy_admin only, refuses on
 *    staging (409 NOT_PRODUCTION) before any read or write;
 *  - POST /api/v1/autopilot/recommendations/:id/complete pays
 *    autopilot_action_done once for a first-time completion and reports the
 *    real credited amount; a repeat completion or a failed claim pays 0 and
 *    never fails the completion.
 */
import express from 'express';
import request from 'supertest';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role';
process.env.GATEWAY_INTERNAL_TOKEN = 'internal-secret';

jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const identify = (req: any) => {
    const h = String(req.headers.authorization || '');
    if (h === 'Bearer admin') return { user_id: 'admin-1', exafy_admin: true };
    if (h === 'Bearer member') return { user_id: '11111111-1111-1111-1111-111111111111', exafy_admin: false, tenant_id: 't1' };
    return null;
  };
  return {
    optionalAuth: (req: any, _res: any, next: any) => { const id = identify(req); if (id) req.identity = id; next(); },
    requireAuth: async (req: any, res: any, next: any) => {
      const id = identify(req);
      if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = id;
      return next();
    },
  };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' }),
}));
jest.mock('../src/services/rewards/reward-sweep-runner', () => ({
  runAndReportRewardSweep: jest.fn().mockResolvedValue({ ok: true, mode: 'backfill', members_scanned: 3 }),
}));
jest.mock('../src/services/rewards/capped-reward', () => ({ claimCappedReward: jest.fn() }));
jest.mock('../src/services/calendar-producers', () => ({
  completeCalendarEntriesForSource: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/services/recommendation-engine', () => ({
  generateRecommendations: jest.fn(),
  generatePersonalRecommendations: jest.fn(),
  regenerateCommunityRecommendations: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/community-autopilot/lineup-role', () => ({
  resolveLineupRole: jest.fn().mockResolvedValue({ lineup: 'community', narrowed: false }),
}));
jest.mock('../src/routes/autopilot-recommendations-repository', () => ({
  fetchPrimaryTenantId: jest.fn().mockResolvedValue({ data: { tenant_id: 't1' } }),
  fetchRemainingOnboardingRecommendations: jest.fn().mockResolvedValue({ data: [] }),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));

import { runAndReportRewardSweep } from '../src/services/rewards/reward-sweep-runner';
import { claimCappedReward } from '../src/services/rewards/capped-reward';
import { emitOasisEvent } from '../src/services/oasis-event-service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sweepRouter = require('../src/routes/rewards-sweep').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recRouter = require('../src/routes/autopilot-recommendations').default;
const app = express();
app.use(express.json());
app.use('/api/v1', sweepRouter);
app.use('/api/v1/autopilot/recommendations', recRouter);

const runSweep = runAndReportRewardSweep as jest.Mock;
const claim = claimCappedReward as jest.Mock;
const savedEnv = process.env.VITANA_ENV;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VITANA_ENV;
  delete process.env.REWARD_SWEEP_ENABLED;
});
afterAll(() => { process.env.VITANA_ENV = savedEnv; });

describe('POST /api/v1/rewards/sweep', () => {
  test('unauthenticated -> 401 JSON, a member -> 403, nothing runs', async () => {
    const anon = await request(app).post('/api/v1/rewards/sweep').send({});
    expect(anon.status).toBe(401);
    expect(anon.headers['content-type']).toMatch(/json/);
    const member = await request(app).post('/api/v1/rewards/sweep').set('Authorization', 'Bearer member').send({});
    expect(member.status).toBe(403);
    expect(runSweep).not.toHaveBeenCalled();
  });

  test('staging refuses with 409 NOT_PRODUCTION before any work', async () => {
    process.env.VITANA_ENV = 'staging';
    const res = await request(app).post('/api/v1/rewards/sweep').set('X-Gateway-Internal', 'internal-secret').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'NOT_PRODUCTION' });
    expect(runSweep).not.toHaveBeenCalled();
  });

  test('internal caller on production runs the quiet backfill by default', async () => {
    const res = await request(app).post('/api/v1/rewards/sweep').set('X-Gateway-Internal', 'internal-secret').send({});
    expect(res.status).toBe(200);
    expect(runSweep).toHaveBeenCalledWith(expect.anything(), { quiet: true, trigger: 'manual' });
  });

  test('exafy_admin may run a non-quiet sweep', async () => {
    await request(app).post('/api/v1/rewards/sweep').set('Authorization', 'Bearer admin').send({ quiet: false });
    expect(runSweep).toHaveBeenCalledWith(expect.anything(), { quiet: false, trigger: 'manual' });
  });
});

describe('POST /api/v1/autopilot/recommendations/:id/complete pays autopilot_action_done', () => {
  let fetchSpy: jest.SpyInstance;
  const rpcReturns = (body: Record<string, unknown>) => {
    fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body),
    } as any);
  };
  afterEach(() => fetchSpy?.mockRestore());

  test('a first-time completion claims once and reports the credited amount', async () => {
    rpcReturns({ ok: true, title: 'Walk', completed_at: '2026-10-05T10:00:00Z', reward: 0, already_completed: false, source_ref: 'walk' });
    claim.mockResolvedValue({ outcome: 'claimed', credited: 5 });
    const res = await request(app).post('/api/v1/autopilot/recommendations/rec-1/complete').set('Authorization', 'Bearer member');
    expect(res.status).toBe(200);
    expect(res.body.reward).toBe(5);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: '11111111-1111-1111-1111-111111111111', ruleId: 'autopilot_action_done', ref: 'rec-1', tenantId: 't1',
    }));
    const completed = (emitOasisEvent as jest.Mock).mock.calls.find(([e]) => e.type === 'autopilot.recommendation.completed');
    expect(completed?.[0].payload.reward).toBe(5);
  });

  test('a capped claim pays 0 and the completion still succeeds', async () => {
    rpcReturns({ ok: true, title: 'Walk', already_completed: false });
    claim.mockResolvedValue({ outcome: 'capped', credited: 0 });
    const res = await request(app).post('/api/v1/autopilot/recommendations/rec-3/complete').set('Authorization', 'Bearer member');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'completed', reward: 0 });
  });

  test('a repeat completion never claims', async () => {
    rpcReturns({ ok: true, title: 'Walk', already_completed: true });
    const res = await request(app).post('/api/v1/autopilot/recommendations/rec-1/complete').set('Authorization', 'Bearer member');
    expect(res.status).toBe(200);
    expect(res.body.reward).toBe(0);
    expect(claim).not.toHaveBeenCalled();
  });

  test('a throwing claim never fails the completion', async () => {
    rpcReturns({ ok: true, title: 'Walk', already_completed: false });
    claim.mockRejectedValue(new Error('db down'));
    const res = await request(app).post('/api/v1/autopilot/recommendations/rec-4/complete').set('Authorization', 'Bearer member');
    expect(res.status).toBe(200);
    expect(res.body.reward).toBe(0);
  });

  test('unauthenticated completion is rejected and pays nothing', async () => {
    const res = await request(app).post('/api/v1/autopilot/recommendations/rec-1/complete');
    expect(res.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });
});

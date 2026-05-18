/**
 * VTID-03063 (B0d-real Xf.3) — Candidate Inspector route tests.
 *
 * Covers:
 *   - Pure helpers (groupByDecision, countTotals)
 *   - HTTP contract: 400 on missing user_id, 503 on missing DB,
 *     200 happy-path with grouped decisions + totals
 *   - admin-only auth (the mock injects admin identity)
 */

import express from 'express';
import request from 'supertest';
import {
  groupByDecision,
  countTotals,
  type OasisRowLike,
} from '../../src/routes/voice-next-action-inspector';

// Mock auth — admin pass-through.
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  requireAuthWithTenant: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'admin', tenant_id: 'admin' };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

// Mock the supabase factory so we can inject query results.
const supabaseMock = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => supabaseMock(),
}));

function fakeSb(rows: unknown[] | null, err: { message: string } | null = null) {
  const chain = {
    in: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(err ? { data: null, error: err } : { data: rows, error: null }),
  };
  return {
    from: () => ({ select: () => chain }),
  };
}

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-next-action-inspector').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('VTID-03063 — pure helpers', () => {
  test('groupByDecision groups rows by decision_id and merges topics', () => {
    const rows: OasisRowLike[] = [
      {
        id: '1',
        topic: 'orb.livekit.next_action.suggested',
        created_at: '2026-05-18T08:00:00Z',
        payload: { decision_id: 'd-1', dedupe_key: 'k-1', priority: 90 },
        actor_id: 'u1',
      },
      {
        id: '2',
        topic: 'orb.livekit.next_action.accepted',
        created_at: '2026-05-18T08:01:00Z',
        payload: { decision_id: 'd-1', source: 'reminder_due' },
        actor_id: 'u1',
      },
      {
        id: '3',
        topic: 'orb.livekit.next_action.suppressed',
        created_at: '2026-05-18T08:05:00Z',
        payload: { decision_id: 'd-2', suppress_reason: 'tied_below_threshold' },
        actor_id: 'u1',
      },
    ];
    const groups = groupByDecision(rows, 10);
    expect(groups).toHaveLength(2);
    const d1 = groups.find((g) => g.decision_id === 'd-1')!;
    expect(d1.suggested_at).toBe('2026-05-18T08:00:00Z');
    expect(d1.outcome).toBe('accepted');
    expect(d1.outcome_at).toBe('2026-05-18T08:01:00Z');
    const d2 = groups.find((g) => g.decision_id === 'd-2')!;
    expect(d2.suppressed_at).toBe('2026-05-18T08:05:00Z');
    expect(d2.suppressed?.suppress_reason).toBe('tied_below_threshold');
  });

  test('groupByDecision drops rows without decision_id in payload', () => {
    const groups = groupByDecision(
      [
        {
          id: '1',
          topic: 'orb.livekit.next_action.suggested',
          created_at: '2026-05-18T08:00:00Z',
          payload: { /* no decision_id */ priority: 90 },
          actor_id: 'u1',
        },
      ],
      10,
    );
    expect(groups).toHaveLength(0);
  });

  test('groupByDecision respects the cap', () => {
    const rows: OasisRowLike[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push({
        id: String(i),
        topic: 'orb.livekit.next_action.suggested',
        created_at: `2026-05-18T08:0${i}:00Z`,
        payload: { decision_id: `d-${i}` },
        actor_id: 'u1',
      });
    }
    const groups = groupByDecision(rows, 3);
    expect(groups).toHaveLength(3);
  });

  test('countTotals counts every topic', () => {
    const t = countTotals([
      { id: '1', topic: 'orb.livekit.next_action.suggested', created_at: '', payload: {}, actor_id: 'u1' },
      { id: '2', topic: 'orb.livekit.next_action.suggested', created_at: '', payload: {}, actor_id: 'u1' },
      { id: '3', topic: 'orb.livekit.next_action.accepted', created_at: '', payload: {}, actor_id: 'u1' },
      { id: '4', topic: 'orb.livekit.next_action.dismissed', created_at: '', payload: {}, actor_id: 'u1' },
      { id: '5', topic: 'orb.livekit.next_action.suppressed', created_at: '', payload: {}, actor_id: 'u1' },
    ]);
    expect(t).toEqual({ suggested: 2, accepted: 1, dismissed: 1, suppressed: 1 });
  });
});

describe('VTID-03063 — HTTP contract', () => {
  beforeEach(() => {
    supabaseMock.mockReset();
  });

  it('400 on missing user_id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/next-action/inspector');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/user_id/);
  });

  it('400 on invalid user_id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/next-action/inspector?user_id=not-uuid!');
    expect(res.status).toBe(400);
  });

  it('503 on missing DB', async () => {
    supabaseMock.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/next-action/inspector?user_id=c5a4daf9-190a-4a9e-9638-d6b32f85244a',
    );
    expect(res.status).toBe(503);
  });

  it('200 happy path returns grouped decisions + totals', async () => {
    supabaseMock.mockReturnValue(
      fakeSb([
        {
          id: '1',
          topic: 'orb.livekit.next_action.suggested',
          created_at: '2026-05-18T08:00:00Z',
          payload: { decision_id: 'd-1', priority: 95 },
          actor_id: 'c5a4daf9-190a-4a9e-9638-d6b32f85244a',
        },
        {
          id: '2',
          topic: 'orb.livekit.next_action.accepted',
          created_at: '2026-05-18T08:01:00Z',
          payload: { decision_id: 'd-1' },
          actor_id: 'c5a4daf9-190a-4a9e-9638-d6b32f85244a',
        },
      ]),
    );
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/next-action/inspector?user_id=c5a4daf9-190a-4a9e-9638-d6b32f85244a&hours=12',
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.window_hours).toBe(12);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0].decision_id).toBe('d-1');
    expect(res.body.decisions[0].outcome).toBe('accepted');
    expect(res.body.totals).toEqual({
      suggested: 1,
      accepted: 1,
      dismissed: 0,
      suppressed: 0,
    });
  });

  it('500 when supabase query errors', async () => {
    supabaseMock.mockReturnValue(fakeSb(null, { message: 'rls denied' }));
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/next-action/inspector?user_id=c5a4daf9-190a-4a9e-9638-d6b32f85244a',
    );
    expect(res.status).toBe(500);
  });
});

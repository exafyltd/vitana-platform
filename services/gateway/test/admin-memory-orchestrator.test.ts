// BOOTSTRAP-MEMORY-ORCHESTRATOR-MANDATORY — HTTP tests for the
// Memory Alive/Dead admin status endpoint.
//
// Contract under test (GET /api/v1/admin/memory-orchestrator/status):
//   - auth: 401 without token, 403 for non-exafy-admin
//   - verdict: no_data (no events), alive (turns injected + retrieved),
//     degraded (injected but nothing retrieved / soft bypasses),
//     dead (turns shipped without the block / enforced bypasses)
//   - error path: 500 with ok=false when the events query fails

import express from 'express';
import request from 'supertest';

let mockSupabase: any;

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (h === 'Bearer admin') { req.identity = { user_id: 'admin-1', exafy_admin: true }; return next(); }
    if (h === 'Bearer user') { req.identity = { user_id: 'user-1', exafy_admin: false }; return next(); }
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  },
  requireExafyAdmin: (req: any, res: any, next: any) => {
    if (!req.identity?.exafy_admin) return res.status(403).json({ ok: false, error: 'forbidden' });
    return next();
  },
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/admin-memory-orchestrator').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

/** Chainable oasis_events query stub resolving to the given result. */
function makeFakeSupabase(result: { data: any[] | null; error: { message: string } | null }) {
  return {
    from: (_table: string) => {
      const chain: any = {};
      for (const m of ['select', 'in', 'gte', 'order', 'limit', 'eq']) chain[m] = () => chain;
      chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
      return chain;
    },
  };
}

function turnEvent(payload: Record<string, unknown>, createdAt = new Date().toISOString()) {
  return { type: 'memory.orchestrator.turn', status: 'success', payload, created_at: createdAt };
}

const HEALTHY_TURN = {
  memory_injected_to_prompt: true,
  assistant_used_memory: true,
  memory_hits: 10,
  facts_loaded: 4,
  goals_loaded: 1,
  preferences_loaded: 3,
  dismissed_loaded: 1,
  channel: 'orb',
};

beforeEach(() => {
  mockSupabase = makeFakeSupabase({ data: [], error: null });
});

describe('GET /api/v1/admin/memory-orchestrator/status — auth', () => {
  it('401 without token', async () => {
    const r = await request(makeApp()).get('/api/v1/admin/memory-orchestrator/status');
    expect(r.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer user');
    expect(r.status).toBe(403);
  });
});

describe('GET /api/v1/admin/memory-orchestrator/status — verdict', () => {
  it('no_data when no orchestrator events exist', async () => {
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer admin');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.status).toBe('no_data');
    expect(r.body.memory_alive).toBe(false);
  });

  it('alive when turns are injected AND retrieved, with rates + averages', async () => {
    mockSupabase = makeFakeSupabase({
      data: [turnEvent(HEALTHY_TURN), turnEvent({ ...HEALTHY_TURN, assistant_used_memory: false })],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer admin');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('alive');
    expect(r.body.memory_alive).toBe(true);
    expect(r.body.totals.turns).toBe(2);
    expect(r.body.rates.injected_rate).toBe(1);
    expect(r.body.rates.used_rate).toBe(0.5);
    expect(r.body.averages_per_turn.memory_hits).toBe(10);
    expect(r.body.per_channel.orb.turns).toBe(2);
  });

  it('degraded when memory is injected but nothing was ever retrieved', async () => {
    mockSupabase = makeFakeSupabase({
      data: [turnEvent({ ...HEALTHY_TURN, memory_hits: 0, assistant_used_memory: false })],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer admin');
    expect(r.body.status).toBe('degraded');
    expect(r.body.memory_alive).toBe(false);
  });

  it('degraded when soft bypasses were detected alongside healthy turns', async () => {
    mockSupabase = makeFakeSupabase({
      data: [
        turnEvent(HEALTHY_TURN),
        {
          type: 'memory.orchestrator.bypass_detected',
          status: 'warning',
          payload: { caller: 'processWithGemini', enforced: false },
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer admin');
    expect(r.body.status).toBe('degraded');
    expect(r.body.totals.bypasses_soft).toBe(1);
    expect(r.body.recent_bypass_callers).toEqual(['processWithGemini']);
  });

  it('dead when turns ship without the memory block (injected_rate < 0.9)', async () => {
    mockSupabase = makeFakeSupabase({
      data: [
        turnEvent(HEALTHY_TURN),
        turnEvent({ ...HEALTHY_TURN, memory_injected_to_prompt: false }),
      ],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer admin');
    expect(r.body.status).toBe('dead');
    expect(r.body.memory_alive).toBe(false);
  });

  it('dead when an enforced bypass fired', async () => {
    mockSupabase = makeFakeSupabase({
      data: [
        turnEvent(HEALTHY_TURN),
        {
          type: 'memory.orchestrator.bypass_detected',
          status: 'error',
          payload: { caller: 'routes/conversation.turn', enforced: true },
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer admin');
    expect(r.body.status).toBe('dead');
    expect(r.body.totals.bypasses_enforced).toBe(1);
  });

  it('clamps window_hours into [1, 168]', async () => {
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status?window_hours=9999')
      .set('Authorization', 'Bearer admin');
    expect(r.body.window_hours).toBe(168);
  });
});

describe('GET /api/v1/admin/memory-orchestrator/status — error paths', () => {
  it('500 with ok=false when the events query errors', async () => {
    mockSupabase = makeFakeSupabase({ data: null, error: { message: 'relation missing' } });
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer admin');
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('relation missing');
  });

  it('503 when Supabase is not configured', async () => {
    mockSupabase = null;
    const r = await request(makeApp())
      .get('/api/v1/admin/memory-orchestrator/status')
      .set('Authorization', 'Bearer admin');
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });
});

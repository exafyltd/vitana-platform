/**
 * VTID-03319 — news-feed top-performer endpoint tests.
 *
 * Covers: auth gate (401), happy path (most-improved consented member, no exact
 * score leaked), no-consent → null, and insufficient history → null.
 */
import request from 'supertest';
import express from 'express';

// --- Mocks (must be declared before requiring the router) ---
let tableData: Record<string, any[]>;

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization === 'Bearer user') {
      req.identity = { user_id: 'viewer-1', tenant_id: null };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  },
}));

// Minimal chainable, awaitable query builder — filters are no-ops; the route's
// logic is driven entirely by the rows we seed per table.
function builder(rows: any[]) {
  const b: any = {
    select: () => b,
    eq: () => b,
    in: () => b,
    gte: () => b,
    order: () => b,
    then: (resolve: any) => resolve({ data: rows, error: null }),
  };
  return b;
}
jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({ from: (table: string) => builder(tableData[table] || []) }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const newsFeedRouter = require('../src/routes/news-feed').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/news-feed', newsFeedRouter);
  return app;
}

describe('GET /api/v1/news-feed/top-performer', () => {
  beforeEach(() => {
    tableData = {};
  });

  it('401s without auth', async () => {
    const res = await request(makeApp()).get('/api/v1/news-feed/top-performer');
    expect(res.status).toBe(401);
  });

  it('returns the most-improved consented member (no exact score leaked)', async () => {
    tableData = {
      profiles: [
        { user_id: 'a', display_name: 'Ada', avatar_url: null },
        { user_id: 'b', display_name: 'Ben', avatar_url: null },
      ],
      // date-ascending, as the route's .order('date') guarantees
      vitana_index_scores: [
        { user_id: 'a', date: '2026-06-01', score_total: 500 },
        { user_id: 'a', date: '2026-06-18', score_total: 540 }, // +40
        { user_id: 'b', date: '2026-06-01', score_total: 600 },
        { user_id: 'b', date: '2026-06-18', score_total: 610 }, // +10
      ],
    };
    const res = await request(makeApp())
      .get('/api/v1/news-feed/top-performer')
      .set('authorization', 'Bearer user');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.performer.user_id).toBe('a'); // bigger delta wins
    expect(res.body.performer.improvement).toBe(40);
    // Exact Index scores must never be exposed.
    expect(JSON.stringify(res.body)).not.toContain('540');
    expect(JSON.stringify(res.body)).not.toContain('score_total');
  });

  it('returns null when nobody opted in', async () => {
    tableData = { profiles: [], vitana_index_scores: [] };
    const res = await request(makeApp())
      .get('/api/v1/news-feed/top-performer')
      .set('authorization', 'Bearer user');
    expect(res.status).toBe(200);
    expect(res.body.performer).toBeNull();
  });

  it('returns null when there is no real improvement (single data point / non-positive delta)', async () => {
    tableData = {
      profiles: [{ user_id: 'a', display_name: 'Ada', avatar_url: null }],
      vitana_index_scores: [
        { user_id: 'a', date: '2026-06-01', score_total: 500 }, // only one point
      ],
    };
    const res = await request(makeApp())
      .get('/api/v1/news-feed/top-performer')
      .set('authorization', 'Bearer user');
    expect(res.status).toBe(200);
    expect(res.body.performer).toBeNull();
  });
});

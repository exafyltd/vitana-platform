/**
 * VTID-05169 — Life Timeline P3: /api/v1/timeline.
 * The repository is mocked; the route + reader logic run for real.
 */
import express from 'express';
import request from 'supertest';

let currentIdentity: any = { user_id: 'u1', tenant_id: 't1' };
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    if (currentIdentity) req.identity = currentIdentity;
    next();
  },
}));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({}) }));

const repo = {
  fetchClassifiedRows: jest.fn(),
  fetchLegacyRows: jest.fn(),
  fetchRowById: jest.fn(),
  fetchMovementsByIds: jest.fn(),
  fetchMovementsBetween: jest.fn(),
  fetchRecentScores: jest.fn(),
  setHiddenFromAi: jest.fn(),
  deleteRow: jest.fn(),
};
jest.mock('../../src/services/timeline/timeline-repository', () => ({
  ...jest.requireActual('../../src/services/timeline/timeline-repository'),
  ...Object.fromEntries(Object.keys(repo).map((k) => [k, (...a: unknown[]) => (repo as any)[k](...a)])),
}));

import timelineRouter from '../../src/routes/timeline';
import { buildDayDigests, movementFor } from '../../src/services/timeline/timeline-reader';

const app = express();
app.use(express.json());
app.use('/api/v1/timeline', timelineRouter);

const ID = '0b5f3a52-1d6c-4c3e-9a0e-1d2b3c4d5e6f';
const today = new Date().toISOString().slice(0, 10);
const at = (h: number) => `${today}T${String(h).padStart(2, '0')}:00:00.000Z`;

function mv(over: Record<string, unknown> = {}) {
  return {
    id: 'm1', at: at(9), score_date: today, trigger: 'voice_log', source_kind: 'health_feature', source_ref: 'water_intake',
    before: { score_total: 300 }, after: { score_total: 306 }, delta_total: 6,
    delta_pillars: { nutrition: 0, hydration: 6, exercise: 0, sleep: 0, mental: 0 }, balance_before: 0.9, balance_after: 0.9,
    ...over,
  };
}

beforeEach(() => {
  currentIdentity = { user_id: 'u1', tenant_id: 't1' };
  for (const f of Object.values(repo)) f.mockReset();
  repo.fetchMovementsByIds.mockResolvedValue([]);
  repo.fetchMovementsBetween.mockResolvedValue([]);
  repo.fetchClassifiedRows.mockResolvedValue({ rows: [], missingSchema: false, error: null });
  repo.fetchLegacyRows.mockResolvedValue({ rows: [], error: null });
});

describe('auth', () => {
  it.each([
    ['get', '/api/v1/timeline'],
    ['get', '/api/v1/timeline/spotlight'],
    ['get', '/api/v1/timeline/summary'],
    ['get', `/api/v1/timeline/${ID}`],
    ['post', `/api/v1/timeline/${ID}/hide-from-ai`],
    ['delete', `/api/v1/timeline/${ID}`],
  ])('%s %s → 401 without identity', async (method, url) => {
    currentIdentity = null;
    const res = await (request(app) as any)[method](url).send({ hidden: true });
    expect(res.status).toBe(401);
  });
});

describe('GET /spotlight', () => {
  it('returns the Index headline: tier key, pillars, today’s change from movements only, balance reason key', async () => {
    repo.fetchRecentScores.mockResolvedValue([
      { date: '2026-10-07', score_total: 280, score_nutrition: 60, score_hydration: 40, score_exercise: 60, score_sleep: 60, score_mental: 60, feature_inputs: { balance_factor: 0.9 } },
      { date: today, score_total: 306, score_nutrition: 62, score_hydration: 52, score_exercise: 60, score_sleep: 54, score_mental: 60, feature_inputs: { balance_factor: 0.9 } },
    ]);
    repo.fetchMovementsBetween.mockResolvedValue([
      mv(),
      mv({ id: 'm2', trigger: 'daily', delta_total: 2, delta_pillars: { nutrition: 2 } }),
    ]);
    const res = await request(app).get('/api/v1/timeline/spotlight');
    expect(res.status).toBe(200);
    const s = res.body.spotlight;
    expect(s.score_total).toBe(306);
    expect(s.tier).toBe('building');
    expect(s.change_today).toBe(8);
    expect(s.change_7d).toBe(26);
    expect(s.pillars.hydration).toEqual({ score: 52, change_today: 6, momentum: 'rising' });
    expect(s.pillars.sleep.momentum).toBe('slipping');
    expect(s.weakest_pillar).toBe('hydration');
    expect(s.balance).toEqual({ factor: 0.9, penalty_pct: 10, reason_key: 'timeline.balance.held_back', weakest_pillar: 'hydration' });
    // The nightly "daily" movement is not a contributor.
    expect(s.top_contributors).toEqual([{ trigger: 'voice_log', source_kind: 'health_feature', delta_total: 6, top_pillar: 'hydration', at: at(9) }]);
  });

  it('is null before the member has any score', async () => {
    repo.fetchRecentScores.mockResolvedValue([]);
    const res = await request(app).get('/api/v1/timeline/spotlight');
    expect(res.body).toMatchObject({ ok: true, spotlight: null });
  });
});

describe('GET /', () => {
  it('lists Index day cards, digests and moments; influence is measured only from a movement', async () => {
    repo.fetchClassifiedRows.mockImplementation(async (_sb: unknown, q: any) => {
      if (q.tiers.includes('digest')) {
        return {
          rows: [
            { id: 'd1', activity_type: 'community.reaction.add', activity_data: {}, created_at: at(8), tier: 'digest' },
            { id: 'd2', activity_type: 'community.comment.create', activity_data: {}, created_at: at(8), tier: 'digest' },
            { id: 'd3', activity_type: 'media.music.play', activity_data: {}, created_at: at(8), tier: 'digest' },
            { id: 'd4', activity_type: 'health.biomarker.share', activity_data: {}, created_at: at(8), tier: 'digest' },
          ],
          missingSchema: false, error: null,
        };
      }
      return {
        rows: [
          { id: 'r1', activity_type: 'health.log.water', activity_data: { via: 'voice', amount_ml: 500, movement_id: 'm1', secret: 'x' }, created_at: at(9), tier: 'moment', pillar: 'hydration', category: 'hydration', topic: 'water_logged' },
          { id: 'r2', activity_type: 'health.log.sleep', activity_data: { via: 'voice', hours: 7.5 }, created_at: at(7), tier: 'moment', pillar: 'sleep', category: 'sleep', topic: 'sleep_logged' },
          { id: 'r3', activity_type: 'community.group.join', activity_data: {}, created_at: at(6), tier: 'moment', secondary_pillar: 'mental', category: 'community', topic: 'group_joined' },
        ],
        missingSchema: false, error: null,
      };
    });
    repo.fetchMovementsByIds.mockResolvedValue([mv()]);
    repo.fetchMovementsBetween.mockResolvedValue([mv()]);
    const res = await request(app).get('/api/v1/timeline');
    expect(res.status).toBe(200);
    const kinds = res.body.items.map((i: any) => i.kind);
    expect(kinds).toEqual(['index_day', 'day_digest', 'moment', 'moment', 'moment']);
    expect(res.body.items[0]).toMatchObject({ delta_total: 6, top_pillar: 'hydration', delta_pillars: { hydration: 6 } });
    // The special-category share never counts toward the digest.
    expect(res.body.items[1].total).toBe(3);
    const [water, sleep, group] = res.body.items.slice(2);
    expect(water.influence).toEqual({ kind: 'measured', delta_total: 6, delta_pillars: { hydration: 6 }, movement_id: 'm1' });
    expect(water.summary).toEqual({ key: 'timeline.summary.health_log_water', params: { via: 'voice', amount_ml: 500 } });
    expect(sleep.influence).toEqual({ kind: 'counted', pillar: 'sleep' });
    expect(group.influence).toEqual({ kind: 'counted', pillar: 'mental' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);
  });

  it('before the VTID-05167 migration it classifies in process and never lists silent or system rows', async () => {
    repo.fetchClassifiedRows.mockResolvedValue({ rows: [], missingSchema: true, error: null });
    repo.fetchLegacyRows.mockResolvedValue({
      rows: [
        { id: 'a', activity_type: 'orb.livekit.next_action.candidate', activity_data: { source: 'life_compass_alignment', status: 'skipped' }, created_at: at(10) },
        { id: 'b', activity_type: 'page.view', activity_data: { path: '/memory' }, created_at: at(10) },
        { id: 'c', activity_type: 'diary.create', activity_data: { entry_type: 'voice' }, created_at: at(9) },
      ],
      error: null,
    });
    const res = await request(app).get('/api/v1/timeline');
    expect(res.body.items.map((i: any) => i.id)).toEqual(['c']);
    expect(res.body.items[0]).toMatchObject({ topic: 'diary_entry', secondary_pillar: 'mental' });
  });

  it('passes the pillar filter to the query and pages with a cursor', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      id: `r${i}`, activity_type: 'health.log.water', activity_data: {}, created_at: at(10 - i), tier: 'moment', pillar: 'hydration',
    }));
    repo.fetchClassifiedRows.mockResolvedValue({ rows, missingSchema: false, error: null });
    const res = await request(app).get('/api/v1/timeline?pillar=hydration&limit=2');
    expect(repo.fetchClassifiedRows.mock.calls[0][1]).toMatchObject({ userId: 'u1', pillar: 'hydration', tiers: ['spotlight', 'moment'], limit: 2 });
    expect(res.body.next_cursor).toBe(at(9));
  });

  it.each([['pillar=social'], ['category=nope']])('400 on %s', async (qs) => {
    const res = await request(app).get(`/api/v1/timeline?${qs}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /summary', () => {
  it('counts per pillar (incl. secondary), category and day', async () => {
    repo.fetchClassifiedRows.mockResolvedValue({
      rows: [
        { id: '1', activity_type: 'health.log.water', activity_data: {}, created_at: at(9), tier: 'moment', pillar: 'hydration', category: 'hydration' },
        { id: '2', activity_type: 'community.group.join', activity_data: {}, created_at: at(8), tier: 'moment', secondary_pillar: 'mental', category: 'community' },
      ],
      missingSchema: false, error: null,
    });
    const res = await request(app).get('/api/v1/timeline/summary');
    expect(res.body.summary.pillars).toMatchObject({ hydration: 1, mental: 1, sleep: 0 });
    expect(res.body.summary.categories).toEqual({ hydration: 1, community: 1 });
    expect(res.body.summary.days[today]).toBe(2);
  });
});

describe('GET /:id, hide, delete', () => {
  it('returns a moment with its Index before/after', async () => {
    repo.fetchRowById.mockResolvedValue({ row: { id: ID, activity_type: 'health.log.water', activity_data: { movement_id: 'm1' }, created_at: at(9), tier: 'moment' } });
    repo.fetchMovementsByIds.mockResolvedValue([mv()]);
    const res = await request(app).get(`/api/v1/timeline/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body.detail).toMatchObject({ index_before: { score_total: 300 }, index_after: { score_total: 306 }, used_by_vitana: true, why_kept_key: 'timeline.why_kept.moment' });
    expect(repo.fetchRowById.mock.calls[0].slice(1)).toEqual(['u1', ID]);
  });

  it('404 for a silent or system row (never shown)', async () => {
    repo.fetchRowById.mockResolvedValue({ row: { id: ID, activity_type: 'page.view', activity_data: {}, created_at: at(9) } });
    expect((await request(app).get(`/api/v1/timeline/${ID}`)).status).toBe(404);
  });

  it('400 on a non-uuid id', async () => {
    expect((await request(app).get('/api/v1/timeline/abc')).status).toBe(400);
  });

  it('hide-from-ai: validates, 409 before the migration, 404 when not the member’s, 200 otherwise', async () => {
    expect((await request(app).post(`/api/v1/timeline/${ID}/hide-from-ai`).send({ hidden: 'yes' })).status).toBe(400);
    repo.setHiddenFromAi.mockResolvedValueOnce({ found: false, missingSchema: true, error: { message: 'column' } });
    expect((await request(app).post(`/api/v1/timeline/${ID}/hide-from-ai`).send({ hidden: true })).status).toBe(409);
    repo.setHiddenFromAi.mockResolvedValueOnce({ found: false, missingSchema: false, error: null });
    expect((await request(app).post(`/api/v1/timeline/${ID}/hide-from-ai`).send({ hidden: true })).status).toBe(404);
    repo.setHiddenFromAi.mockResolvedValueOnce({ found: true, missingSchema: false, error: null });
    const ok = await request(app).post(`/api/v1/timeline/${ID}/hide-from-ai`).send({ hidden: true });
    expect(ok.body).toMatchObject({ ok: true, hidden_from_ai: true });
    expect(repo.setHiddenFromAi.mock.calls[2].slice(1)).toEqual(['u1', ID, true]);
  });

  it('delete is scoped to the JWT user', async () => {
    repo.deleteRow.mockResolvedValueOnce({ found: false, error: null });
    expect((await request(app).delete(`/api/v1/timeline/${ID}`)).status).toBe(404);
    repo.deleteRow.mockResolvedValueOnce({ found: true, error: null });
    expect((await request(app).delete(`/api/v1/timeline/${ID}`)).status).toBe(200);
    expect(repo.deleteRow.mock.calls[1].slice(1)).toEqual(['u1', ID]);
  });
});

describe('reader units', () => {
  it('a wearable sync moment takes the nearest wearable_sync movement within 5 minutes', () => {
    const row = { id: 'w', activity_type: 'health.wearable_features.bridged', activity_data: {}, created_at: at(9) };
    const near = mv({ id: 'near', trigger: 'wearable_sync', at: `${today}T09:02:00.000Z` });
    const far = mv({ id: 'far', trigger: 'wearable_sync', at: `${today}T09:20:00.000Z` });
    expect(movementFor(row as any, new Map(), [far as any, near as any])?.id).toBe('near');
    expect(movementFor(row as any, new Map(), [far as any])).toBeNull();
  });

  it('no digest below 3 items', () => {
    const rows = [1, 2].map((i) => ({ id: `${i}`, activity_type: 'media.music.play', activity_data: {}, created_at: at(8), tier: 'digest' }));
    expect(buildDayDigests(rows as any)).toEqual([]);
  });
});

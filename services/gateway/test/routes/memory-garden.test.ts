// VTID-04388 — /api/v1/memory/garden routes.
import express from 'express';
import request from 'supertest';

let currentIdentity: any = { user_id: 'u1', tenant_id: 't1' };
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, _res: any, next: any) => { if (currentIdentity) req.identity = currentIdentity; next(); },
}));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
const svc = {
  listGardenEntries: jest.fn(),
  addGardenFact: jest.fn(),
  addGardenNote: jest.fn(),
  editGardenEpisode: jest.fn(),
  editGardenFact: jest.fn(),
  deleteGardenEntry: jest.fn(),
};
jest.mock('../../src/services/memory/garden', () => {
  const actual = jest.requireActual('../../src/services/memory/garden');
  return { ...actual, ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...a: any[]) => (svc as any)[k](...a)])) };
});

const diary = { saveDiaryEntry: jest.fn(), deleteDiaryEntry: jest.fn() };
jest.mock('../../src/services/memory/diary', () => {
  const actual = jest.requireActual('../../src/services/memory/diary');
  return { ...actual, saveDiaryEntry: (...a: any[]) => diary.saveDiaryEntry(...a), deleteDiaryEntry: (...a: any[]) => diary.deleteDiaryEntry(...a) };
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', require('../../src/routes/memory-garden').default);
  return a;
}

beforeEach(() => { currentIdentity = { user_id: 'u1', tenant_id: 't1' }; Object.values(svc).forEach((f) => f.mockReset()); });

describe('memory garden routes', () => {
  it('401 without identity', async () => {
    currentIdentity = null;
    expect((await request(app()).get('/api/v1/memory/garden/entries')).status).toBe(401);
  });

  it('lists entries with the JWT identity and the active-role header', async () => {
    svc.listGardenEntries.mockResolvedValue([{ id: 'f1' }]);
    const res = await request(app()).get('/api/v1/memory/garden/entries?category=health_wellness&limit=5').set('X-Vitana-Active-Role', 'community');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([{ id: 'f1' }]);
    expect(svc.listGardenEntries.mock.calls[0][1]).toEqual({ tenant_id: 't1', user_id: 'u1', active_role: 'community' });
    expect(svc.listGardenEntries.mock.calls[0][2]).toEqual({ category: 'health_wellness', limit: 5 });
  });

  it('400 on an unknown category', async () => {
    expect((await request(app()).get('/api/v1/memory/garden/entries?category=nope')).status).toBe(400);
  });

  it('categories returns 13 rows', async () => {
    svc.listGardenEntries.mockResolvedValue([]);
    const res = await request(app()).get('/api/v1/memory/garden/categories');
    expect(res.body.categories).toHaveLength(13);
    expect(res.body.total).toBe(0);
  });

  it('502 when the read fails', async () => {
    svc.listGardenEntries.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/api/v1/memory/garden/entries')).status).toBe(502);
  });

  it('adds a fact or a note; rejects other kinds', async () => {
    svc.addGardenFact.mockResolvedValue({ ok: true, id: 'f1' });
    svc.addGardenNote.mockResolvedValue({ ok: true, id: 'n1' });
    expect((await request(app()).post('/api/v1/memory/garden/entries').send({ kind: 'fact', fact_key: 'user_name', fact_value: 'A' })).status).toBe(201);
    expect((await request(app()).post('/api/v1/memory/garden/entries').send({ kind: 'note', content: 'x', category: 'future_plans' })).status).toBe(201);
    expect(svc.addGardenNote.mock.calls[0][3]).toBe('future_plans');
    expect((await request(app()).post('/api/v1/memory/garden/entries').send({ kind: 'other' })).status).toBe(400);
    expect((await request(app()).post('/api/v1/memory/garden/entries').send({ kind: 'note', content: 'x', category: 'bad' })).status).toBe(400);
  });

  it('edit and delete route by kind and pass service errors through', async () => {
    svc.editGardenFact.mockResolvedValue({ ok: true, id: 'f1' });
    svc.deleteGardenEntry.mockResolvedValue({ ok: false, status: 404, error: 'NOT_FOUND' });
    expect((await request(app()).patch('/api/v1/memory/garden/entries/fact/f1').send({ content: 'B' })).status).toBe(200);
    expect(svc.editGardenFact.mock.calls[0].slice(2)).toEqual(['f1', 'B']);
    const del = await request(app()).delete('/api/v1/memory/garden/entries/episode/e1');
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('NOT_FOUND');
    expect((await request(app()).delete('/api/v1/memory/garden/entries/bogus/e1')).status).toBe(400);
  });
});

describe('diary endpoint (VTID-04390)', () => {
  beforeEach(() => { diary.saveDiaryEntry.mockReset(); diary.deleteDiaryEntry.mockReset(); });

  it('validates, saves with the JWT identity and returns the Index sync', async () => {
    diary.saveDiaryEntry.mockResolvedValue({ ok: true, entry: { id: 'd1', created_at: 'x' }, memory_item_id: 'mi1', index: { health_features_written: 1 } });
    const res = await request(app()).post('/api/v1/memory/diary/entries').send({ text: 'slept well', source: 'text' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, entry: { id: 'd1' }, memory_item_id: 'mi1', index: { health_features_written: 1 } });
    expect(diary.saveDiaryEntry.mock.calls[0][1]).toMatchObject({ tenant_id: 't1', user_id: 'u1' });
  });

  it('400 on invalid input, 401 without identity', async () => {
    expect((await request(app()).post('/api/v1/memory/diary/entries').send({ text: 'x', source: 'fax' })).body.error).toBe('INVALID_SOURCE');
    currentIdentity = null;
    expect((await request(app()).post('/api/v1/memory/diary/entries').send({ text: 'x', source: 'text' })).status).toBe(401);
  });

  it('delete passes 404 through', async () => {
    diary.deleteDiaryEntry.mockResolvedValue({ ok: false, status: 404, error: 'NOT_FOUND' });
    expect((await request(app()).delete('/api/v1/memory/diary/entries/d9')).status).toBe(404);
  });
});

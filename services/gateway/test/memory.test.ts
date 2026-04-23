/**
 * Memory Router — Unit + Route Integration Tests
 *
 * Covers:
 * - classifyCategory (pure function, zero I/O)
 * - writeMemoryItem (unit, mocked Supabase)
 * - All 21 route handlers via supertest
 *
 * Mocks: createUserSupabaseClient, emitOasisEvent, processLocationMentionsFromDiary
 */

import request from 'supertest';
import express from 'express';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

jest.mock('../src/routes/locations', () => ({
  processLocationMentionsFromDiary: jest.fn().mockResolvedValue({
    locations_created: 0,
    visits_created: 0,
  }),
}));

const mockRpc = jest.fn();
const mockSelect = jest.fn();
const mockOrder = jest.fn();
const mockFrom = jest.fn();

jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn().mockReturnValue({
    rpc: mockRpc,
    from: mockFrom,
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: { id: 'test-user-id' } },
        error: null,
      }),
    },
  }),
}));

import memoryRouter, { classifyCategory, writeMemoryItem } from '../src/routes/memory';

const AUTH = 'Bearer test-token';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/memory', memoryRouter);
  return app;
}

// ============================================================
// classifyCategory — pure function unit tests
// ============================================================

describe('classifyCategory — unit', () => {
  it('returns personal for English name pattern', () => {
    expect(classifyCategory('my name is Alice')).toBe('personal');
  });

  it('returns personal for German name pattern', () => {
    expect(classifyCategory('Ich heiße Max Mustermann')).toBe('personal');
  });

  it('returns personal for mein name pattern', () => {
    expect(classifyCategory('mein name ist Johann')).toBe('personal');
  });

  it('returns personal for birthday keyword', () => {
    expect(classifyCategory('my birthday is September 9')).toBe('personal');
  });

  it('returns personal for German geburtstag', () => {
    expect(classifyCategory('geburtstag: 12. März')).toBe('personal');
  });

  it('returns personal for residence', () => {
    expect(classifyCategory('I live in Berlin')).toBe('personal');
  });

  it('personal wins over health when both present', () => {
    expect(classifyCategory('my name is Alice and my blood pressure is high')).toBe('personal');
  });

  it('returns health for blood keyword', () => {
    expect(classifyCategory('blood pressure check this morning')).toBe('health');
  });

  it('returns health for sleep keyword', () => {
    expect(classifyCategory('tracked 7 hours sleep last night')).toBe('health');
  });

  it('returns health for glucose keyword', () => {
    expect(classifyCategory('fasting glucose was 95 mg/dL')).toBe('health');
  });

  it('returns health for workout keyword', () => {
    expect(classifyCategory('did a 30 min workout')).toBe('health');
  });

  it('returns relationships for wife keyword', () => {
    expect(classifyCategory('talked with my wife today')).toBe('relationships');
  });

  it('returns relationships for fiancee keyword', () => {
    expect(classifyCategory('my fiancee and I went for a walk')).toBe('relationships');
  });

  it('returns relationships for German verlobt', () => {
    expect(classifyCategory('meine verlobte kommt morgen')).toBe('relationships');
  });

  it('returns events_meetups for meetup keyword before community', () => {
    expect(classifyCategory('attended the local meetup last night')).toBe('events_meetups');
  });

  it('returns events_meetups for conference keyword', () => {
    expect(classifyCategory('registered for the conference in May')).toBe('events_meetups');
  });

  it('returns community when no events keyword matches', () => {
    expect(classifyCategory('joined a community group online')).toBe('community');
  });

  it('returns community for team keyword', () => {
    expect(classifyCategory('had a call with my team today')).toBe('community');
  });

  it('returns products_services for buy keyword', () => {
    expect(classifyCategory('looking to buy a new laptop')).toBe('products_services');
  });

  it('returns products_services for subscription keyword', () => {
    expect(classifyCategory('renewed my subscription plan')).toBe('products_services');
  });

  it('returns tasks for vtid keyword', () => {
    expect(classifyCategory('working on VTID-01200 today')).toBe('tasks');
  });

  it('returns tasks for deploy keyword', () => {
    expect(classifyCategory('need to deploy the gateway service')).toBe('tasks');
  });

  it('returns goals for goal keyword', () => {
    expect(classifyCategory('my goal is to run a marathon')).toBe('goals');
  });

  it('returns goals for habit keyword', () => {
    expect(classifyCategory('building a new habit this month')).toBe('goals');
  });

  it('returns preferences for prefer keyword', () => {
    expect(classifyCategory('I prefer dark mode settings')).toBe('preferences');
  });

  it('returns preferences for favorite keyword', () => {
    expect(classifyCategory('my favorite coffee is espresso')).toBe('preferences');
  });

  it('returns conversation for unmatched content', () => {
    expect(classifyCategory('hello there')).toBe('conversation');
  });

  it('returns conversation for empty-ish content', () => {
    expect(classifyCategory('ok')).toBe('conversation');
  });
});

// ============================================================
// writeMemoryItem — unit tests
// ============================================================

describe('writeMemoryItem — unit', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
    mockFrom.mockReturnValue({
      select: mockSelect.mockReturnValue({
        order: mockOrder.mockResolvedValue({ data: [], error: null }),
      }),
    });
  });

  it('returns error when SUPABASE_ANON_KEY is missing', async () => {
    const saved = process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    const result = await writeMemoryItem('token', { source: 'orb_text', content: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/misconfigured/i);
    process.env.SUPABASE_ANON_KEY = saved;
  });

  it('returns error when SUPABASE_URL is missing', async () => {
    const savedUrl = process.env.SUPABASE_URL;
    const savedKey = process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_URL;
    const result = await writeMemoryItem('token', { source: 'orb_text', content: 'hello' });
    expect(result.ok).toBe(false);
    process.env.SUPABASE_URL = savedUrl;
    process.env.SUPABASE_ANON_KEY = savedKey;
  });

  it('returns error when RPC does not exist (503-class)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'function memory_write_item does not exist' },
    });
    const result = await writeMemoryItem('token', { source: 'orb_text', content: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dependency/i);
  });

  it('returns error on generic RPC error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'some rpc error' },
    });
    const result = await writeMemoryItem('token', { source: 'orb_text', content: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('some rpc error');
  });

  it('returns ok + id on success', async () => {
    mockRpc.mockResolvedValue({
      data: { id: 'mem-123' },
      error: null,
    });
    const result = await writeMemoryItem('token', { source: 'orb_text', content: 'test content' });
    expect(result.ok).toBe(true);
    expect(result.id).toBe('mem-123');
    expect(result.category_key).toBe('conversation');
  });

  it('uses provided category_key when given', async () => {
    mockRpc.mockResolvedValue({ data: { id: 'mem-456' }, error: null });
    const result = await writeMemoryItem('token', {
      source: 'diary',
      content: 'hello',
      category_key: 'health',
    });
    expect(result.ok).toBe(true);
    expect(result.category_key).toBe('health');
  });

  it('auto-classifies content when no category_key given', async () => {
    mockRpc.mockResolvedValue({ data: { id: 'mem-789' }, error: null });
    const result = await writeMemoryItem('token', {
      source: 'orb_voice',
      content: 'blood glucose reading today',
    });
    expect(result.ok).toBe(true);
    expect(result.category_key).toBe('health');
  });
});

// ============================================================
// Route tests — setup
// ============================================================

describe('Memory Router — route integration', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();

    mockRpc.mockResolvedValue({ data: { ok: true, id: 'rpc-result-id' }, error: null });
    mockFrom.mockReturnValue({
      select: mockSelect.mockReturnValue({
        order: mockOrder.mockResolvedValue({ data: [], error: null }),
      }),
    });
  });

  // ----------------------------------------------------------
  // GET /memory/health
  // ----------------------------------------------------------

  describe('GET /health', () => {
    it('returns 200 without auth', async () => {
      const res = await request(app).get('/memory/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.service).toBe('memory-gateway');
    });
  });

  // ----------------------------------------------------------
  // POST /memory/write
  // ----------------------------------------------------------

  describe('POST /write', () => {
    it('401 when no Authorization header', async () => {
      const res = await request(app).post('/memory/write').send({ source: 'orb_text', content: 'hi' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('400 when source is invalid', async () => {
      const res = await request(app)
        .post('/memory/write')
        .set('Authorization', AUTH)
        .send({ source: 'bad_source', content: 'hello' });
      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
    });

    it('400 when content is missing', async () => {
      const res = await request(app)
        .post('/memory/write')
        .set('Authorization', AUTH)
        .send({ source: 'orb_text' });
      expect(res.status).toBe(400);
    });

    it('503 when RPC does not exist', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'function memory_write_item does not exist' },
      });
      const res = await request(app)
        .post('/memory/write')
        .set('Authorization', AUTH)
        .send({ source: 'orb_text', content: 'test content' });
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({ data: { id: 'new-mem-id' }, error: null });
      const res = await request(app)
        .post('/memory/write')
        .set('Authorization', AUTH)
        .send({ source: 'orb_text', content: 'I had a great workout today' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toBeDefined();
      expect(res.body.category_key).toBe('health');
    });
  });

  // ----------------------------------------------------------
  // GET /memory/context
  // ----------------------------------------------------------

  describe('GET /context', () => {
    it('401 when no auth', async () => {
      const res = await request(app).get('/memory/context');
      expect(res.status).toBe(401);
    });

    it('400 when limit is out of range', async () => {
      const res = await request(app)
        .get('/memory/context?limit=9999')
        .set('Authorization', AUTH);
      expect(res.status).toBe(400);
    });

    it('400 when categories contains invalid key', async () => {
      const res = await request(app)
        .get('/memory/context?categories=invalid_cat')
        .set('Authorization', AUTH);
      expect(res.status).toBe(400);
    });

    it('503 when RPC does not exist', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'function memory_get_context does not exist' },
      });
      const res = await request(app)
        .get('/memory/context')
        .set('Authorization', AUTH);
      expect(res.status).toBe(503);
    });

    it('200 with items array on success', async () => {
      mockRpc.mockResolvedValue({ data: [{ id: 'item-1', content: 'hello' }], error: null });
      const res = await request(app)
        .get('/memory/context')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.items)).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // POST /memory/retrieve
  // ----------------------------------------------------------

  describe('POST /retrieve', () => {
    const validBody = { intent: 'health', mode: 'summary' };

    it('401 when no auth', async () => {
      const res = await request(app).post('/memory/retrieve').send(validBody);
      expect(res.status).toBe(401);
    });

    it('400 when mode is invalid', async () => {
      const res = await request(app)
        .post('/memory/retrieve')
        .set('Authorization', AUTH)
        .send({ intent: 'health', mode: 'bad_mode' });
      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
    });

    it('400 when intent is invalid', async () => {
      const res = await request(app)
        .post('/memory/retrieve')
        .set('Authorization', AUTH)
        .send({ intent: 'bad_intent' });
      expect(res.status).toBe(400);
    });

    it('403 when RPC returns redacted=true with zero sources', async () => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          meta: {
            redacted: true,
            redactions: [{ field: 'diary', reason: 'no_grant' }],
            audit_id: 'audit-001',
            active_role: 'professional',
            sources: { diary_entries: 0, garden_nodes: 0, longevity_days: 0, community_recs: 0 },
          },
          data: {},
        },
        error: null,
      });
      const res = await request(app)
        .post('/memory/retrieve')
        .set('Authorization', AUTH)
        .send(validBody);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ACCESS_DENIED');
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          intent: 'health',
          mode: 'summary',
          meta: {
            redacted: false,
            redactions: [],
            audit_id: 'audit-002',
            active_role: 'community',
            sources: { diary_entries: 3, garden_nodes: 1, longevity_days: 0, community_recs: 0 },
          },
          data: {},
        },
        error: null,
      });
      const res = await request(app)
        .post('/memory/retrieve')
        .set('Authorization', AUTH)
        .send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // GET /memory/garden/progress
  // ----------------------------------------------------------

  describe('GET /garden/progress', () => {
    it('401 when no auth', async () => {
      const res = await request(app).get('/memory/garden/progress');
      expect(res.status).toBe(401);
    });

    it('200 with _placeholder when RPC does not exist', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'function memory_get_garden_progress does not exist' },
      });
      const res = await request(app)
        .get('/memory/garden/progress')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body._placeholder).toBe(true);
      expect(res.body.categories.personal_identity).toBeDefined();
      expect(res.body.categories.personal_identity.count).toBe(0);
      expect(Object.keys(res.body.categories)).toHaveLength(13);
    });

    it('200 with garden data on success', async () => {
      mockRpc
        .mockResolvedValueOnce({
          data: {
            ok: true,
            totals: { memories: 5 },
            categories: { health_wellness: { count: 5, progress: 0.5, label: 'Health & Wellness' } },
          },
          error: null,
        })
        .mockResolvedValueOnce({ data: { tenant_id: 't1', user_id: 'u1', active_role: 'community' }, error: null });
      const res = await request(app)
        .get('/memory/garden/progress')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // POST /memory/diary
  // ----------------------------------------------------------

  describe('POST /diary', () => {
    const validDiary = {
      entry_date: '2026-04-23',
      entry_type: 'free',
      raw_text: 'Today was a great day',
    };

    it('401 when no auth', async () => {
      const res = await request(app).post('/memory/diary').send(validDiary);
      expect(res.status).toBe(401);
    });

    it('400 when entry_date format is wrong', async () => {
      const res = await request(app)
        .post('/memory/diary')
        .set('Authorization', AUTH)
        .send({ ...validDiary, entry_date: '23-04-2026' });
      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
    });

    it('400 when entry_type is invalid', async () => {
      const res = await request(app)
        .post('/memory/diary')
        .set('Authorization', AUTH)
        .send({ ...validDiary, entry_type: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('400 when raw_text is empty', async () => {
      const res = await request(app)
        .post('/memory/diary')
        .set('Authorization', AUTH)
        .send({ ...validDiary, raw_text: '' });
      expect(res.status).toBe(400);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { id: 'diary-uuid', tenant_id: 't1', user_id: 'u1', active_role: 'community' },
        error: null,
      });
      const res = await request(app)
        .post('/memory/diary')
        .set('Authorization', AUTH)
        .send(validDiary);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toBe('diary-uuid');
    });
  });

  // ----------------------------------------------------------
  // GET /memory/diary
  // ----------------------------------------------------------

  describe('GET /diary', () => {
    it('401 when no auth', async () => {
      const res = await request(app).get('/memory/diary');
      expect(res.status).toBe(401);
    });

    it('200 with entries on success', async () => {
      mockRpc.mockResolvedValue({
        data: { entries: [{ id: 'e1', raw_text: 'hello' }], count: 1 },
        error: null,
      });
      const res = await request(app)
        .get('/memory/diary')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.count).toBe(1);
    });
  });

  // ----------------------------------------------------------
  // POST /memory/garden/extract
  // ----------------------------------------------------------

  describe('POST /garden/extract', () => {
    const validExtract = { diary_entry_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };

    it('401 when no auth', async () => {
      const res = await request(app).post('/memory/garden/extract').send(validExtract);
      expect(res.status).toBe(401);
    });

    it('400 when diary_entry_id is not a UUID', async () => {
      const res = await request(app)
        .post('/memory/garden/extract')
        .set('Authorization', AUTH)
        .send({ diary_entry_id: 'not-a-uuid' });
      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { nodes_created: 2, nodes_updated: 1, extracted_nodes: [] },
        error: null,
      });
      const res = await request(app)
        .post('/memory/garden/extract')
        .set('Authorization', AUTH)
        .send(validExtract);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.nodes_created).toBe(2);
    });
  });

  // ----------------------------------------------------------
  // GET /memory/garden/summary
  // ----------------------------------------------------------

  describe('GET /garden/summary', () => {
    it('401 when no auth', async () => {
      const res = await request(app).get('/memory/garden/summary');
      expect(res.status).toBe(401);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { habits: [], health_signals: [], values: [], goals: [], patterns: [], confidence_score: 72 },
        error: null,
      });
      const res = await request(app)
        .get('/memory/garden/summary')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.confidence_score).toBe(72);
    });
  });

  // ----------------------------------------------------------
  // POST /memory/quality/compute
  // ----------------------------------------------------------

  describe('POST /quality/compute', () => {
    it('401 when no auth', async () => {
      const res = await request(app).post('/memory/quality/compute').send({});
      expect(res.status).toBe(401);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, snapshot_id: 'snap-1', overall_quality_score: 65, confidence_band: 'Medium' },
        error: null,
      });
      const res = await request(app)
        .post('/memory/quality/compute')
        .set('Authorization', AUTH)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.overall_quality_score).toBe(65);
    });
  });

  // ----------------------------------------------------------
  // GET /memory/quality
  // ----------------------------------------------------------

  describe('GET /quality', () => {
    it('401 when no auth', async () => {
      const res = await request(app).get('/memory/quality');
      expect(res.status).toBe(401);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, has_snapshot: true, overall_quality_score: 55, confidence_band: 'Medium' },
        error: null,
      });
      const res = await request(app)
        .get('/memory/quality')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.band_definitions).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // POST /memory/confidence/adjust
  // ----------------------------------------------------------

  describe('POST /confidence/adjust', () => {
    const validBody = {
      memory_item_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      reason_code: 'USER_CONFIRMED',
    };

    it('401 when no auth', async () => {
      const res = await request(app).post('/memory/confidence/adjust').send(validBody);
      expect(res.status).toBe(401);
    });

    it('400 when reason_code is invalid', async () => {
      const res = await request(app)
        .post('/memory/confidence/adjust')
        .set('Authorization', AUTH)
        .send({ ...validBody, reason_code: 'INVALID_CODE' });
      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
    });

    it('400 when memory_item_id is not a UUID', async () => {
      const res = await request(app)
        .post('/memory/confidence/adjust')
        .set('Authorization', AUTH)
        .send({ memory_item_id: 'not-uuid', reason_code: 'USER_CONFIRMED' });
      expect(res.status).toBe(400);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, memory_item_id: validBody.memory_item_id, previous_confidence: 50, new_confidence: 65, delta: 15 },
        error: null,
      });
      const res = await request(app)
        .post('/memory/confidence/adjust')
        .set('Authorization', AUTH)
        .send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.new_confidence).toBe(65);
    });
  });

  // ----------------------------------------------------------
  // POST /memory/confidence/confirm
  // ----------------------------------------------------------

  describe('POST /confidence/confirm', () => {
    const validBody = { memory_item_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };

    it('401 when no auth', async () => {
      const res = await request(app).post('/memory/confidence/confirm').send(validBody);
      expect(res.status).toBe(401);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, memory_item_id: validBody.memory_item_id, previous_confidence: 40, new_confidence: 55, delta: 15 },
        error: null,
      });
      const res = await request(app)
        .post('/memory/confidence/confirm')
        .set('Authorization', AUTH)
        .send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // POST /memory/confidence/correct
  // ----------------------------------------------------------

  describe('POST /confidence/correct', () => {
    const validBody = { memory_item_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };

    it('401 when no auth', async () => {
      const res = await request(app).post('/memory/confidence/correct').send(validBody);
      expect(res.status).toBe(401);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, memory_item_id: validBody.memory_item_id, previous_confidence: 70, new_confidence: 50, delta: -20 },
        error: null,
      });
      const res = await request(app)
        .post('/memory/confidence/correct')
        .set('Authorization', AUTH)
        .send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // GET /memory/confidence/history/:id
  // ----------------------------------------------------------

  describe('GET /confidence/history/:id', () => {
    const validId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

    it('401 when no auth', async () => {
      const res = await request(app).get(`/memory/confidence/history/${validId}`);
      expect(res.status).toBe(401);
    });

    it('400 when id is not a valid UUID', async () => {
      const res = await request(app)
        .get('/memory/confidence/history/not-a-uuid')
        .set('Authorization', AUTH);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/format/i);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, memory_item_id: validId, history: [], history_count: 0 },
        error: null,
      });
      const res = await request(app)
        .get(`/memory/confidence/history/${validId}`)
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.history_count).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // GET /memory/context/trusted
  // ----------------------------------------------------------

  describe('GET /context/trusted', () => {
    it('401 when no auth', async () => {
      const res = await request(app).get('/memory/context/trusted');
      expect(res.status).toBe(401);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, items: [], filters: {}, count: 0 },
        error: null,
      });
      const res = await request(app)
        .get('/memory/context/trusted')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.count).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // POST /memory/confidence/decay
  // ----------------------------------------------------------

  describe('POST /confidence/decay', () => {
    it('401 when no auth', async () => {
      const res = await request(app).post('/memory/confidence/decay').send({});
      expect(res.status).toBe(401);
    });

    it('200 on success', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: true, decayed_count: 3, threshold_days: 30 },
        error: null,
      });
      const res = await request(app)
        .post('/memory/confidence/decay')
        .set('Authorization', AUTH)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.decayed_count).toBe(3);
    });
  });

  // ----------------------------------------------------------
  // GET /memory/source-trust
  // ----------------------------------------------------------

  describe('GET /source-trust', () => {
    it('401 when no auth', async () => {
      const res = await request(app).get('/memory/source-trust');
      expect(res.status).toBe(401);
    });

    it('200 with _fallback when table does not exist', async () => {
      mockFrom.mockReturnValue({
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({
            data: null,
            error: { message: 'relation "memory_source_trust" does not exist' },
          }),
        }),
      });
      const res = await request(app)
        .get('/memory/source-trust')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body._fallback).toBe(true);
      expect(Array.isArray(res.body.source_trust)).toBe(true);
      expect(res.body.source_trust.length).toBeGreaterThan(0);
    });

    it('200 with real data when table exists', async () => {
      const mockData = [{ source_type: 'user_explicit', trust_weight: 100, max_confidence: 95 }];
      mockFrom.mockReturnValue({
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({ data: mockData, error: null }),
        }),
      });
      const res = await request(app)
        .get('/memory/source-trust')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.source_trust).toEqual(mockData);
      expect(res.body._fallback).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // GET /memory/confidence/reasons
  // ----------------------------------------------------------

  describe('GET /confidence/reasons', () => {
    it('401 when no auth', async () => {
      const res = await request(app).get('/memory/confidence/reasons');
      expect(res.status).toBe(401);
    });

    it('200 with _fallback when table does not exist', async () => {
      mockFrom.mockReturnValue({
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({
              data: null,
              error: { message: 'relation "memory_confidence_reasons" does not exist' },
            }),
          }),
        }),
      });
      const res = await request(app)
        .get('/memory/confidence/reasons')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body._fallback).toBe(true);
      expect(Array.isArray(res.body.reasons)).toBe(true);
    });

    it('200 with real data when table exists', async () => {
      const mockReasons = [{ reason_code: 'USER_CONFIRMED', category: 'increase', delta_min: 5, delta_max: 15 }];
      mockFrom.mockReturnValue({
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: mockReasons, error: null }),
          }),
        }),
      });
      const res = await request(app)
        .get('/memory/confidence/reasons')
        .set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.reasons).toEqual(mockReasons);
    });
  });
});
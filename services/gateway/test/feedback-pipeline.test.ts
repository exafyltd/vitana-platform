/**
 * VTID-02047: Unified Feedback Pipeline — full integration test
 *
 * Simulates the complete multi-agent flow end-to-end through the gateway:
 *
 *   1. User submits a ticket via /api/v1/feedback/tickets
 *   2. Vitana off-domain detection picks the right specialist
 *   3. Specialist intake starts — ticket flips to 'interviewing'
 *   4. Intake turns are appended
 *   5. Intake completes — ticket flips to 'triaged'
 *   6. Classifier (server-side via RPC) sets kind/priority/surface
 *   7. Supervisor drafts an answer / spec / resolution
 *   8. Supervisor approves / sends → in_progress / resolved
 *   9. User confirms → user_confirmed
 *  10. Reopen path verified
 *
 * Each route is exercised with mocked Supabase + OASIS so the test runs
 * fast and deterministically. The handoff event writes are verified.
 * The status ladder transitions are verified. The OASIS event types
 * are verified.
 */

import express, { Express } from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks (must come before route imports)
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE = 'test-service';

// In-memory store backing the mocked Supabase + REST writes
const store: {
  tickets: Map<string, Record<string, any>>;
  handoff_events: Array<Record<string, any>>;
  oasis_events: Array<Record<string, any>>;
} = {
  tickets: new Map(),
  handoff_events: [],
  oasis_events: [],
};

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_VITANA_ID = '@testuser123';

function makeJwt(sub: string): string {
  // Unsigned mock JWT — only `sub` matters; route decodes payload manually.
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64');
  return `${header}.${payload}.sig`;
}

const TEST_TOKEN = makeJwt(TEST_USER_ID);

// Build a minimal mock Supabase client that covers .from().select()/insert()/
// update()/delete()/eq()/in()/order()/limit()/maybeSingle()/single()/rpc().

function makeMockClient() {
  function buildQuery(table: string) {
    const filters: Array<{ col: string; op: string; val: any }> = [];
    let updateData: Record<string, any> | null = null;
    let insertData: Record<string, any> | null = null;
    let isSelect = false;
    let isCount = false;
    const q: any = {
      select() { isSelect = true; return q; },
      insert(d: Record<string, any>) { insertData = d; return q; },
      update(d: Record<string, any>) { updateData = d; return q; },
      eq(col: string, val: any) { filters.push({ col, op: 'eq', val }); return q; },
      in(col: string, vals: any[]) { filters.push({ col, op: 'in', val: vals }); return q; },
      not(col: string, op: string, val: any) { filters.push({ col, op: `not-${op}`, val }); return q; },
      gte(col: string, val: any) { filters.push({ col, op: 'gte', val }); return q; },
      lt(col: string, val: any) { filters.push({ col, op: 'lt', val }); return q; },
      order() { return q; },
      limit() { return q; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(resolve: any) { return run(false).then(resolve); },
    };
    function applyFilters(rows: Array<Record<string, any>>): Array<Record<string, any>> {
      return rows.filter(r => {
        for (const f of filters) {
          if (f.op === 'eq' && r[f.col] !== f.val) return false;
          if (f.op === 'in' && !f.val.includes(r[f.col])) return false;
          if (f.op === 'gte' && new Date(r[f.col]).getTime() < new Date(f.val).getTime()) return false;
          if (f.op === 'lt' && new Date(r[f.col]).getTime() >= new Date(f.val).getTime()) return false;
        }
        return true;
      });
    }
    function uuid() {
      // Deterministic-ish UUID v4 shape — passes z.string().uuid() validation
      const hex = () => Math.floor(Math.random() * 16).toString(16);
      const block = (n: number) => Array.from({ length: n }, hex).join('');
      return `${block(8)}-${block(4)}-4${block(3)}-a${block(3)}-${block(12)}`;
    }
    async function run(single: boolean) {
      if (table === 'feedback_tickets') {
        if (insertData) {
          const id = uuid();
          const ticket_number = `FB-2026-04-${String(store.tickets.size + 1).padStart(6, '0')}`;
          const row = {
            id,
            ticket_number,
            status: insertData.status ?? 'new',
            kind: insertData.kind ?? 'feedback',
            priority: 'p2',
            created_at: new Date().toISOString(),
            ...insertData,
          };
          store.tickets.set(id, row);
          return { data: row, error: null };
        }
        if (updateData) {
          const rows = applyFilters(Array.from(store.tickets.values()));
          if (rows.length === 0) return { data: null, error: { message: 'no row matched' } };
          const updated = { ...rows[0], ...updateData };
          store.tickets.set(updated.id, updated);
          return single ? { data: updated, error: null } : { data: [updated], error: null };
        }
        if (isSelect) {
          const rows = applyFilters(Array.from(store.tickets.values()));
          if (single) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }
      }
      if (table === 'app_users') {
        if (filters.find(f => f.col === 'user_id' && f.val === TEST_USER_ID)) {
          return { data: { vitana_id: TEST_VITANA_ID }, error: null };
        }
        return { data: null, error: null };
      }
      if (table === 'agent_personas') {
        const PERSONAS: Record<string, any> = {
          devon: { key: 'devon', display_name: 'Devon', role: 'Tech support', voice_id: null, system_prompt: 'devon prompt', max_questions: 6, max_duration_seconds: 240, intake_schema_ref: 'bug', handles_kinds: ['bug','ux_issue'] },
          sage: { key: 'sage', display_name: 'Sage', role: 'Customer support', voice_id: null, system_prompt: 'sage prompt', max_questions: 6, max_duration_seconds: 240, intake_schema_ref: 'support_question', handles_kinds: ['support_question'] },
          atlas: { key: 'atlas', display_name: 'Atlas', role: 'Finance', voice_id: null, system_prompt: 'atlas prompt', max_questions: 6, max_duration_seconds: 240, intake_schema_ref: 'marketplace_claim', handles_kinds: ['marketplace_claim'] },
          mira: { key: 'mira', display_name: 'Mira', role: 'Account', voice_id: null, system_prompt: 'mira prompt', max_questions: 6, max_duration_seconds: 240, intake_schema_ref: 'account_issue', handles_kinds: ['account_issue'] },
        };
        const keyFilter = filters.find(f => f.col === 'key');
        if (keyFilter && PERSONAS[keyFilter.val]) {
          return { data: PERSONAS[keyFilter.val], error: null };
        }
        return { data: null, error: null };
      }
      return { data: single ? null : [], error: null };
    }
    return q;
  }

  return {
    from(table: string) { return buildQuery(table); },
    rpc(fn: string, args: Record<string, any>) {
      if (fn === 'pick_specialist_for_text') {
        const text = (args?.p_text ?? '').toLowerCase();
        if (/(bug|broken|crash|error)/.test(text)) {
          return Promise.resolve({ data: { persona_key: 'devon', matched_keyword: 'bug', score: 1, confidence: 0.5 }, error: null });
        }
        if (/(how do i|how to|where is|help)/.test(text)) {
          return Promise.resolve({ data: { persona_key: 'sage', matched_keyword: 'how do i', score: 1, confidence: 0.5 }, error: null });
        }
        if (/(refund|order|payment)/.test(text)) {
          return Promise.resolve({ data: { persona_key: 'atlas', matched_keyword: 'refund', score: 1, confidence: 0.5 }, error: null });
        }
        if (/(login|password|account)/.test(text)) {
          return Promise.resolve({ data: { persona_key: 'mira', matched_keyword: 'login', score: 1, confidence: 0.5 }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(() => makeMockClient()),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => makeMockClient()),
}));

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  resolveVitanaId: jest.fn().mockResolvedValue(TEST_VITANA_ID),
}));

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockImplementation((event) => {
    store.oasis_events.push(event);
    return Promise.resolve({ ok: true, event_id: 'mock' });
  }),
}));

// Mock the global fetch used for handoff-event service-role inserts
global.fetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
  if (typeof url === 'string' && url.includes('/rest/v1/feedback_handoff_events')) {
    const body = JSON.parse(opts.body);
    store.handoff_events.push(body);
    return { ok: true, json: async () => ({}) };
  }
  return { ok: true, json: async () => ({}) };
}) as any;

// ---------------------------------------------------------------------------
// Build an Express app with all four feedback routers wired
// ---------------------------------------------------------------------------

import feedbackRouter from '../src/routes/feedback';
import feedbackIntakeRouter from '../src/routes/feedback-intake';
import feedbackAdminRouter from '../src/routes/feedback-admin';
import { adminRouter as feedbackActionsAdmin, userRouter as feedbackActionsUser } from '../src/routes/feedback-actions';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/feedback/tickets', feedbackRouter);
  app.use('/api/v1/feedback/intake', feedbackIntakeRouter);
  app.use('/api/v1/admin/feedback', feedbackAdminRouter);
  app.use('/api/v1/admin/feedback', feedbackActionsAdmin);
  app.use('/api/v1/feedback/tickets', feedbackActionsUser);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VTID-02047 Unified Feedback Pipeline — full lifecycle', () => {
  let app: Express;

  beforeEach(() => {
    store.tickets.clear();
    store.handoff_events.length = 0;
    store.oasis_events.length = 0;
    app = makeApp();
  });

  test('user can create a ticket via POST /tickets and read it back via /mine', async () => {
    const create = await request(app)
      .post('/api/v1/feedback/tickets')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ raw_text: 'I love the new design', kind: 'feedback' });
    expect(create.status).toBe(201);
    expect(create.body.ok).toBe(true);
    expect(create.body.ticket_number).toMatch(/^FB-2026-04-\d{6}$/);
    expect(create.body.status).toBe('new');

    const list = await request(app)
      .get('/api/v1/feedback/tickets/mine')
      .set('Authorization', `Bearer ${TEST_TOKEN}`);
    expect(list.status).toBe(200);
    expect(list.body.tickets).toHaveLength(1);
  });

  test('handoff-detect routes a bug opener to Devon', async () => {
    const r = await request(app)
      .post('/api/v1/feedback/intake/handoff-detect')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ text: 'the diary screen crashed' });
    expect(r.status).toBe(200);
    expect(r.body.handoff).toBe(true);
    expect(r.body.persona_key).toBe('devon');
    expect(r.body.suggested_kind).toBe('bug');
  });

  test('handoff-detect returns vitana for off-keyword text', async () => {
    const r = await request(app)
      .post('/api/v1/feedback/intake/handoff-detect')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ text: 'tell me about longevity' });
    expect(r.status).toBe(200);
    expect(r.body.handoff).toBe(false);
    expect(r.body.persona_key).toBe('vitana');
  });

  test('full bug-fix lifecycle: handoff → intake → triage → spec → approve → resolve → confirm', async () => {
    // 1. User mentions a bug — handoff detected
    const detect = await request(app)
      .post('/api/v1/feedback/intake/handoff-detect')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ text: 'the diary screen crashed when I tried to upload a photo' });
    expect(detect.body.persona_key).toBe('devon');

    // 2. Start intake — ticket created in 'interviewing' status, handoff event logged
    const start = await request(app)
      .post('/api/v1/feedback/intake/start')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({
        to_persona: 'devon',
        initial_user_text: 'the diary screen crashed when I tried to upload a photo',
        screen_path: '/comm/diary',
        matched_keyword: detect.body.matched_keyword,
        confidence: detect.body.confidence,
      });
    expect(start.status).toBe(201);
    const ticketId = start.body.ticket_id;
    expect(start.body.persona.key).toBe('devon');
    expect(store.handoff_events).toHaveLength(1);
    expect(store.handoff_events[0].from_agent).toBe('vitana');
    expect(store.handoff_events[0].to_agent).toBe('devon');
    expect(store.handoff_events[0].reason).toBe('off_domain_intent');

    // 3. Append an intake turn from Devon
    const turn = await request(app)
      .post('/api/v1/feedback/intake/turn')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ ticket_id: ticketId, agent: 'devon', role: 'assistant', content: 'Walk me through what happened.' });
    expect(turn.status).toBe(200);
    expect(turn.body.turn_count).toBe(2);  // initial + Devon's question

    // 4. Complete intake — ticket flips to 'triaged'
    const complete = await request(app)
      .post('/api/v1/feedback/intake/complete')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({
        ticket_id: ticketId,
        structured_fields: { what_happened: 'crash on photo upload', screen: 'diary', frequency: 'every time' },
        resolver_persona: 'devon',
      });
    expect(complete.status).toBe(200);
    expect(complete.body.status).toBe('triaged');
    expect(store.handoff_events).toHaveLength(2);
    expect(store.handoff_events[1].reason).toBe('wrap_back');

    // 5. Supervisor drafts a spec → spec_ready
    const draft = await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/draft-spec`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ notes: 'Likely an iOS WebView photo-picker issue.' });
    expect(draft.status).toBe(200);
    expect(draft.body.ticket.status).toBe('spec_ready');
    expect(draft.body.ticket.kind).toBe('bug');

    // 6. Supervisor approves → in_progress
    const approve = await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/approve`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.ticket.status).toBe('in_progress');

    // 7. Supervisor manually resolves → resolved
    const resolve = await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/resolve`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    expect(resolve.status).toBe(200);
    expect(resolve.body.ticket.status).toBe('resolved');

    // 8. User confirms → user_confirmed
    const confirm = await request(app)
      .post(`/api/v1/feedback/tickets/${ticketId}/confirm`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    expect(confirm.status).toBe(200);
    expect(confirm.body.ticket.status).toBe('user_confirmed');

    // 9. Verify OASIS event types fired across the lifecycle
    const types = store.oasis_events.map(e => e.type);
    expect(types).toContain('feedback.handoff.started');
    expect(types).toContain('feedback.handoff.completed');
    expect(types).toContain('feedback.ticket.status_changed');
    expect(types).toContain('feedback.ticket.resolved');
    expect(types).toContain('feedback.ticket.user_confirmed');
  });

  test('support-question lifecycle: Sage drafts answer → supervisor sends', async () => {
    const start = await request(app)
      .post('/api/v1/feedback/intake/start')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ to_persona: 'sage', initial_user_text: 'how do I find my profile' });
    const ticketId = start.body.ticket_id;

    await request(app)
      .post('/api/v1/feedback/intake/complete')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ ticket_id: ticketId, structured_fields: { question_summary: 'find profile' } });

    const draft = await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/draft-answer`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    expect(draft.body.ticket.status).toBe('answer_ready');

    const send = await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/send-answer`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    expect(send.body.ticket.status).toBe('resolved');
  });

  test('rejection path: supervisor rejects a ticket with reason', async () => {
    const create = await request(app)
      .post('/api/v1/feedback/tickets')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ raw_text: 'asdfasdf', kind: 'feedback' });
    const ticketId = create.body.id;

    const reject = await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/reject`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ reason: 'gibberish' });
    expect(reject.status).toBe(200);
    expect(reject.body.ticket.status).toBe('rejected');
  });

  test('reopen path: confirmed ticket can be reopened by the user with priority bump', async () => {
    const create = await request(app)
      .post('/api/v1/feedback/tickets')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ raw_text: 'bug X', kind: 'bug' });
    const ticketId = create.body.id;

    // Manually walk to user_confirmed so reopen is valid
    await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/draft-spec`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/approve`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    await request(app)
      .post(`/api/v1/admin/feedback/tickets/${ticketId}/resolve`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    await request(app)
      .post(`/api/v1/feedback/tickets/${ticketId}/confirm`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});

    // Now reopen
    const reopen = await request(app)
      .post(`/api/v1/feedback/tickets/${ticketId}/reopen`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({});
    expect(reopen.status).toBe(200);
    expect(reopen.body.ticket.status).toBe('reopened');
  });

  test('mark-duplicate links to canonical', async () => {
    const a = await request(app)
      .post('/api/v1/feedback/tickets')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ raw_text: 'bug', kind: 'bug' });
    const b = await request(app)
      .post('/api/v1/feedback/tickets')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ raw_text: 'same bug', kind: 'bug' });

    const dup = await request(app)
      .post(`/api/v1/admin/feedback/tickets/${b.body.id}/mark-duplicate`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ duplicate_of: a.body.id });
    expect(dup.status).toBe(200);
    expect(dup.body.ticket.status).toBe('duplicate');
    expect(dup.body.ticket.duplicate_of).toBe(a.body.id);
  });

  test('all routes return 401 without Bearer token', async () => {
    const probes = [
      { m: 'post' as const, p: '/api/v1/feedback/tickets' },
      { m: 'get' as const, p: '/api/v1/feedback/tickets/mine' },
      { m: 'post' as const, p: '/api/v1/feedback/intake/handoff-detect' },
      { m: 'post' as const, p: '/api/v1/feedback/intake/start' },
      { m: 'post' as const, p: '/api/v1/feedback/intake/turn' },
      { m: 'post' as const, p: '/api/v1/feedback/intake/complete' },
      { m: 'get' as const, p: '/api/v1/admin/feedback/tickets' },
      { m: 'post' as const, p: '/api/v1/admin/feedback/tickets/abc/draft-spec' },
      { m: 'post' as const, p: '/api/v1/admin/feedback/tickets/abc/approve' },
      { m: 'post' as const, p: '/api/v1/feedback/tickets/abc/confirm' },
    ];
    for (const probe of probes) {
      const r = await (request(app) as any)[probe.m](probe.p).send({});
      expect(r.status).toBe(401);
    }
  });
});

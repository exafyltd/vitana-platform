/**
 * VTID-04478 — HTTP tests for /api/v1/partner-onboarding.
 *
 * Contract: POST /start (email required, idempotent per user + type while in
 * draft), GET /:orgId (org_admin only, checklist), PATCH /:orgId/company
 * (locked once submitted), POST /:orgId/terms/accept (current version only,
 * recorded once), POST /:orgId/submit (prerequisites, guarded transitions,
 * one OASIS event per move).
 */

import express from 'express';
import request from 'supertest';

const OWNER = 'owner-1';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const byToken: Record<string, any> = {
      'Bearer owner-1': { user_id: 'owner-1', email: 'owner@example.com', exafy_admin: false },
      'Bearer other-1': { user_id: 'other-1', email: 'x@example.com', exafy_admin: false },
      'Bearer no-email': { user_id: 'no-email-1', email: null, exafy_admin: false },
    };
    const id = byToken[req.headers.authorization];
    if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = id;
    return next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));
jest.mock('../src/services/email/partner-invite-email', () => {
  const actual = jest.requireActual('../src/services/email/partner-invite-email');
  return { ...actual, sendPartnerInviteEmail: jest.fn().mockResolvedValue({ sent: false, status: 'disabled' }) };
});

type Call = { table: string; op: string; args: any[]; filters: Array<[string, any]>; terminal: string };
let handlers: Record<string, (c: Call) => any>;
let calls: Call[];

function makeFakeSupabase() {
  return {
    from(table: string) {
      let op = 'select';
      let args: any[] = [];
      const filters: Array<[string, any]> = [];
      const run = (terminal: string) => {
        const call = { table, op, args, filters, terminal };
        calls.push(call);
        const h = handlers[table];
        if (!h) throw new Error(`Unexpected table in test: ${table}`);
        return Promise.resolve(h(call));
      };
      const chain: any = {};
      chain.eq = (col: string, val: any) => { filters.push([col, val]); return chain; };
      for (const m of ['order', 'limit', 'in']) chain[m] = () => chain;
      chain.select = (...a: any[]) => { if (op === 'select') args = a; return chain; };
      chain.insert = (...a: any[]) => { op = 'insert'; args = a; return chain; };
      chain.update = (...a: any[]) => { op = 'update'; args = a; return chain; };
      chain.maybeSingle = () => run('maybeSingle');
      chain.single = () => run('single');
      chain.then = (res: any, rej: any) => run('then').then(res, rej);
      return chain;
    },
  };
}
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => makeFakeSupabase() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/partner-onboarding').default;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/partner-onboarding', router);
  return a;
}

function org(over: Record<string, any> = {}) {
  return {
    id: 'org-1', org_key: 'acme-abc123', display_name: 'Acme', partner_type: 'supplier_shop', commerce_vertical: 'general',
    lifecycle_state: 'draft', status: 'pending_review', trust_level: 0, legal_name: null, country: null, vat_id: null,
    website: null, owner_user_id: OWNER, created_at: '2026-09-24T00:00:00Z', ...over,
  };
}

/** Wires the tables a full state read touches. `state` is mutated by updates. */
function wireOrg(state: Record<string, any>, extra: { steps?: any[]; terms?: string[]; admin?: boolean } = {}) {
  handlers.partner_organizations = (c) => {
    if (c.op === 'update') {
      const guard = c.filters.find(([k]) => k === 'lifecycle_state');
      if (guard && guard[1] !== state.lifecycle_state) return { data: [], error: null };
      Object.assign(state, c.args[0]);
      return { data: [{ id: state.id }], error: null };
    }
    return { data: { ...state }, error: null };
  };
  handlers.partner_organization_members = (c) =>
    c.terminal === 'maybeSingle'
      ? { data: extra.admin === false ? null : { role: 'org_admin' }, error: null }
      : { data: null, count: 1, error: null };
  handlers.partner_onboarding_steps = () => ({ data: extra.steps ?? [], error: null });
  handlers.partner_terms_acceptances = (c) =>
    c.op === 'insert' ? { data: null, error: null } : { data: (extra.terms ?? []).map((v) => ({ terms_version: v })), error: null };
}

const COMPANY = { legal_name: 'Acme GmbH', country: 'DE', vat_id: 'DE123456789', website: 'https://acme.example/' };

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  calls = [];
  process.env.PARTNER_TERMS_VERSION = '2026-09';
});

describe('mount', () => {
  it('401 JSON without a token', async () => {
    const r = await request(app()).post('/api/v1/partner-onboarding/start').send({});
    expect(r.status).toBe(401);
    expect(r.type).toBe('application/json');
  });
});

describe('POST /start', () => {
  it('requires an account email', async () => {
    const r = await request(app()).post('/api/v1/partner-onboarding/start').set('Authorization', 'Bearer no-email')
      .send({ partner_type: 'lab', display_name: 'Lab' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ACCOUNT_EMAIL_REQUIRED');
  });

  it('rejects an unknown partner type', async () => {
    const r = await request(app()).post('/api/v1/partner-onboarding/start').set('Authorization', 'Bearer owner-1')
      .send({ partner_type: 'bank', display_name: 'X' });
    expect(r.status).toBe(400);
  });

  it('creates a draft org with the caller as org_admin and emits onboarding_started', async () => {
    const state = org();
    let inserted: any = null;
    wireOrg(state);
    const base = handlers.partner_organizations;
    handlers.partner_organizations = (c) => {
      if (c.terminal === 'maybeSingle' && c.filters.some(([k]) => k === 'owner_user_id')) return { data: null, error: null };
      if (c.op === 'insert') { inserted = c.args[0]; return { data: { id: 'org-1' }, error: null }; }
      return base(c);
    };
    let member: any = null;
    const baseMembers = handlers.partner_organization_members;
    handlers.partner_organization_members = (c) => { if (c.op === 'insert') { member = c.args[0]; return { data: null, error: null }; } return baseMembers(c); };

    const r = await request(app()).post('/api/v1/partner-onboarding/start').set('Authorization', 'Bearer owner-1')
      .send({ partner_type: 'supplier_shop', display_name: 'Acme Shop' });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    expect(inserted).toMatchObject({ partner_type: 'supplier_shop', lifecycle_state: 'draft', owner_user_id: OWNER });
    expect(inserted.org_key).toMatch(/^acme-shop-[0-9a-f]{6}$/);
    expect(member).toMatchObject({ user_id: OWNER, role: 'org_admin' });
    expect(r.body.checklist.next_step).toBe('company');
    expect(r.body.organization).not.toHaveProperty('owner_user_id');
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.onboarding_started' }));
  });

  it('returns the existing draft for the same user and type instead of creating another', async () => {
    const state = org();
    wireOrg(state);
    const r = await request(app()).post('/api/v1/partner-onboarding/start').set('Authorization', 'Bearer owner-1')
      .send({ partner_type: 'supplier_shop', display_name: 'Acme' });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(false);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });
});

describe('GET /:orgId', () => {
  it('is org_admin only', async () => {
    wireOrg(org(), { admin: false });
    const r = await request(app()).get('/api/v1/partner-onboarding/org-1').set('Authorization', 'Bearer other-1');
    expect(r.status).toBe(403);
  });

  it('returns the org and its checklist', async () => {
    wireOrg(org(COMPANY), { terms: ['2026-09'], steps: [{ step_key: 'catalogue', status: 'done' }] });
    const r = await request(app()).get('/api/v1/partner-onboarding/org-1').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.checklist.submit_ready).toBe(true);
    expect(r.body.checklist.next_step).toBe('verification');
    expect(r.body.checklist.steps.find((s: any) => s.key === 'catalogue').status).toBe('done');
  });
});

describe('PATCH /:orgId/company', () => {
  it('stores normalised facts while the org is a draft', async () => {
    const state = org();
    wireOrg(state);
    const r = await request(app()).patch('/api/v1/partner-onboarding/org-1/company').set('Authorization', 'Bearer owner-1')
      .send({ legal_name: 'Acme GmbH', country: 'de' });
    expect(r.status).toBe(200);
    expect(state).toMatchObject({ legal_name: 'Acme GmbH', country: 'DE' });
  });

  it('is locked once the org is submitted or live', async () => {
    wireOrg(org({ lifecycle_state: 'live' }));
    const r = await request(app()).patch('/api/v1/partner-onboarding/org-1/company').set('Authorization', 'Bearer owner-1')
      .send({ legal_name: 'Other' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('COMPANY_LOCKED');
  });

  it('rejects an invalid fact', async () => {
    wireOrg(org());
    const r = await request(app()).patch('/api/v1/partner-onboarding/org-1/company').set('Authorization', 'Bearer owner-1')
      .send({ country: 'Germany' });
    expect(r.status).toBe(400);
  });
});

describe('POST /:orgId/terms/accept', () => {
  it('503 when no terms are published', async () => {
    delete process.env.PARTNER_TERMS_VERSION;
    wireOrg(org());
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .send({ terms_version: '2026-09' });
    expect(r.status).toBe(503);
  });

  it('409 when accepting a version other than the one in force', async () => {
    wireOrg(org());
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .send({ terms_version: '2026-01' });
    expect(r.status).toBe(409);
    expect(r.body.current_version).toBe('2026-09');
  });

  it('records who accepted which version, with IP and user agent, and emits terms_accepted', async () => {
    let row: any = null;
    wireOrg(org());
    handlers.partner_terms_acceptances = (c) => {
      if (c.op === 'insert') { row = c.args[0]; return { data: null, error: null }; }
      return { data: [{ terms_version: '2026-09' }], error: null };
    };
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .set('User-Agent', 'jest-agent').send({ terms_version: '2026-09' });
    expect(r.status).toBe(200);
    expect(row).toMatchObject({ partner_organization_id: 'org-1', terms_version: '2026-09', accepted_by: OWNER, user_agent: 'jest-agent' });
    expect(typeof row.ip_address).toBe('string');
    expect(r.body.checklist.steps.find((s: any) => s.key === 'terms').status).toBe('done');
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.terms_accepted' }));
  });

  it('treats a second acceptance of the same version as already done', async () => {
    wireOrg(org(), { terms: ['2026-09'] });
    handlers.partner_terms_acceptances = (c) =>
      c.op === 'insert' ? { data: null, error: { code: '23505', message: 'dup' } } : { data: [{ terms_version: '2026-09' }], error: null };
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .send({ terms_version: '2026-09' });
    expect(r.status).toBe(200);
    expect(r.body.already_accepted).toBe(true);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});

describe('POST /:orgId/submit', () => {
  it('409 with the missing prerequisites and no transition', async () => {
    wireOrg(org());
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/submit').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(409);
    expect(r.body.missing).toEqual(['company', 'terms']);
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('moves draft -> submitted -> verifying -> needs_action and names the open steps', async () => {
    const state = org(COMPANY);
    wireOrg(state, { terms: ['2026-09'] });
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/submit').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.transitions).toEqual([
      { from: 'draft', to: 'submitted' },
      { from: 'submitted', to: 'verifying' },
      { from: 'verifying', to: 'needs_action' },
    ]);
    expect(state.lifecycle_state).toBe('needs_action');
    expect(r.body.open_steps).toEqual(['verification', 'catalogue', 'mapping', 'tracking_test', 'billing_mandate']);
    const events = emitOasisEventMock.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.type)).toEqual(Array(3).fill('partner_org.lifecycle_changed'));
    expect(events[2].payload).toMatchObject({ from: 'verifying', to: 'needs_action', open_steps: r.body.open_steps });
    // Every update was guarded on the state it left.
    const updates = calls.filter((c) => c.op === 'update');
    expect(updates.map((u) => u.filters.find(([k]) => k === 'lifecycle_state')![1])).toEqual(['draft', 'submitted', 'verifying']);
  });

  it('goes live with no admin call when every required step is done', async () => {
    const state = org({ ...COMPANY, partner_type: 'affiliate_brand' });
    wireOrg(state, {
      terms: ['2026-09'],
      steps: ['verification', 'catalogue', 'mapping', 'tracking_test'].map((k) => ({ step_key: k, status: 'done' })),
    });
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/submit').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(state.lifecycle_state).toBe('live');
    expect(r.body.transitions[r.body.transitions.length - 1]).toEqual({ from: 'verifying', to: 'live' });
  });

  it('re-submits from needs_action', async () => {
    const state = org({ ...COMPANY, lifecycle_state: 'needs_action' });
    wireOrg(state, { terms: ['2026-09'] });
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/submit').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.transitions[0]).toEqual({ from: 'needs_action', to: 'verifying' });
  });

  it('refuses from a state that cannot submit', async () => {
    wireOrg(org({ ...COMPANY, lifecycle_state: 'live' }), { terms: ['2026-09'] });
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/submit').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NOT_SUBMITTABLE');
  });

  it('stops with 409 when another request moved the org first', async () => {
    const state = org(COMPANY);
    wireOrg(state, { terms: ['2026-09'] });
    const base = handlers.partner_organizations;
    handlers.partner_organizations = (c) => (c.op === 'update' ? { data: [], error: null } : base(c));
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/submit').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('CONCURRENT_UPDATE');
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});

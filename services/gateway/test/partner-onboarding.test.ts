/**
 * VTID-04478 — HTTP tests for /api/v1/partner-onboarding.
 *
 * Contract: POST /start (email required, idempotent per user + type while in
 * draft), GET /:orgId (org_admin only, checklist), PATCH /:orgId/company
 * (locked once submitted), POST /:orgId/terms/accept (current version only,
 * recorded once), POST /:orgId/submit (prerequisites, guarded transitions,
 * one OASIS event per move).
 *
 * VTID-04895: the terms in force are the published partner_terms_versions row
 * (no env var). Acceptance needs the exact version, its content hash and the
 * language shown, and only the supplier's own session — an assistant's
 * delegated OAuth token is refused.
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
    // VTID-04895: the verified token's claims, as requireAuth exposes them.
    const claimsByToken: Record<string, any> = {
      'Bearer owner-1': { sub: 'owner-1', session_id: 'sess-owner' },
      'Bearer owner-oauth-claim': { sub: 'owner-1', session_id: 'sess-owner', client_id: 'claude-client' },
      'Bearer owner-oauth-session': { sub: 'owner-1', session_id: 'sess-oauth' },
      'Bearer owner-no-session': { sub: 'owner-1' },
    };
    const auth = req.headers.authorization;
    const id = byToken[auth] ?? (claimsByToken[auth] ? byToken['Bearer owner-1'] : undefined);
    if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = id;
    req.auth_raw_claims = claimsByToken[auth] ?? { sub: id.user_id, session_id: `sess-${id.user_id}` };
    return next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));
const detectPlatformMock = jest.fn();
jest.mock('../src/services/platform-detect', () => ({ detectPlatform: (...a: any[]) => detectPlatformMock(...a) }));
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
    // VTID-04895: auth_session_is_delegated — sess-oauth belongs to an OAuth client.
    rpc(name: string, args: any) {
      calls.push({ table: `rpc:${name}`, op: 'rpc', args: [args], filters: [], terminal: 'rpc' });
      if (name !== 'auth_session_is_delegated') return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
      const verdict = args.p_session_id === 'sess-oauth' ? 'delegated' : String(args.p_session_id).startsWith('sess-') ? 'direct' : 'unknown';
      return Promise.resolve({ data: verdict, error: null });
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

/** VTID-04895: the published terms version (null = none published). */
const TERMS_V = {
  id: 'tv-2026-09', version: '2026-09', baseline_version_id: 'tv-2026-09', content_sha256: 'hash-2026-09',
  requires_reacceptance: true, published_at: '2026-10-05T00:00:00Z',
  content: { en: { title: 'Partner Terms', body_md: 'Binding text' }, de: { title: 'Partnerbedingungen', body_md: 'Übersetzung' } },
};
let publishedTerms: typeof TERMS_V | null;
const ACCEPT = { terms_version: '2026-09', content_sha256: 'hash-2026-09', shown_locale: 'en' };

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  calls = [];
  publishedTerms = TERMS_V;
  handlers.partner_terms_versions = (c) =>
    c.terminal === 'maybeSingle'
      ? { data: publishedTerms, error: null }
      : { data: publishedTerms ? [{ version: publishedTerms.version }] : [], error: null };
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
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'partner_org.company_updated',
      payload: { partner_organization_id: 'org-1', fields: ['legal_name', 'country'] },
    }));
  });

  it('is locked once the org is submitted or live', async () => {
    wireOrg(org({ lifecycle_state: 'live' }));
    const r = await request(app()).patch('/api/v1/partner-onboarding/org-1/company').set('Authorization', 'Bearer owner-1')
      .send({ legal_name: 'Other' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('COMPANY_LOCKED');
    expect(emitOasisEventMock).not.toHaveBeenCalled();
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
    publishedTerms = null;
    wireOrg(org());
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .send(ACCEPT);
    expect(r.status).toBe(503);
  });

  it('the terms table missing (migration not applied yet) reads as not published, never an error', async () => {
    delete handlers.partner_terms_versions; // the fake throws for an unknown table
    wireOrg(org());
    const r = await request(app()).get('/api/v1/partner-onboarding/org-1').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.checklist.steps.find((s: any) => s.key === 'terms')).toMatchObject({ status: 'todo', missing: ['terms_not_published'] });
  });

  it.each([
    ['an OAuth client_id claim (assistant token)', 'Bearer owner-oauth-claim'],
    ['a session created for an OAuth client', 'Bearer owner-oauth-session'],
    ['a token without a session', 'Bearer owner-no-session'],
  ])('refuses %s: only the supplier accepts, never an assistant', async (_label, token) => {
    let inserted = false;
    wireOrg(org());
    handlers.partner_terms_acceptances = (c) => { if (c.op === 'insert') inserted = true; return { data: [], error: null }; };
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', token).send(ACCEPT);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('TERMS_ACCEPTANCE_REQUIRES_SUPPLIER');
    expect(inserted).toBe(false);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('409 when the text accepted is not the text published (content hash)', async () => {
    wireOrg(org());
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .send({ ...ACCEPT, content_sha256: 'hash-of-an-older-text' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('TERMS_CONTENT_MISMATCH');
  });

  it('400 for a shown_locale that is not en or en+<language>', async () => {
    wireOrg(org());
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .send({ ...ACCEPT, shown_locale: 'de' });
    expect(r.status).toBe(400);
  });

  it('a version published between reading and accepting is refused by the database as stale (409)', async () => {
    wireOrg(org());
    handlers.partner_terms_acceptances = (c) =>
      c.op === 'insert' ? { data: null, error: { code: 'P0001', message: 'PARTNER_TERMS_VERSION_NOT_CURRENT' } } : { data: [], error: null };
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1').send(ACCEPT);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('TERMS_CONTENT_MISMATCH');
  });

  it('409 when accepting a version other than the one in force', async () => {
    wireOrg(org());
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .send({ ...ACCEPT, terms_version: '2026-01' });
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
      .set('User-Agent', 'jest-agent').send({ ...ACCEPT, shown_locale: 'en+de' });
    expect(r.status).toBe(200);
    // VTID-04895: business, user, exact version (string + id), content hash, language shown; time by default.
    expect(row).toMatchObject({
      partner_organization_id: 'org-1', terms_version: '2026-09', terms_version_id: 'tv-2026-09', content_sha256: 'hash-2026-09',
      shown_locale: 'en+de', accepted_by: OWNER, user_agent: 'jest-agent',
    });
    expect(typeof row.ip_address).toBe('string');
    expect(r.body.checklist.steps.find((s: any) => s.key === 'terms').status).toBe('done');
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'partner_org.terms_accepted',
      payload: expect.objectContaining({ terms_version_id: 'tv-2026-09', content_sha256: 'hash-2026-09', shown_locale: 'en+de' }),
    }));
    // The assistant check ran on the caller's own session.
    expect(calls.find((c) => c.table === 'rpc:auth_session_is_delegated')?.args[0]).toEqual({ p_session_id: 'sess-owner' });
  });

  it('treats a second acceptance of the same version as already done', async () => {
    wireOrg(org(), { terms: ['2026-09'] });
    handlers.partner_terms_acceptances = (c) =>
      c.op === 'insert' ? { data: null, error: { code: '23505', message: 'dup' } } : { data: [{ terms_version: '2026-09' }], error: null };
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/terms/accept').set('Authorization', 'Bearer owner-1')
      .send(ACCEPT);
    expect(r.status).toBe(200);
    expect(r.body.already_accepted).toBe(true);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});

describe('GET /:orgId/terms (VTID-04895)', () => {
  const read = (locale?: string) =>
    request(app()).get(`/api/v1/partner-onboarding/org-1/terms${locale ? `?locale=${locale}` : ''}`).set('Authorization', 'Bearer owner-1');

  it('nothing published', async () => {
    publishedTerms = null;
    wireOrg(org());
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ published: false, terms: null, accepted: false });
  });

  it('shows the English binding text, the German translation alongside, the version and its hash', async () => {
    wireOrg(org());
    const r = await read('de');
    expect(r.body.terms).toMatchObject({
      version: '2026-09', content_sha256: 'hash-2026-09', binding_locale: 'en',
      binding: { title: 'Partner Terms', body_md: 'Binding text' },
      translation: { locale: 'de', title: 'Partnerbedingungen' },
      shown_locale: 'en+de',
    });
    expect(r.body.accepted).toBe(false);
    expect(r.body.reacceptance_required).toBe(false);
  });

  it('English only when the caller language has no translation', async () => {
    wireOrg(org());
    const r = await read('fr');
    expect(r.body.terms.translation).toBeNull();
    expect(r.body.terms.shown_locale).toBe('en');
  });

  it('an acceptance of an earlier version with the same baseline (editorial update) still counts', async () => {
    wireOrg(org(), { terms: ['2026-08'] });
    handlers.partner_terms_versions = (c) =>
      c.terminal === 'maybeSingle' ? { data: TERMS_V, error: null } : { data: [{ version: '2026-08' }, { version: '2026-09' }], error: null };
    const r = await read();
    expect(r.body.accepted).toBe(true);
    const state = await request(app()).get('/api/v1/partner-onboarding/org-1').set('Authorization', 'Bearer owner-1');
    expect(state.body.checklist.steps.find((s: any) => s.key === 'terms').status).toBe('done');
  });

  it('an acceptance of an older baseline (material update) needs re-acceptance; the org stays as it is', async () => {
    const state = org({ ...COMPANY, lifecycle_state: 'live' });
    wireOrg(state, { terms: ['2026-01'] });
    const r = await read();
    expect(r.body).toMatchObject({ accepted: false, reacceptance_required: true });
    const s = await request(app()).get('/api/v1/partner-onboarding/org-1').set('Authorization', 'Bearer owner-1');
    expect(s.body.checklist.steps.find((x: any) => x.key === 'terms')).toMatchObject({ status: 'todo', detail: { current_version: '2026-09' } });
    expect(state.lifecycle_state).toBe('live'); // owner decision O-1: no pause, no suspension
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

describe('POST /:orgId/detect (VTID-04481)', () => {
  function wireDetect(row: Record<string, any>) {
    const state = org(row);
    wireOrg(state);
    const base = handlers.partner_organizations;
    let written: any = null;
    handlers.partner_organizations = (c) => {
      if (c.op === 'update') { written = c.args[0]; return { data: null, error: null }; }
      if (c.op === 'select' && typeof c.args[0] === 'string' && c.args[0].includes('business_details')) {
        return { data: { id: 'org-1', website: state.website, business_details: { existing: 1 } }, error: null };
      }
      return base(c);
    };
    return { get written() { return written; } };
  }

  it('400 when neither the body nor the org has a website', async () => {
    wireDetect({});
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/detect').set('Authorization', 'Bearer owner-1').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('WEBSITE_REQUIRED');
    expect(detectPlatformMock).not.toHaveBeenCalled();
  });

  it('refuses a non-http(s) website before any fetch', async () => {
    wireDetect({});
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/detect').set('Authorization', 'Bearer owner-1')
      .send({ website: 'file:///etc/passwd' });
    expect(r.status).toBe(400);
    expect(detectPlatformMock).not.toHaveBeenCalled();
  });

  it('is org_admin only', async () => {
    wireOrg(org(), { admin: false });
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/detect').set('Authorization', 'Bearer other-1')
      .send({ website: 'https://shop.example' });
    expect(r.status).toBe(403);
    expect(detectPlatformMock).not.toHaveBeenCalled();
  });

  it('detects, keeps the result on the org, suggests a name and writes no company facts', async () => {
    const w = wireDetect({ website: 'https://shop.example/' });
    detectPlatformMock.mockResolvedValue({
      ok: true, connector_id: 'shopify', provider_id: 'shopify', name_hint: 'Shopify', confidence: 'high', signals: ['shopify'], site_name: 'Acme Shop',
    });
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/detect').set('Authorization', 'Bearer owner-1').send({});
    expect(r.status).toBe(200);
    expect(detectPlatformMock).toHaveBeenCalledWith('https://shop.example/');
    expect(r.body.detection).toMatchObject({ connector_id: 'shopify', confidence: 'high', url: 'https://shop.example/' });
    expect(r.body.suggested).toEqual({ website: 'https://shop.example/', display_name: 'Acme Shop' });
    expect(w.written.business_details).toMatchObject({ existing: 1, platform_detection: { connector_id: 'shopify', platform_name: 'Shopify' } });
    for (const k of ['legal_name', 'country', 'vat_id', 'website', 'display_name']) expect(w.written).not.toHaveProperty(k);
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'partner_org.platform_detected',
      payload: expect.objectContaining({ connector_id: 'shopify', confidence: 'high' }),
    }));
  });

  it('422 with the reason when the detector refuses the URL, and records nothing', async () => {
    const w = wireDetect({});
    detectPlatformMock.mockResolvedValue({ ok: false, error: 'blocked_private_address' });
    const r = await request(app()).post('/api/v1/partner-onboarding/org-1/detect').set('Authorization', 'Bearer owner-1')
      .send({ website: 'https://internal.example' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'DETECTION_FAILED', reason: 'blocked_private_address' });
    expect(w.written).toBeNull();
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});

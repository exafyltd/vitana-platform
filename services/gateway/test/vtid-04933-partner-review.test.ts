/**
 * VTID-04933 — Commerce supplier review v1 (/api/v1/admin/partner-review).
 *
 * exafy_admin only; writes need the admin's own session (an assistant's
 * delegated token is refused). Approve = verification level 1 (owner decision
 * 2026-10-07): live only when every required step is done, otherwise
 * needs_action. Request changes / reject move through the lifecycle graph.
 * Per-offering keep offline / allow listing ride on the VTID-04769 product gate.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const ids: Record<string, any> = {
      'Bearer admin': { user_id: 'admin-1', email: 'a@exafy.io', exafy_admin: true },
      'Bearer admin-oauth': { user_id: 'admin-1', email: 'a@exafy.io', exafy_admin: true },
      'Bearer member': { user_id: 'member-1', email: 'm@example.com', exafy_admin: false },
    };
    const id = ids[req.headers.authorization];
    if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = id;
    req.auth_raw_claims = req.headers.authorization === 'Bearer admin-oauth'
      ? { sub: id.user_id, session_id: 'sess-x', client_id: 'claude' }
      : { sub: id.user_id, session_id: `sess-${id.user_id}` };
    return next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) =>
    req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'EXAFY_ADMIN_REQUIRED' }),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const events: any[] = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (e: any) => { events.push(e); return Promise.resolve({ ok: true }); },
}));

// ---------------------------------------------------------------- in-memory DB
type Row = Record<string, any>;
let db: Record<string, Row[]>;

/** The VTID-04769 product gate, as far as these tests need it. */
function orgLiveForMerchant(merchantId: string): boolean {
  const m = db.merchants.find((x) => x.id === merchantId);
  const o = m && db.partner_organizations.find((x) => x.id === m.partner_organization_id);
  return o?.lifecycle_state === 'live';
}
function productGate(next: Row, prev: Row | null, touchedActive: boolean): Row {
  if (!touchedActive) return next;
  const eligible = orgLiveForMerchant(next.merchant_id);
  if (!prev) {
    return eligible
      ? { ...next, is_active: true, listing_hold: null, first_listed_at: next.first_listed_at ?? 'now' }
      : { ...next, is_active: false, listing_hold: null };
  }
  if (next.is_active) {
    return eligible
      ? { ...next, listing_hold: null, first_listed_at: next.first_listed_at ?? 'now' }
      : { ...next, is_active: false, listing_hold: 'org_not_live' };
  }
  return { ...next, listing_hold: null, first_listed_at: next.first_listed_at ?? 'now' };
}
/** refresh_supplier_listings on go-live. */
function refreshOnGoLive(orgId: string) {
  for (const m of db.merchants.filter((x) => x.partner_organization_id === orgId)) {
    for (const p of db.products.filter((x) => x.merchant_id === m.id)) {
      if (!p.is_active && (p.listing_hold || !p.first_listed_at)) Object.assign(p, { is_active: true, listing_hold: null, first_listed_at: p.first_listed_at ?? 'now' });
    }
  }
}

function makeFake() {
  return {
    rpc(name: string, args: any) {
      if (name !== 'auth_session_is_delegated') return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
      return Promise.resolve({ data: String(args.p_session_id).startsWith('sess-admin') ? 'direct' : 'delegated', error: null });
    },
    from(table: string) {
      let op = 'select';
      let payload: any = null;
      let upsertConflict: string[] = [];
      let head = false;
      const filters: Array<(r: Row) => boolean> = [];
      const chain: any = {};
      chain.select = (_f?: string, opts?: any) => { if (opts?.head) head = true; return chain; };
      chain.eq = (c: string, v: any) => {
        filters.push((r) => (c.includes('->>') ? r[c.split('->>')[0]]?.[c.split('->>')[1]] : r[c]) === v);
        return chain;
      };
      chain.in = (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return chain; };
      chain.like = (c: string, pat: string) => { const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/%/g, '.*') + '$'); filters.push((r) => re.test(r[c])); return chain; };
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.update = (p: any) => { op = 'update'; payload = p; return chain; };
      chain.insert = (p: any) => { op = 'insert'; payload = p; return chain; };
      chain.upsert = (p: any, o?: any) => { op = 'upsert'; payload = p; upsertConflict = String(o?.onConflict ?? '').split(','); return chain; };
      const exec = () => {
        db[table] = db[table] ?? [];
        const rows = db[table];
        if (op === 'upsert') {
          const hit = rows.find((r) => upsertConflict.every((k) => r[k] === payload[k]));
          if (hit) Object.assign(hit, payload); else rows.push({ ...payload });
          return { data: null, error: null };
        }
        if (op === 'insert') { rows.push({ ...payload }); return { data: null, error: null }; }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') {
          for (const r of matched) {
            const before = { ...r };
            let next = { ...r, ...payload };
            if (table === 'products') next = productGate(next, before, 'is_active' in payload);
            Object.assign(r, next);
            if (table === 'partner_organizations' && payload.lifecycle_state === 'live' && before.lifecycle_state !== 'live') refreshOnGoLive(r.id);
          }
          return { data: matched.map((r) => ({ ...r })), error: null };
        }
        if (head) return { data: null, count: matched.length, error: null };
        return { data: matched.map((r) => ({ ...r })), count: matched.length, error: null };
      };
      chain.maybeSingle = () => { const r: any = exec(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }); };
      chain.single = chain.maybeSingle;
      chain.then = (res: any, rej: any) => Promise.resolve(exec()).then(res, rej);
      return chain;
    },
  };
}
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => makeFake() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/admin-partner-review').default;
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/admin/partner-review', router);
  return a;
}

const ORG = 'org-1';
function seed(over: Row = {}, steps: Row[] = []) {
  db = {
    partner_organizations: [{
      id: ORG, org_key: 'exafy-ltd', display_name: 'Exafy ltd', partner_type: 'service_provider', commerce_vertical: 'general',
      lifecycle_state: 'needs_action', status: 'pending_review', trust_level: 0, legal_name: 'EXAFY LTD', country: 'AE',
      vat_id: null, website: 'https://www.exafy.io/', owner_user_id: 'owner-1', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', ...over,
    }],
    partner_onboarding_steps: steps.map((s) => ({ partner_organization_id: ORG, ...s })),
    partner_terms_versions: [{ id: 'tv1', version: '2026-10', status: 'published', content_sha256: 'h', baseline_version_id: 'tv1', requires_reacceptance: true, published_at: 'x' }],
    partner_terms_acceptances: [{ partner_organization_id: ORG, terms_version: '2026-10', content_sha256: 'h', shown_locale: 'en', accepted_at: '2026-10-06T15:05:17Z' }],
    partner_organization_members: [{ partner_organization_id: ORG, user_id: 'owner-1', role: 'org_admin' }],
    merchants: [{ id: 'm-1', partner_organization_id: ORG }],
    products: [{ id: 'p-1', merchant_id: 'm-1', title: 'AI & Digital Platform Consultation', price_cents: 15000, currency: 'EUR', affiliate_url: 'https://www.exafy.io/', origin_country: 'AE', ships_to_countries: ['AE'], is_active: false, listing_hold: null, first_listed_at: null, attributes: { kind: 'service' }, created_at: 'x' }],
    oasis_events: [],
  };
}
/**
 * Every required step of a service_provider except verification. Since
 * VTID-04953 that is the catalogue row alone: mapping is derived from the
 * complete offering (no connection), and tracking_test / billing_mandate are
 * not required for service providers in v1.
 */
const ALL_BUT_VERIFICATION = [{ step_key: 'catalogue', status: 'done', detail: null }];
const org = () => db.partner_organizations[0];
const step = (k: string) => db.partner_onboarding_steps.find((s) => s.step_key === k);

beforeEach(() => { events.length = 0; seed(); });

describe('access', () => {
  it('401 without a token, 403 for a member, 200 for an exafy_admin', async () => {
    expect((await request(app()).get('/api/v1/admin/partner-review')).status).toBe(401);
    expect((await request(app()).get('/api/v1/admin/partner-review').set('Authorization', 'Bearer member')).status).toBe(403);
    expect((await request(app()).get('/api/v1/admin/partner-review').set('Authorization', 'Bearer admin')).status).toBe(200);
  });

  it.each(['approve', 'request-changes', 'reject', 'products/p-1/keep-offline', 'products/p-1/allow-listing'])(
    'POST %s refuses an assistant’s delegated token and changes nothing', async (path) => {
      const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/${path}`).set('Authorization', 'Bearer admin-oauth').send({ reason: 'x' });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('REQUIRES_OWN_SESSION');
      expect(org().lifecycle_state).toBe('needs_action');
      expect(db.products[0].first_listed_at).toBeNull();
      expect(events).toHaveLength(0);
    });
});

describe('list and detail', () => {
  it('lists suppliers waiting for review with open steps, product count and terms', async () => {
    const r = await request(app()).get('/api/v1/admin/partner-review').set('Authorization', 'Bearer admin');
    expect(r.body.organizations).toHaveLength(1);
    expect(r.body.organizations[0]).toMatchObject({ id: ORG, product_count: 1, terms_accepted_version: '2026-10', lifecycle_state: 'needs_action' });
    expect(r.body.organizations[0].open_steps).toEqual(expect.arrayContaining(['verification', 'catalogue']));
  });

  it('rejects an unknown state filter', async () => {
    const r = await request(app()).get('/api/v1/admin/partner-review?state=nope').set('Authorization', 'Bearer admin');
    expect(r.status).toBe(400);
  });

  it('detail shows the offering as waiting for go-live and hides the owner id', async () => {
    const r = await request(app()).get(`/api/v1/admin/partner-review/${ORG}`).set('Authorization', 'Bearer admin');
    expect(r.status).toBe(200);
    expect(r.body.organization.owner_user_id).toBeUndefined();
    expect(r.body.products[0]).toMatchObject({ id: 'p-1', kind: 'service', listing: 'waiting_for_go_live', is_active: false });
  });
});

describe('approve (verification level 1)', () => {
  it('with other required steps open: verification done, trust 1, stays needs_action, not live', async () => {
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/approve`).set('Authorization', 'Bearer admin').send({ note: 'checked licence' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'needs_action', lifecycle_state: 'needs_action', transitions: [] });
    expect(step('verification')).toMatchObject({ status: 'done', detail: expect.objectContaining({ method: 'admin_approval', level: 1, note: 'checked licence', approved_by: 'admin-1' }) });
    expect(step('verification')!.detail.facts).toEqual({ website: 'https://www.exafy.io/', country: 'AE', vat_id: null });
    expect(org().trust_level).toBe(1);
    expect(events.map((e) => e.type)).toContain('partner_org.review.approved');
  });

  it('with every other required step done: needs_action -> verifying -> live, through the graph', async () => {
    seed({}, ALL_BUT_VERIFICATION);
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/approve`).set('Authorization', 'Bearer admin').send({});
    expect(r.body).toMatchObject({ outcome: 'live', lifecycle_state: 'live' });
    expect(r.body.transitions).toEqual([{ from: 'needs_action', to: 'verifying' }, { from: 'verifying', to: 'live' }]);
    expect(org().lifecycle_state).toBe('live');
    expect(events.filter((e) => e.type === 'partner_org.lifecycle_changed').map((e) => e.payload.reason)).toEqual(['admin_approval', 'admin_approval']);
  });

  it('from verifying with steps open moves to needs_action', async () => {
    seed({ lifecycle_state: 'verifying' });
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/approve`).set('Authorization', 'Bearer admin').send({});
    expect(r.body.transitions).toEqual([{ from: 'verifying', to: 'needs_action' }]);
  });

  it.each(['draft', 'submitted', 'live', 'rejected'])('refuses from %s', async (state) => {
    seed({ lifecycle_state: state });
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/approve`).set('Authorization', 'Bearer admin').send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NOT_REVIEWABLE');
    expect(step('verification')).toBeUndefined();
  });

  it('refuses types that need verification level 2', async () => {
    seed({ partner_type: 'lab' });
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/approve`).set('Authorization', 'Bearer admin').send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('LEVEL_2_REQUIRED');
  });

  it('a kept-offline offering stays off when the approval takes the supplier live; a waiting one goes on', async () => {
    seed({}, ALL_BUT_VERIFICATION);
    db.products.push({ ...db.products[0], id: 'p-2', title: 'Second' });
    await request(app()).post(`/api/v1/admin/partner-review/${ORG}/products/p-1/keep-offline`).set('Authorization', 'Bearer admin').send({ reason: 'controlled test record' });
    await request(app()).post(`/api/v1/admin/partner-review/${ORG}/approve`).set('Authorization', 'Bearer admin').send({});
    expect(org().lifecycle_state).toBe('live');
    expect(db.products.find((p) => p.id === 'p-1')!.is_active).toBe(false);
    expect(db.products.find((p) => p.id === 'p-2')!.is_active).toBe(true);
  });
});

describe('request changes', () => {
  it('needs a reason', async () => {
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/request-changes`).set('Authorization', 'Bearer admin').send({ reason: '  ' });
    expect(r.status).toBe(400);
  });

  it('records the reason for the supplier and voids an earlier approval', async () => {
    await request(app()).post(`/api/v1/admin/partner-review/${ORG}/approve`).set('Authorization', 'Bearer admin').send({});
    expect(org().trust_level).toBe(1);
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/request-changes`).set('Authorization', 'Bearer admin').send({ reason: 'Please add a service description.' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ lifecycle_state: 'needs_action', voided_approval: true });
    expect(step('verification')).toMatchObject({ status: 'todo', detail: expect.objectContaining({ review_note: expect.objectContaining({ reason: 'Please add a service description.' }) }) });
    expect(org().trust_level).toBe(0);
    expect(events.map((e) => e.type)).toContain('partner_org.review.changes_requested');
  });

  it('from verifying moves to needs_action', async () => {
    seed({ lifecycle_state: 'verifying' });
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/request-changes`).set('Authorization', 'Bearer admin').send({ reason: 'x' });
    expect(r.body.transitions).toEqual([{ from: 'verifying', to: 'needs_action' }]);
  });
});

describe('reject', () => {
  it.each(['needs_action', 'verifying', 'exception'])('from %s is one move to rejected', async (state) => {
    seed({ lifecycle_state: state });
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/reject`).set('Authorization', 'Bearer admin').send({ reason: 'Not a fit.' });
    expect(r.status).toBe(200);
    expect(r.body.transitions).toEqual([{ from: state, to: 'rejected' }]);
    expect(org().lifecycle_state).toBe('rejected');
    expect(events.map((e) => e.type)).toContain('partner_org.review.rejected');
  });

  it('needs a reason and refuses a live org', async () => {
    expect((await request(app()).post(`/api/v1/admin/partner-review/${ORG}/reject`).set('Authorization', 'Bearer admin').send({})).status).toBe(400);
    seed({ lifecycle_state: 'live' });
    expect((await request(app()).post(`/api/v1/admin/partner-review/${ORG}/reject`).set('Authorization', 'Bearer admin').send({ reason: 'x' })).status).toBe(409);
  });
});

describe('per-offering listing', () => {
  it('keep offline needs a reason, marks the decision and the listing state', async () => {
    expect((await request(app()).post(`/api/v1/admin/partner-review/${ORG}/products/p-1/keep-offline`).set('Authorization', 'Bearer admin').send({})).status).toBe(400);
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/products/p-1/keep-offline`).set('Authorization', 'Bearer admin').send({ reason: 'controlled test record' });
    expect(r.status).toBe(200);
    expect(r.body.product).toMatchObject({ is_active: false, listing: 'kept_offline' });
    expect(db.products[0].attributes).toMatchObject({ kind: 'service', admin_listing: expect.objectContaining({ decision: 'kept_offline', reason: 'controlled test record', decided_by: 'admin-1' }) });
    expect(events.map((e) => e.type)).toContain('partner_org.review.product_kept_offline');
  });

  it('allow listing while the org is not live: held, goes on with the org', async () => {
    await request(app()).post(`/api/v1/admin/partner-review/${ORG}/products/p-1/keep-offline`).set('Authorization', 'Bearer admin').send({ reason: 'x' });
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/products/p-1/allow-listing`).set('Authorization', 'Bearer admin').send({});
    expect(r.body.product).toMatchObject({ is_active: false, listing: 'waiting_for_go_live' });
    expect(db.products[0].listing_hold).toBe('org_not_live');
  });

  it('a supplier edit can neither forge nor erase the admin listing note', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { updateProduct } = require('../src/services/partner-onboarding-service');
    const owner = { userId: 'owner-1', orgAdminChecked: true };
    const forged = await updateProduct(makeFake(), owner, ORG, 'p-1', { attributes: { kind: 'service', admin_listing: { decision: 'allowed' } } });
    expect(forged.status).toBe(200);
    expect(db.products[0].attributes).toEqual({ kind: 'service' });

    await request(app()).post(`/api/v1/admin/partner-review/${ORG}/products/p-1/keep-offline`).set('Authorization', 'Bearer admin').send({ reason: 'controlled test record' });
    const r = await updateProduct(makeFake(), owner, ORG, 'p-1', { attributes: { kind: 'service', duration: '60 min' } });
    expect(r.status).toBe(200);
    expect(db.products[0].attributes).toMatchObject({ kind: 'service', duration: '60 min', admin_listing: expect.objectContaining({ decision: 'kept_offline', reason: 'controlled test record' }) });
    expect(db.products[0].is_active).toBe(false);
  });

  it('refuses a product of another organization', async () => {
    db.merchants.push({ id: 'm-2', partner_organization_id: 'org-2' });
    db.products.push({ ...db.products[0], id: 'p-other', merchant_id: 'm-2' });
    const r = await request(app()).post(`/api/v1/admin/partner-review/${ORG}/products/p-other/keep-offline`).set('Authorization', 'Bearer admin').send({ reason: 'x' });
    expect(r.status).toBe(404);
    expect(db.products.find((p) => p.id === 'p-other')!.first_listed_at).toBeNull();
  });
});

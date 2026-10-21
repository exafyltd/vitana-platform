/**
 * VTID-05090 — the partner data processing agreement (AVV): the supplier
 * endpoints GET /:orgId/dpa and POST /:orgId/dpa/sign, the checklist's
 * derived `dpa` step through loadChecklist, and the service helpers.
 *
 * Contract: nothing published → `published:false` and the step open with
 * `dpa_not_published` (never an error); signing only from the supplier's own
 * session; exact version + German hash + a language the version carries;
 * typed name and role and a ticked declaration; only for types that need a
 * DPA and only with the company named; one append-only row with an org
 * snapshot, IP and user agent; one OASIS event without personal data.
 * The database rules (immutability, one published, hash computed by the
 * database incl. the declaration, append-only, stale/wrong-hash refusal) are
 * proven against a throwaway Postgres in
 * scripts/ci/sql-tests/vtid-05090-partner-dpa.test.sql (CI SQL-PARTNER-TERMS).
 */

import express from 'express';
import request from 'supertest';

const OWNER = 'owner-1';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const byToken: Record<string, any> = {
      'Bearer owner-1': { user_id: 'owner-1', email: 'owner@lab.example', exafy_admin: false },
      'Bearer owner-no-email': { user_id: 'owner-1', email: null, exafy_admin: false },
    };
    const claimsByToken: Record<string, any> = {
      'Bearer owner-1': { sub: 'owner-1', session_id: 'sess-owner' },
      'Bearer owner-no-email': { sub: 'owner-1', session_id: 'sess-owner' },
      'Bearer owner-oauth-claim': { sub: 'owner-1', session_id: 'sess-owner', client_id: 'claude-client' },
      'Bearer owner-oauth-session': { sub: 'owner-1', session_id: 'sess-oauth' },
      'Bearer owner-no-session': { sub: 'owner-1' },
      'Bearer owner-unknown-session': { sub: 'owner-1', session_id: 'gone-session' },
    };
    const auth = req.headers.authorization;
    const id = byToken[auth] ?? (claimsByToken[auth] ? byToken['Bearer owner-1'] : undefined);
    if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = id;
    req.auth_raw_claims = claimsByToken[auth];
    return next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args) }));
jest.mock('../src/services/platform-detect', () => ({ detectPlatform: jest.fn() }));
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));

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
import { dpaForDisplay, loadCurrentDpa, loadSignedDpaVersions, parseSignBody, type PublishedDpa } from '../src/services/partner-dpa';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/partner-onboarding', router);
  return a;
}

const LAB_COMPANY = { legal_name: 'Labor Muster GmbH', country: 'DE', vat_id: 'DE123456789', website: 'https://lab.example/' };

function org(over: Record<string, any> = {}) {
  return {
    id: 'org-1', org_key: 'lab-abc123', display_name: 'Labor', partner_type: 'lab', commerce_vertical: 'health',
    lifecycle_state: 'draft', status: 'pending_review', trust_level: 0, ...LAB_COMPANY,
    owner_user_id: OWNER, created_at: '2026-10-12T00:00:00Z', ...over,
  };
}

/** The published DPA version (null = none published). Placeholder text: the real text is never in code. */
const DPA_V: PublishedDpa = {
  id: 'dv-1', version: 'avv-1', baseline_version_id: 'dv-1', content_sha256: 'hash-avv-1',
  requires_resign: true, published_at: '2026-10-12T00:00:00Z',
  content: {
    de: { title: 'DE-Titel', body_md: 'DE-Text', signing_declaration: 'DE-Erklärung' },
    en: { title: 'EN title', body_md: 'EN text', signing_declaration: 'EN declaration' },
    ar: { title: 'AR', body_md: 'AR' },
  },
};
let publishedDpa: PublishedDpa | null;
let signatures: Array<{ dpa_version: string; signed_at: string }>;
let inserted: any;
let insertError: any;

const SIGN = {
  dpa_version: 'avv-1', content_sha256: 'hash-avv-1', shown_locale: 'de',
  signer_name: '  Erika Muster ', signer_role: 'Geschäftsführerin', declaration_confirmed: true,
};

function wire(state: Record<string, any>) {
  handlers.integration_manifest = () => ({ data: null, count: 0, error: null });
  handlers.merchants = () => ({ data: [], error: null });
  handlers.products = () => ({ data: [], error: null });
  handlers.partner_organizations = () => ({ data: { ...state }, error: null });
  handlers.partner_organization_members = (c) =>
    c.terminal === 'maybeSingle' ? { data: { role: 'org_admin' }, error: null } : { data: null, count: 1, error: null };
  handlers.partner_onboarding_steps = () => ({ data: [], error: null });
  handlers.partner_terms_acceptances = () => ({ data: [], error: null });
  handlers.partner_terms_versions = () => ({ data: null, error: null });
  handlers.partner_dpa_versions = (c) =>
    c.terminal === 'maybeSingle' ? { data: publishedDpa, error: null } : { data: publishedDpa ? [{ version: publishedDpa.version }] : [], error: null };
  handlers.partner_dpa_signatures = (c) => {
    if (c.op === 'insert') {
      if (insertError) return { data: null, error: insertError };
      inserted = c.args[0];
      signatures.push({ dpa_version: inserted.dpa_version, signed_at: '2026-10-12T10:00:00Z' });
      return { data: null, error: null };
    }
    return { data: signatures, error: null };
  };
}

const sign = (body: any = SIGN, token = 'Bearer owner-1') =>
  request(app()).post('/api/v1/partner-onboarding/org-1/dpa/sign').set('Authorization', token).set('User-Agent', 'jest-agent').send(body);
const read = (locale?: string) =>
  request(app()).get(`/api/v1/partner-onboarding/org-1/dpa${locale ? `?locale=${locale}` : ''}`).set('Authorization', 'Bearer owner-1');
const dpaStep = (r: any) => r.body.checklist.steps.find((s: any) => s.key === 'dpa');

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  calls = [];
  publishedDpa = DPA_V;
  signatures = [];
  inserted = null;
  insertError = null;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => (console.warn as jest.Mock).mockRestore?.());

describe('mount', () => {
  it('401 JSON without a token, for GET and POST', async () => {
    const g = await request(app()).get('/api/v1/partner-onboarding/org-1/dpa');
    expect(g.status).toBe(401);
    expect(g.type).toBe('application/json');
    const p = await request(app()).post('/api/v1/partner-onboarding/org-1/dpa/sign').send(SIGN);
    expect(p.status).toBe(401);
  });
});

describe('GET /:orgId/dpa', () => {
  it('nothing published: published:false, dpa:null — not an error', async () => {
    publishedDpa = null;
    wire(org());
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, required: true, published: false, dpa: null, signed: false, signed_at: null, signed_version: null, resign_required: false });
  });

  it('the DPA table missing (migration not applied) reads as not published', async () => {
    wire(org());
    delete handlers.partner_dpa_versions;
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ published: false, dpa: null });
  });

  it('shows the caller language with its signing declaration, the binding German text and the German hash', async () => {
    wire(org());
    const r = await read('en-US');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ required: true, published: true, signed: false, resign_required: false });
    expect(r.body.dpa).toMatchObject({
      version: 'avv-1', content_sha256: 'hash-avv-1', binding_locale: 'de',
      binding: { title: 'DE-Titel', body_md: 'DE-Text', signing_declaration: 'DE-Erklärung' },
      locale: 'en', fallback: false, direction: 'ltr', shown_locale: 'en',
      text: { title: 'EN title', body_md: 'EN text', signing_declaration: 'EN declaration' },
      signing_declaration: 'EN declaration', available_locales: ['de', 'en', 'ar'],
    });
  });

  it('German when the language is missing (never English); Arabic is right-to-left with no declaration of its own', async () => {
    wire(org());
    const fr = await read('fr');
    expect(fr.body.dpa).toMatchObject({ locale: 'de', fallback: true, signing_declaration: 'DE-Erklärung' });
    const ar = await read('ar-XA');
    expect(ar.body.dpa).toMatchObject({ locale: 'ar', direction: 'rtl', signing_declaration: null });
  });

  it('signed under the current baseline; an older baseline asks to re-sign', async () => {
    wire(org());
    signatures = [{ dpa_version: 'avv-1', signed_at: '2026-10-12T10:00:00Z' }];
    expect((await read()).body).toMatchObject({ signed: true, signed_at: '2026-10-12T10:00:00Z', signed_version: 'avv-1', resign_required: false });
    signatures = [{ dpa_version: 'avv-0', signed_at: '2026-09-01T10:00:00Z' }];
    expect((await read()).body).toMatchObject({ signed: false, signed_version: null, resign_required: true });
  });

  it('required:false for a type that needs no DPA; 404 for an unknown org', async () => {
    wire(org({ partner_type: 'supplier_shop' }));
    expect((await read()).body.required).toBe(false);
    handlers.partner_organizations = () => ({ data: null, error: null });
    expect((await read()).status).toBe(404);
  });
});

describe('POST /:orgId/dpa/sign — refusals', () => {
  it.each([
    ['an OAuth client_id claim (assistant token)', 'Bearer owner-oauth-claim'],
    ['a session created for an OAuth client', 'Bearer owner-oauth-session'],
    ['a token without a session', 'Bearer owner-no-session'],
    ['a session that cannot be found', 'Bearer owner-unknown-session'],
  ])('403 for %s: only the supplier signs, never an assistant', async (_l, token) => {
    wire(org());
    const r = await sign(SIGN, token);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('DPA_SIGNATURE_REQUIRES_SUPPLIER');
    expect(inserted).toBeNull();
    expect(emitOasisEventMock).not.toHaveBeenCalled();
    // Refused before anything else was read.
    expect(calls.some((c) => c.table === 'partner_dpa_versions')).toBe(false);
  });

  it('503 DPA_NOT_PUBLISHED when nothing is published', async () => {
    publishedDpa = null;
    wire(org());
    const r = await sign();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('DPA_NOT_PUBLISHED');
  });

  it('409 for another version or another text', async () => {
    wire(org());
    const v = await sign({ ...SIGN, dpa_version: 'avv-0' });
    expect(v.status).toBe(409);
    expect(v.body).toMatchObject({ error: 'DPA_VERSION_MISMATCH', current_version: 'avv-1' });
    const h = await sign({ ...SIGN, content_sha256: 'older-hash' });
    expect(h.status).toBe(409);
    expect(h.body.error).toBe('DPA_CONTENT_MISMATCH');
    expect(inserted).toBeNull();
  });

  it.each(['fr', 'pt', '', 'DE', 'de+en'])('400 for shown_locale %p: not a language the version carries', async (shown) => {
    wire(org());
    const r = await sign({ ...SIGN, shown_locale: shown });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'INVALID_SHOWN_LOCALE', available_locales: ['de', 'en', 'ar'] });
    expect(inserted).toBeNull();
  });

  it.each([
    ['no name', { signer_name: '   ' }, 'signer_name'],
    ['a name over 200 characters', { signer_name: 'x'.repeat(201) }, 'signer_name'],
    ['no role', { signer_role: '' }, 'signer_role'],
    ['a role over 120 characters', { signer_role: 'x'.repeat(121) }, 'signer_role'],
    ['an unticked declaration', { declaration_confirmed: false }, 'declaration_confirmed'],
    ['a declaration sent as the string "true"', { declaration_confirmed: 'true' }, 'declaration_confirmed'],
  ])('400 INVALID_SIGNATURE for %s', async (_l, patch, field) => {
    wire(org());
    const r = await sign({ ...SIGN, ...patch });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'INVALID_SIGNATURE', field });
    expect(inserted).toBeNull();
  });

  it('404 for an unknown org', async () => {
    wire(org());
    handlers.partner_organizations = () => ({ data: null, error: null });
    // requireOrgAdmin passes on membership; the org row itself is gone.
    const r = await sign();
    expect(r.status).toBe(404);
  });

  it.each(['supplier_shop', 'service_provider', 'affiliate_brand'])('409 DPA_NOT_REQUIRED for a %s', async (type) => {
    wire(org({ partner_type: type }));
    const r = await sign();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('DPA_NOT_REQUIRED');
  });

  it('409 DPA_COMPANY_INCOMPLETE until the contracting party is named (legal name, country)', async () => {
    wire(org({ legal_name: null, country: null }));
    const r = await sign();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'DPA_COMPANY_INCOMPLETE', missing: ['legal_name', 'country'] });
    expect(inserted).toBeNull();
  });

  it('403 ACCOUNT_EMAIL_REQUIRED when the account has no email (signer_email is required)', async () => {
    wire(org());
    const r = await sign(SIGN, 'Bearer owner-no-email');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ACCOUNT_EMAIL_REQUIRED');
    expect(inserted).toBeNull();
  });
});

describe('POST /:orgId/dpa/sign — signing', () => {
  it('records the signer, the org as it is, the exact version, hash and language, IP and user agent', async () => {
    wire(org({ partner_type: 'practitioner_clinic' }));
    const r = await sign({ ...SIGN, shown_locale: 'en' });
    expect(r.status).toBe(200);
    expect(inserted).toMatchObject({
      partner_organization_id: 'org-1', dpa_version_id: 'dv-1', dpa_version: 'avv-1', content_sha256: 'hash-avv-1',
      shown_locale: 'en', signed_by: OWNER, signer_email: 'owner@lab.example',
      signer_name: 'Erika Muster', signer_role: 'Geschäftsführerin', declaration_confirmed: true,
      org_snapshot: LAB_COMPANY, user_agent: 'jest-agent',
    });
    expect(typeof inserted.ip_address).toBe('string');
    expect(r.body.already_signed).toBe(false);
    expect(dpaStep(r)).toMatchObject({ required: true, status: 'done' });
    // The assistant check ran on the caller's own session.
    expect(calls.find((c) => c.table === 'rpc:auth_session_is_delegated')?.args[0]).toEqual({ p_session_id: 'sess-owner' });
  });

  it('emits partner_org.dpa_signed once, with no IP, user agent, email, name or role', async () => {
    wire(org());
    await sign();
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    const ev = emitOasisEventMock.mock.calls[0][0];
    expect(ev).toMatchObject({
      vtid: 'VTID-05090', type: 'partner_org.dpa_signed', source: 'partner-onboarding', status: 'success', actor_id: OWNER,
      payload: { partner_organization_id: 'org-1', dpa_version: 'avv-1', dpa_version_id: 'dv-1', content_sha256: 'hash-avv-1', shown_locale: 'de', actor_id: OWNER },
    });
    const text = JSON.stringify(ev);
    for (const pii of ['jest-agent', 'owner@lab.example', 'Erika', 'Geschäftsführerin', '127.0.0.1', '::ffff']) expect(text).not.toContain(pii);
  });

  it('a second signature of the same version is idempotent (23505): already_signed, no event', async () => {
    wire(org());
    signatures = [{ dpa_version: 'avv-1', signed_at: '2026-10-12T10:00:00Z' }];
    insertError = { code: '23505', message: 'duplicate key' };
    const r = await sign();
    expect(r.status).toBe(200);
    expect(r.body.already_signed).toBe(true);
    expect(dpaStep(r).status).toBe('done');
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('a version published between reading and signing is refused by the database trigger (409)', async () => {
    wire(org());
    insertError = { code: 'P0001', message: 'PARTNER_DPA_VERSION_NOT_CURRENT' };
    const r = await sign();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('DPA_CONTENT_MISMATCH');
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('any other insert error is a 500, never a silent success', async () => {
    wire(org());
    insertError = { code: 'XX000', message: 'boom' };
    const r = await sign();
    expect(r.status).toBe(500);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});

describe('the dpa step through GET /:orgId (loadChecklist)', () => {
  const state = () => request(app()).get('/api/v1/partner-onboarding/org-1').set('Authorization', 'Bearer owner-1');

  it('nothing published → todo with dpa_not_published, and the checklist is not complete', async () => {
    publishedDpa = null;
    wire(org());
    const r = await state();
    expect(r.status).toBe(200);
    expect(dpaStep(r)).toEqual({ key: 'dpa', required: true, status: 'todo', missing: ['dpa_not_published'] });
    expect(r.body.checklist.complete).toBe(false);
  });

  it.each([
    ['the versions table is missing', () => { delete handlers.partner_dpa_versions; }],
    ['the versions read errors', () => { handlers.partner_dpa_versions = () => ({ data: null, error: { message: 'relation does not exist' } }); }],
  ])('%s → the step shows open, never a 500', async (_l, breakIt) => {
    wire(org());
    breakIt();
    const r = await state();
    expect(r.status).toBe(200);
    expect(dpaStep(r)).toMatchObject({ status: 'todo', missing: ['dpa_not_published'] });
  });

  it('a signatures read error → the step stays open (none signed), never a 500', async () => {
    wire(org());
    handlers.partner_dpa_signatures = () => { throw new Error('signatures unreadable'); };
    const r = await state();
    expect(r.status).toBe(200);
    expect(dpaStep(r)).toMatchObject({ status: 'todo', detail: { current_version: 'avv-1' } });
  });

  it('a stored dpa row no longer decides the step', async () => {
    publishedDpa = null;
    wire(org());
    handlers.partner_onboarding_steps = () => ({ data: [{ step_key: 'dpa', status: 'done' }], error: null });
    const r = await state();
    expect(dpaStep(r).status).toBe('todo');
  });

  it('a shop reads no DPA tables at all and shows not_required', async () => {
    wire(org({ partner_type: 'supplier_shop' }));
    const r = await state();
    expect(dpaStep(r)).toEqual({ key: 'dpa', required: false, status: 'not_required' });
    expect(calls.some((c) => c.table.startsWith('partner_dpa_'))).toBe(false);
  });
});

describe('service helpers', () => {
  it('loadCurrentDpa fails closed on a malformed row, an error or a throw', async () => {
    const s = (h: () => any) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: h }) }) }) }) as any;
    expect(await loadCurrentDpa(s(() => Promise.resolve({ data: { id: 'x' }, error: null })))).toBeNull();
    expect(await loadCurrentDpa(s(() => Promise.resolve({ data: null, error: { message: 'no table' } })))).toBeNull();
    expect(await loadCurrentDpa(s(() => { throw new Error('boom'); }))).toBeNull();
    expect(await loadCurrentDpa(s(() => Promise.resolve({ data: DPA_V, error: null })))).toMatchObject({ version: 'avv-1' });
  });

  it('loadSignedDpaVersions is empty on error', async () => {
    const s = (r: any) => ({ from: () => ({ select: () => ({ eq: () => Promise.resolve(r) }) }) }) as any;
    expect(await loadSignedDpaVersions(s({ data: null, error: { message: 'x' } }), 'org-1')).toEqual([]);
    expect(await loadSignedDpaVersions(s({ data: [{ dpa_version: 'avv-1' }], error: null }), 'org-1')).toEqual(['avv-1']);
  });

  it('dpaForDisplay never depends on the language for the hash', () => {
    for (const l of ['de', 'en', 'ar', 'fr', null]) expect(dpaForDisplay(DPA_V, l).content_sha256).toBe('hash-avv-1');
  });

  it('parseSignBody trims and requires everything', () => {
    expect(parseSignBody(SIGN)).toEqual({ ok: true, value: { ...SIGN, signer_name: 'Erika Muster' } });
    expect(parseSignBody(null)).toMatchObject({ ok: false, field: 'dpa_version' });
    expect(parseSignBody({ ...SIGN, content_sha256: 1 })).toMatchObject({ ok: false, field: 'content_sha256' });
  });
});

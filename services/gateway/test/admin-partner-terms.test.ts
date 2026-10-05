/**
 * VTID-04895 — partner terms lifecycle: the exafy_admin publishing API and the
 * terms service (current version fails closed, display, assistant-token check).
 * The database rules themselves (immutability, one published, append-only,
 * hash/version check, baseline) are proven against a real Postgres in
 * scripts/ci/sql-tests/vtid-04895-partner-terms.test.sql (CI SQL-PARTNER-TERMS).
 */
import express from 'express';
import request from 'supertest';

let identity: any;
let claims: any;
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = identity;
    req.auth_raw_claims = claims;
    return next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) =>
    req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
}));

const emitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEvent(...a) }));

type Call = { table: string; op: string; args: any[]; filters: Array<[string, any]>; terminal: string };
let calls: Call[];
let handlers: Record<string, (c: Call) => any>;
let rpc: (name: string, args: any) => any;

function fakeSupabase() {
  return {
    from(table: string) {
      let op = 'select';
      let args: any[] = [];
      const filters: Array<[string, any]> = [];
      const run = (terminal: string) => {
        const c = { table, op, args, filters, terminal };
        calls.push(c);
        const h = handlers[table];
        if (!h) throw new Error(`Unexpected table ${table}`);
        return Promise.resolve(h(c));
      };
      const chain: any = {};
      chain.eq = (k: string, v: any) => { filters.push([k, v]); return chain; };
      for (const m of ['order', 'limit']) chain[m] = () => chain;
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
      return Promise.resolve(rpc(name, args));
    },
  };
}
let supa: any;
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => supa }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/admin-partner-terms').default;
import { parseTermsContent } from '../src/routes/admin-partner-terms';
import { loadCurrentTerms, requestDelegation, termsForDisplay, type PublishedTerms } from '../src/services/partner-terms';

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/admin/partner-terms', router);
  return a;
};
const ADMIN = { user_id: 'admin-1', exafy_admin: true };
const EN = { en: { title: 'Partner Terms', body_md: 'Binding text' } };

beforeEach(() => {
  jest.clearAllMocks();
  calls = [];
  handlers = {};
  supa = fakeSupabase();
  identity = ADMIN;
  claims = { sub: 'admin-1', session_id: 'sess-admin' };
  rpc = (name, args) =>
    name === 'auth_session_is_delegated'
      ? { data: args.p_session_id === 'sess-oauth' ? 'delegated' : 'direct', error: null }
      : { data: null, error: { message: `unexpected ${name}` } };
});

describe('admin publishing API — access', () => {
  it('401 without a session, 403 for a non-admin', async () => {
    identity = null;
    expect((await request(app()).get('/api/v1/admin/partner-terms')).status).toBe(401);
    identity = { user_id: 'u-1', exafy_admin: false };
    expect((await request(app()).get('/api/v1/admin/partner-terms')).status).toBe(403);
  });

  it.each([
    ['an OAuth client_id claim', { sub: 'admin-1', session_id: 'sess-admin', client_id: 'claude' }],
    ['an OAuth session', { sub: 'admin-1', session_id: 'sess-oauth' }],
    ['no session', { sub: 'admin-1' }],
  ])('writes are refused for %s (never an assistant)', async (_l, c) => {
    claims = c;
    handlers.partner_terms_versions = () => ({ data: null, error: null });
    const r = await request(app()).post('/api/v1/admin/partner-terms').send({ version: '2026-10', content: EN });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('REQUIRES_OWN_SESSION');
    expect(calls.filter((x) => x.table === 'partner_terms_versions')).toHaveLength(0);
  });
});

describe('drafts', () => {
  it('creates a draft with English binding text; re-acceptance defaults to required', async () => {
    let row: any;
    handlers.partner_terms_versions = (c) => { row = c.args[0]; return { data: { id: 'tv-1', status: 'draft', ...row }, error: null }; };
    const r = await request(app()).post('/api/v1/admin/partner-terms').send({ version: ' 2026-10 ', content: { ...EN, de: { title: 'T', body_md: 'B' } } });
    expect(r.status).toBe(201);
    expect(row).toMatchObject({ version: '2026-10', binding_locale: 'en', requires_reacceptance: true, created_by: 'admin-1' });
    expect(row.content.de).toEqual({ title: 'T', body_md: 'B' });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_terms.draft_saved', actor_id: 'admin-1', payload: expect.objectContaining({ action: 'created' }) }));
  });

  it('400 without the English text; 409 for an existing version', async () => {
    handlers.partner_terms_versions = () => ({ data: null, error: null });
    const noEn = await request(app()).post('/api/v1/admin/partner-terms').send({ version: '2026-10', content: { de: { title: 'T', body_md: 'B' } } });
    expect(noEn.status).toBe(400);
    handlers.partner_terms_versions = () => ({ data: null, error: { code: '23505', message: 'dup' } });
    const dup = await request(app()).post('/api/v1/admin/partner-terms').send({ version: '2026-10', content: EN });
    expect(dup.status).toBe(409);
  });

  it('edits only drafts: a published version is immutable', async () => {
    handlers.partner_terms_versions = (c) => (c.terminal === 'maybeSingle' && c.op === 'select' ? { data: { id: 'tv-1', status: 'published' }, error: null } : { data: null, error: null });
    const r = await request(app()).put('/api/v1/admin/partner-terms/tv-1').send({ content: EN });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('PARTNER_TERMS_IMMUTABLE');
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('a draft edit is guarded on status = draft', async () => {
    handlers.partner_terms_versions = (c) =>
      c.op === 'select' ? { data: { id: 'tv-1', status: 'draft' }, error: null } : { data: { id: 'tv-1', status: 'draft' }, error: null };
    const r = await request(app()).put('/api/v1/admin/partner-terms/tv-1').send({ content: EN, requires_reacceptance: false });
    expect(r.status).toBe(200);
    const upd = calls.find((c) => c.op === 'update')!;
    expect(upd.filters).toEqual(expect.arrayContaining([['id', 'tv-1'], ['status', 'draft']]));
    expect(upd.args[0]).toMatchObject({ content: EN, requires_reacceptance: false });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_terms.draft_saved', payload: expect.objectContaining({ action: 'edited' }) }));
  });
});

describe('publish', () => {
  const published = (over: Record<string, unknown> = {}) => ({
    id: 'tv-2', version: '2026-11', content_sha256: 'h2', requires_reacceptance: true, baseline_version_id: 'tv-2', superseded_id: 'tv-1', ...over,
  });

  it('publishes through the transaction, as the admin, and records version_published', async () => {
    rpc = (name, args) => (name === 'auth_session_is_delegated' ? { data: 'direct', error: null } : { data: published({ superseded_id: null }), error: null, args });
    const r = await request(app()).post('/api/v1/admin/partner-terms/tv-2/publish');
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.table === 'rpc:publish_partner_terms_version')!.args[0]).toEqual({ p_id: 'tv-2', p_actor: 'admin-1' });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_terms.version_published', actor_id: 'admin-1' }));
    expect(emitOasisEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_terms.reacceptance_required' }));
  });

  it('a material update after an earlier version reports how many orgs must re-accept', async () => {
    rpc = (name) => (name === 'auth_session_is_delegated' ? { data: 'direct', error: null } : { data: published(), error: null });
    handlers.partner_terms_acceptances = () => ({ data: [{ partner_organization_id: 'o1' }, { partner_organization_id: 'o1' }, { partner_organization_id: 'o2' }], error: null });
    const r = await request(app()).post('/api/v1/admin/partner-terms/tv-2/publish');
    expect(r.body.affected_orgs).toBe(2);
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_terms.reacceptance_required', payload: expect.objectContaining({ affected_orgs: 2 }) }));
  });

  it('an editorial update needs no re-acceptance', async () => {
    rpc = (name) => (name === 'auth_session_is_delegated' ? { data: 'direct', error: null } : { data: published({ requires_reacceptance: false, baseline_version_id: 'tv-1' }), error: null });
    const r = await request(app()).post('/api/v1/admin/partner-terms/tv-2/publish');
    expect(r.body.affected_orgs).toBe(0);
    expect(emitOasisEvent).toHaveBeenCalledTimes(1);
  });

  it('404 / 409 from the transaction', async () => {
    rpc = (name) => (name === 'auth_session_is_delegated' ? { data: 'direct', error: null } : { data: null, error: { message: 'PARTNER_TERMS_NOT_DRAFT' } });
    expect((await request(app()).post('/api/v1/admin/partner-terms/tv-1/publish')).status).toBe(409);
    rpc = (name) => (name === 'auth_session_is_delegated' ? { data: 'direct', error: null } : { data: null, error: { message: 'PARTNER_TERMS_NOT_FOUND' } });
    expect((await request(app()).post('/api/v1/admin/partner-terms/nope/publish')).status).toBe(404);
  });
});

describe('content validation', () => {
  it('English title and body are required; locales are two letters', () => {
    expect(parseTermsContent(EN).ok).toBe(true);
    expect(parseTermsContent({ de: { title: 'T', body_md: 'B' } }).ok).toBe(false);
    expect(parseTermsContent({ en: { title: ' ', body_md: 'B' } }).ok).toBe(false);
    expect(parseTermsContent({ ...EN, deu: { title: 'T', body_md: 'B' } }).ok).toBe(false);
    expect(parseTermsContent(null).ok).toBe(false);
  });
});

describe('terms service', () => {
  const TERMS: PublishedTerms = {
    id: 'tv-1', version: '2026-10', baseline_version_id: 'tv-1', content_sha256: 'h1', requires_reacceptance: true,
    published_at: '2026-10-05T00:00:00Z', content: { en: { title: 'Partner Terms', body_md: 'Binding' }, de: { title: 'Partnerbedingungen', body_md: 'Übersetzung' } },
  };

  it('the current version fails closed: missing table or error → not published', async () => {
    expect(await loadCurrentTerms(supa)).toBeNull(); // no handler: the fake throws
    handlers.partner_terms_versions = () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
    expect(await loadCurrentTerms(supa)).toBeNull();
    handlers.partner_terms_versions = () => ({ data: TERMS, error: null });
    expect(await loadCurrentTerms(supa)).toEqual(TERMS);
  });

  it('display: English binding always; a translation alongside only when it exists', () => {
    expect(termsForDisplay(TERMS, 'de-DE')).toMatchObject({ binding: { title: 'Partner Terms' }, translation: { locale: 'de' }, shown_locale: 'en+de' });
    expect(termsForDisplay(TERMS, 'en')).toMatchObject({ translation: null, shown_locale: 'en' });
    expect(termsForDisplay(TERMS, 'sr')).toMatchObject({ translation: null, shown_locale: 'en' });
    expect(termsForDisplay(TERMS, null).shown_locale).toBe('en');
  });

  it('assistant check: a client_id claim never reaches the session lookup; RPC errors refuse', async () => {
    expect(await requestDelegation(supa, { session_id: 's', client_id: 'claude' })).toBe('delegated');
    expect(calls.some((c) => c.table.startsWith('rpc:'))).toBe(false);
    expect(await requestDelegation(supa, undefined)).toBe('unknown');
    expect(await requestDelegation(supa, { sub: 'u' })).toBe('unknown');
    expect(await requestDelegation(supa, { session_id: 'sess-oauth' })).toBe('delegated');
    expect(await requestDelegation(supa, { session_id: 'sess-1' })).toBe('direct');
    rpc = () => ({ data: null, error: { message: 'column oauth_client_id does not exist' } });
    expect(await requestDelegation(supa, { session_id: 'sess-1' })).toBe('unknown');
    rpc = () => { throw new Error('network'); };
    expect(await requestDelegation(supa, { session_id: 'sess-1' })).toBe('unknown');
  });
});

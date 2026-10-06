/**
 * VTID-04895 — partner terms lifecycle: the exafy_admin publishing API and the
 * terms service (current version fails closed, display, assistant-token check).
 * VTID-04909: German is binding; English required; exact BCP-47 locale codes;
 * German fallback; the hash never depends on the language shown.
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
import {
  loadCurrentTerms,
  requestDelegation,
  resolveTermsLocale,
  SUPPORTED_TERMS_LOCALES,
  termsForDisplay,
  type PublishedTerms,
} from '../src/services/partner-terms';

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/admin/partner-terms', router);
  return a;
};
const ADMIN = { user_id: 'admin-1', exafy_admin: true };
// VTID-04909: the smallest valid content — German (binding) and English (second language).
const EN = { de: { title: 'Partnerbedingungen', body_md: 'Verbindlicher Text' }, en: { title: 'Partner Terms', body_md: 'English text' } };

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
  it('creates a draft with German binding text; re-acceptance defaults to required', async () => {
    let row: any;
    handlers.partner_terms_versions = (c) => { row = c.args[0]; return { data: { id: 'tv-1', status: 'draft', ...row }, error: null }; };
    const r = await request(app()).post('/api/v1/admin/partner-terms').send({ version: ' 2026-10 ', content: { ...EN, 'pt-BR': { title: 'T', body_md: 'B' } } });
    expect(r.status).toBe(201);
    expect(row).toMatchObject({ version: '2026-10', binding_locale: 'de', requires_reacceptance: true, created_by: 'admin-1' });
    expect(row.content['pt-BR']).toEqual({ title: 'T', body_md: 'B' });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_terms.draft_saved', actor_id: 'admin-1', payload: expect.objectContaining({ action: 'created' }) }));
  });

  it('400 without the German or the English text; 409 for an existing version', async () => {
    handlers.partner_terms_versions = () => ({ data: null, error: null });
    const noEn = await request(app()).post('/api/v1/admin/partner-terms').send({ version: '2026-10', content: { de: EN.de } });
    expect(noEn.status).toBe(400);
    const noDe = await request(app()).post('/api/v1/admin/partner-terms').send({ version: '2026-10', content: { en: EN.en } });
    expect(noDe.status).toBe(400);
    expect(noDe.body.error).toMatch(/content\.de .*German/);
    expect(calls.filter((x) => x.table === 'partner_terms_versions')).toHaveLength(0);
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
  const T = { title: 'T', body_md: 'B' };

  it('German is mandatory: missing object, title or body is an error naming German', () => {
    expect(parseTermsContent(EN).ok).toBe(true);
    for (const de of [undefined, { body_md: 'B' }, { title: 'T' }, { title: ' ', body_md: 'B' }, { title: 'T', body_md: '  ' }]) {
      const r = parseTermsContent({ en: EN.en, ...(de ? { de } : {}) });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/content\.de/);
    }
  });

  it('English is required as the second language', () => {
    const r = parseTermsContent({ de: EN.de });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/content\.en .*English/);
    expect(parseTermsContent({ de: EN.de, en: { title: ' ', body_md: 'B' } }).ok).toBe(false);
  });

  it('accepts all 11 exact codes, including pt-BR and zh-CN', () => {
    const all = Object.fromEntries(SUPPORTED_TERMS_LOCALES.map((k) => [k, T]));
    expect(SUPPORTED_TERMS_LOCALES).toEqual(['de', 'en', 'es', 'sr', 'fr', 'pt-BR', 'ru', 'pl', 'ar', 'zh-CN', 'tr']);
    const r = parseTermsContent(all);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.content)).toEqual(SUPPORTED_TERMS_LOCALES);
  });

  it.each([
    ['pt', /use "pt-BR"/],
    ['zh', /use "zh-CN"/],
    ['pt-br', /use "pt-BR"/],
    ['zh-cn', /use "zh-CN"/],
    ['EN', /not supported/],
    ['de-DE', /not supported/],
    ['it', /not supported/],
    ['deu', /not supported/],
  ])('rejects %s — never mapped silently', (key, msg) => {
    const r = parseTermsContent({ ...EN, [key]: T });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });

  it('rejects anything that is not an object of texts', () => {
    expect(parseTermsContent(null).ok).toBe(false);
    expect(parseTermsContent([EN]).ok).toBe(false);
  });
});

describe('terms service', () => {
  const TERMS: PublishedTerms = {
    id: 'tv-1', version: '2026-10', baseline_version_id: 'tv-1', content_sha256: 'h1', requires_reacceptance: true,
    published_at: '2026-10-05T00:00:00Z',
    content: {
      de: { title: 'Partnerbedingungen', body_md: 'Verbindlich' },
      en: { title: 'Partner Terms', body_md: 'English' },
      'pt-BR': { title: 'Termos de Parceria', body_md: 'Português' },
      'zh-CN': { title: '合作伙伴条款', body_md: '中文' },
      ar: { title: 'شروط الشركاء', body_md: 'عربي' },
      sr: { title: 'Partnerski uslovi', body_md: 'Srpski' },
    },
  };

  it('the current version fails closed: missing table or error → not published', async () => {
    expect(await loadCurrentTerms(supa)).toBeNull(); // no handler: the fake throws
    handlers.partner_terms_versions = () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
    expect(await loadCurrentTerms(supa)).toBeNull();
    handlers.partner_terms_versions = () => ({ data: TERMS, error: null });
    expect(await loadCurrentTerms(supa)).toEqual(TERMS);
  });

  it('display: the requested language, German binding text alongside, languages in owner order', () => {
    expect(termsForDisplay(TERMS, 'de-DE')).toMatchObject({
      binding_locale: 'de', binding: { title: 'Partnerbedingungen' }, locale: 'de', text: { title: 'Partnerbedingungen' },
      translation: null, shown_locale: 'de', fallback: false, direction: 'ltr',
    });
    expect(termsForDisplay(TERMS, 'en-US')).toMatchObject({ locale: 'en', text: { title: 'Partner Terms' }, translation: { locale: 'en' }, shown_locale: 'en' });
    expect(termsForDisplay(TERMS, 'pt-BR')).toMatchObject({ locale: 'pt-BR', text: { title: 'Termos de Parceria' }, shown_locale: 'pt-BR' });
    expect(termsForDisplay(TERMS, 'zh-CN')).toMatchObject({ locale: 'zh-CN', text: { title: '合作伙伴条款' } });
    expect(termsForDisplay(TERMS, 'ar-XA')).toMatchObject({ locale: 'ar', direction: 'rtl' });
    expect(termsForDisplay(TERMS, 'de').available_locales).toEqual(['de', 'en', 'sr', 'pt-BR', 'ar', 'zh-CN']);
  });

  it('a missing translation falls back to German, never English', () => {
    for (const req of ['fr-FR', 'tr-TR', 'pt', 'pt-PT', 'zh', 'zh-TW', 'xx']) {
      expect(termsForDisplay(TERMS, req)).toMatchObject({ locale: 'de', shown_locale: 'de', fallback: true, text: { title: 'Partnerbedingungen' } });
    }
    expect(termsForDisplay(TERMS, null)).toMatchObject({ locale: 'de', fallback: false });
    expect(termsForDisplay(TERMS, '')).toMatchObject({ locale: 'de', fallback: false });
  });

  it('the hash is the version\'s canonical German hash whatever language is shown', () => {
    const hashes = new Set(['de-DE', 'en-US', 'sr-RS', 'pt-BR', 'ar-XA', 'zh-CN', 'fr-FR', null].map((l) => termsForDisplay(TERMS, l).content_sha256));
    expect([...hashes]).toEqual(['h1']);
  });

  it('maps every app catalog key to its terms language', () => {
    const all = [...SUPPORTED_TERMS_LOCALES];
    const table: Array<[string, string]> = [
      ['de-DE', 'de'], ['en-US', 'en'], ['es-ES', 'es'], ['sr-RS', 'sr'], ['fr-FR', 'fr'], ['pt-BR', 'pt-BR'],
      ['ru-RU', 'ru'], ['pl-PL', 'pl'], ['ar-XA', 'ar'], ['zh-CN', 'zh-CN'], ['tr-TR', 'tr'],
      ['de', 'de'], ['pt_BR', 'pt-BR'], ['zh_cn', 'zh-CN'], ['fr-CA', 'fr'], ['sr-Latn-RS', 'sr'],
    ];
    for (const [req, want] of table) expect(resolveTermsLocale(req, all)).toEqual({ locale: want, fallback: false });
    for (const req of ['pt', 'pt-PT', 'zh', 'zh-TW', 'it-IT']) expect(resolveTermsLocale(req, all)).toEqual({ locale: 'de', fallback: true });
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

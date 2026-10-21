/**
 * VTID-05090 — the exafy_admin publishing API for the partner data processing
 * agreement (/api/v1/admin/partner-dpa). Mirrors admin-partner-terms.test.ts:
 * exafy_admin only, writes from the admin's own session only, German + English
 * required, an optional signing declaration per language, draft-only edits,
 * publish through the database transaction with its OASIS events.
 * No DPA text is in code — the strings below are placeholders.
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
const router = require('../src/routes/admin-partner-dpa').default;
import { parseDpaContent } from '../src/routes/admin-partner-dpa';

const BASE = '/api/v1/admin/partner-dpa';
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(BASE, router);
  return a;
};
const ADMIN = { user_id: 'admin-1', exafy_admin: true };
const CONTENT = {
  de: { title: 'DE-Titel', body_md: 'DE-Text', signing_declaration: 'DE-Erklärung' },
  en: { title: 'EN title', body_md: 'EN text' },
};
const direct = (name: string) => (name === 'auth_session_is_delegated' ? { data: 'direct', error: null } : null);

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

describe('access', () => {
  it('401 without a session, 403 for a non-admin', async () => {
    identity = null;
    expect((await request(app()).get(BASE)).status).toBe(401);
    identity = { user_id: 'u-1', exafy_admin: false };
    expect((await request(app()).get(BASE)).status).toBe(403);
  });

  it.each([
    ['an OAuth client_id claim', { sub: 'admin-1', session_id: 'sess-admin', client_id: 'claude' }],
    ['an OAuth session', { sub: 'admin-1', session_id: 'sess-oauth' }],
    ['no session', { sub: 'admin-1' }],
  ])('writes are refused for %s (never an assistant)', async (_l, c) => {
    claims = c;
    handlers.partner_dpa_versions = () => ({ data: null, error: null });
    for (const r of [
      await request(app()).post(BASE).send({ version: 'avv-1', content: CONTENT }),
      await request(app()).put(`${BASE}/dv-1`).send({ content: CONTENT }),
      await request(app()).post(`${BASE}/dv-1/publish`),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('REQUIRES_OWN_SESSION');
    }
    expect(calls.filter((x) => x.table === 'partner_dpa_versions' || x.table === 'rpc:publish_partner_dpa_version')).toHaveLength(0);
  });

  it('lists versions newest first', async () => {
    handlers.partner_dpa_versions = () => ({ data: [{ id: 'dv-1' }], error: null });
    const r = await request(app()).get(BASE);
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([{ id: 'dv-1' }]);
  });
});

describe('drafts', () => {
  it('creates a draft with German binding text and its declaration; re-signing defaults to required', async () => {
    let row: any;
    handlers.partner_dpa_versions = (c) => { row = c.args[0]; return { data: { id: 'dv-1', status: 'draft', ...row }, error: null }; };
    const r = await request(app()).post(BASE).send({ version: ' avv-1 ', content: CONTENT });
    expect(r.status).toBe(201);
    expect(row).toMatchObject({ version: 'avv-1', binding_locale: 'de', requires_resign: true, created_by: 'admin-1' });
    expect(row.content.de).toEqual(CONTENT.de);
    expect(row.content.en).toEqual(CONTENT.en);
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-05090', type: 'partner_dpa.draft_saved', actor_id: 'admin-1', payload: expect.objectContaining({ action: 'created', dpa_version_id: 'dv-1' }),
    }));
  });

  it('400 without German or English; 409 for an existing version', async () => {
    handlers.partner_dpa_versions = () => ({ data: null, error: null });
    expect((await request(app()).post(BASE).send({ version: 'avv-1', content: { de: CONTENT.de } })).status).toBe(400);
    const noDe = await request(app()).post(BASE).send({ version: 'avv-1', content: { en: CONTENT.en } });
    expect(noDe.status).toBe(400);
    expect(noDe.body.error).toMatch(/content\.de .*German/);
    expect((await request(app()).post(BASE).send({ version: '', content: CONTENT })).status).toBe(400);
    expect(calls.filter((x) => x.table === 'partner_dpa_versions')).toHaveLength(0);
    handlers.partner_dpa_versions = () => ({ data: null, error: { code: '23505', message: 'dup' } });
    expect((await request(app()).post(BASE).send({ version: 'avv-1', content: CONTENT })).status).toBe(409);
  });

  it('edits only drafts: a published version is immutable', async () => {
    handlers.partner_dpa_versions = (c) => (c.terminal === 'maybeSingle' && c.op === 'select' ? { data: { id: 'dv-1', status: 'published' }, error: null } : { data: null, error: null });
    const r = await request(app()).put(`${BASE}/dv-1`).send({ content: CONTENT });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('PARTNER_DPA_IMMUTABLE');
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('a draft edit is guarded on status = draft; 404 for an unknown id', async () => {
    handlers.partner_dpa_versions = () => ({ data: { id: 'dv-1', status: 'draft' }, error: null });
    const r = await request(app()).put(`${BASE}/dv-1`).send({ content: CONTENT, requires_resign: false });
    expect(r.status).toBe(200);
    const upd = calls.find((c) => c.op === 'update')!;
    expect(upd.filters).toEqual(expect.arrayContaining([['id', 'dv-1'], ['status', 'draft']]));
    expect(upd.args[0]).toMatchObject({ requires_resign: false, content: { de: CONTENT.de } });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_dpa.draft_saved', payload: expect.objectContaining({ action: 'edited' }) }));
    handlers.partner_dpa_versions = () => ({ data: null, error: null });
    expect((await request(app()).put(`${BASE}/nope`).send({ content: CONTENT })).status).toBe(404);
  });
});

describe('publish', () => {
  const published = (over: Record<string, unknown> = {}) => ({
    id: 'dv-2', version: 'avv-2', content_sha256: 'h2', requires_resign: true, baseline_version_id: 'dv-2', superseded_id: 'dv-1', ...over,
  });

  it('publishes through the transaction, as the admin, and records version_published', async () => {
    rpc = (name) => direct(name) ?? { data: published({ superseded_id: null }), error: null };
    const r = await request(app()).post(`${BASE}/dv-2/publish`);
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.table === 'rpc:publish_partner_dpa_version')!.args[0]).toEqual({ p_id: 'dv-2', p_actor: 'admin-1' });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ vtid: 'VTID-05090', type: 'partner_dpa.version_published', actor_id: 'admin-1' }));
    expect(emitOasisEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_dpa.resign_required' }));
  });

  it('a material update after an earlier version reports how many orgs must re-sign', async () => {
    rpc = (name) => direct(name) ?? { data: published(), error: null };
    handlers.partner_dpa_signatures = () => ({ data: [{ partner_organization_id: 'o1' }, { partner_organization_id: 'o1' }, { partner_organization_id: 'o2' }], error: null });
    const r = await request(app()).post(`${BASE}/dv-2/publish`);
    expect(r.body.affected_orgs).toBe(2);
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_dpa.resign_required', payload: expect.objectContaining({ affected_orgs: 2 }) }));
  });

  it('an editorial update needs no re-signing', async () => {
    rpc = (name) => direct(name) ?? { data: published({ requires_resign: false, baseline_version_id: 'dv-1' }), error: null };
    const r = await request(app()).post(`${BASE}/dv-2/publish`);
    expect(r.body.affected_orgs).toBe(0);
    expect(emitOasisEvent).toHaveBeenCalledTimes(1);
  });

  it('404 / 409 from the transaction, and no event', async () => {
    rpc = (name) => direct(name) ?? { data: null, error: { message: 'PARTNER_DPA_NOT_DRAFT' } };
    expect((await request(app()).post(`${BASE}/dv-1/publish`)).status).toBe(409);
    rpc = (name) => direct(name) ?? { data: null, error: { message: 'PARTNER_DPA_ENGLISH_MISSING' } };
    const en = await request(app()).post(`${BASE}/dv-1/publish`);
    expect(en.status).toBe(409);
    expect(en.body.error).toBe('ENGLISH_MISSING');
    rpc = (name) => direct(name) ?? { data: null, error: { message: 'PARTNER_DPA_NOT_FOUND' } };
    expect((await request(app()).post(`${BASE}/nope/publish`)).status).toBe(404);
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('content validation', () => {
  it('the partner terms rules apply: German and English required, exact codes', () => {
    expect(parseDpaContent(CONTENT).ok).toBe(true);
    expect(parseDpaContent({ en: CONTENT.en }).ok).toBe(false);
    expect(parseDpaContent({ de: CONTENT.de }).ok).toBe(false);
    const pt = parseDpaContent({ ...CONTENT, pt: { title: 'T', body_md: 'B' } });
    expect(pt.ok).toBe(false);
    if (!pt.ok) expect(pt.error).toMatch(/pt-BR/);
  });

  it('signing_declaration is optional per language, trimmed, text only, bounded', () => {
    const r = parseDpaContent({ de: { ...CONTENT.de, signing_declaration: '  Erklärung  ' }, en: { ...CONTENT.en, signing_declaration: '' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content.de.signing_declaration).toBe('Erklärung');
      expect('signing_declaration' in r.content.en).toBe(false);
    }
    expect(parseDpaContent({ de: { ...CONTENT.de, signing_declaration: 42 }, en: CONTENT.en }).ok).toBe(false);
    expect(parseDpaContent({ de: { ...CONTENT.de, signing_declaration: 'x'.repeat(2001) }, en: CONTENT.en }).ok).toBe(false);
  });

  it('unknown fields are dropped (text only)', () => {
    const r = parseDpaContent({ de: { ...CONTENT.de, html: '<b>x</b>' }, en: CONTENT.en });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.content.de).sort()).toEqual(['body_md', 'signing_declaration', 'title']);
  });
});

/**
 * VTID-04486 — HTTP tests for POST /api/v1/partner-onboarding/:orgId/verification/check.
 *
 * Contract: org_admin only; records the checks, the level reached, the facts
 * checked and the ownership token as the `verification` step row; sets
 * trust_level; returns DNS/meta instructions while ownership is unproven;
 * emits `partner_org.verification_checked` without the VAT id or email.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const byToken: Record<string, any> = {
      'Bearer owner-1': { user_id: 'owner-1', email: 'ann@acme.example', exafy_admin: false },
      'Bearer other-1': { user_id: 'other-1', email: 'x@example.com', exafy_admin: false },
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
jest.mock('../src/services/platform-detect', () => ({ detectPlatform: jest.fn(), ssrfGuardedFetch: jest.fn() }));
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));
jest.mock('../src/services/email/partner-invite-email', () => {
  const actual = jest.requireActual('../src/services/email/partner-invite-email');
  return { ...actual, sendPartnerInviteEmail: jest.fn().mockResolvedValue({ sent: false, status: 'disabled' }) };
});

const io = {
  checkVatVies: jest.fn(),
  lookupDomainProofTxt: jest.fn(),
  fetchSiteHtml: jest.fn(),
  readEmailConfirmation: jest.fn(),
};
jest.mock('../src/services/partner-verification-io', () => ({
  checkVatVies: (...a: any[]) => io.checkVatVies(...a),
  lookupDomainProofTxt: (...a: any[]) => io.lookupDomainProofTxt(...a),
  fetchSiteHtml: (...a: any[]) => io.fetchSiteHtml(...a),
  readEmailConfirmation: (...a: any[]) => io.readEmailConfirmation(...a),
}));

type Call = { table: string; op: string; args: any[]; filters: Array<[string, any]>; terminal: string };
let handlers: Record<string, (c: Call) => any>;
let calls: Call[];

function makeFakeSupabase() {
  return {
    auth: { admin: { getUserById: jest.fn() } },
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
      chain.upsert = (...a: any[]) => { op = 'upsert'; args = a; return chain; };
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

const TOKEN = 'a'.repeat(32);

function wire(org: Record<string, any>, opts: { admin?: boolean; priorDetail?: any } = {}) {
  const state = {
    id: 'org-1', org_key: 'acme-abc123', display_name: 'Acme', partner_type: 'supplier_shop', commerce_vertical: 'general',
    lifecycle_state: 'draft', status: 'pending_review', trust_level: 0, legal_name: 'Acme GmbH', country: 'DE',
    vat_id: 'DE 123456789', website: 'https://www.acme.example/', owner_user_id: 'owner-1', created_at: '2026-09-24T00:00:00Z',
    ...org,
  };
  let stored: any[] = [];
  handlers.partner_organizations = (c) => {
    if (c.op === 'update') { Object.assign(state, c.args[0]); return { data: [{ id: state.id }], error: null }; }
    return { data: { ...state }, error: null };
  };
  handlers.partner_organization_members = (c) =>
    c.terminal === 'maybeSingle'
      ? { data: opts.admin === false ? null : { role: 'org_admin' }, error: null }
      : { data: null, count: 1, error: null };
  handlers.partner_onboarding_steps = (c) => {
    if (c.op === 'upsert') { stored = [{ step_key: c.args[0].step_key, status: c.args[0].status, detail: c.args[0].detail }]; return { data: null, error: null }; }
    if (c.terminal === 'maybeSingle') return { data: opts.priorDetail ? { detail: opts.priorDetail } : null, error: null };
    return { data: stored, error: null };
  };
  handlers.partner_terms_acceptances = () => ({ data: [], error: null });
  return state;
}

const upsertCall = () => calls.find((c) => c.table === 'partner_onboarding_steps' && c.op === 'upsert');
const check = (auth = 'Bearer owner-1') =>
  request(app()).post('/api/v1/partner-onboarding/org-1/verification/check').set('Authorization', auth).send({});

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  calls = [];
  io.readEmailConfirmation.mockResolvedValue({ status: 'confirmed', email: 'ann@acme.example' });
  io.lookupDomainProofTxt.mockResolvedValue([]);
  io.fetchSiteHtml.mockResolvedValue(null);
  io.checkVatVies.mockResolvedValue({ status: 'valid', name: 'ACME GMBH' });
});

describe('POST /:orgId/verification/check', () => {
  it('401 JSON without a token', async () => {
    const r = await check('');
    expect(r.status).toBe(401);
    expect(r.type).toBe('application/json');
  });

  it('is org_admin only', async () => {
    wire({}, { admin: false });
    const r = await check('Bearer other-1');
    expect(r.status).toBe(403);
    expect(upsertCall()).toBeUndefined();
  });

  it('a shop: email domain proves ownership, VIES passes, business verification is still missing', async () => {
    wire({});
    const r = await check();
    expect(r.status).toBe(200);
    expect(io.readEmailConfirmation).toHaveBeenCalledWith(expect.anything(), 'owner-1');
    expect(io.checkVatVies).toHaveBeenCalledWith('DE', '123456789');
    expect(io.lookupDomainProofTxt).not.toHaveBeenCalled();
    expect(r.body.verification).toMatchObject({
      level_required: 1,
      level_reached: 0,
      status: 'in_progress',
      missing: ['business_verification_not_configured'],
      domain_method: 'email_domain',
      domain_proof: null,
    });
    const row = upsertCall()!.args[0];
    expect(row).toMatchObject({ partner_organization_id: 'org-1', step_key: 'verification', status: 'in_progress', updated_by: 'owner-1' });
    expect(row.detail.facts).toEqual({ website: 'https://www.acme.example/', country: 'DE', vat_id: 'DE 123456789' });
    expect(row.detail.vat_registered_name).toBe('ACME GMBH');
    expect(upsertCall()!.args[1]).toEqual({ onConflict: 'partner_organization_id,step_key' });

    const ev = emitOasisEventMock.mock.calls[0][0];
    expect(ev.type).toBe('partner_org.verification_checked');
    expect(JSON.stringify(ev.payload)).not.toContain('123456789');
    expect(JSON.stringify(ev.payload)).not.toContain('ann@');
  });

  it('an affiliate brand with a mailbox-provider email proves ownership by DNS TXT and finishes at level 0', async () => {
    io.readEmailConfirmation.mockResolvedValue({ status: 'confirmed', email: 'ann@gmail.com' });
    io.lookupDomainProofTxt.mockResolvedValue([[`vitana-verification=${TOKEN}`]]);
    const state = wire({ partner_type: 'affiliate_brand', trust_level: 0 }, { priorDetail: { domain_token: TOKEN } });
    const r = await check();
    expect(r.status).toBe(200);
    expect(io.lookupDomainProofTxt).toHaveBeenCalledWith('acme.example');
    expect(io.checkVatVies).not.toHaveBeenCalled();
    expect(r.body.verification).toMatchObject({ level_required: 0, level_reached: 0, status: 'done', domain_method: 'dns_txt', missing: [] });
    expect(state.trust_level).toBe(0);
    expect(r.body.checklist.steps.find((s: any) => s.key === 'verification').status).toBe('done');
  });

  it('keeps the same ownership token across checks and tells the partner what to publish', async () => {
    io.readEmailConfirmation.mockResolvedValue({ status: 'confirmed', email: 'ann@gmail.com' });
    wire({ partner_type: 'affiliate_brand' }, { priorDetail: { domain_token: TOKEN } });
    const r = await check();
    expect(r.body.verification.status).toBe('in_progress');
    expect(r.body.verification.domain_proof).toEqual({
      token: TOKEN,
      dns_txt_name: '_vitana-verification.acme.example',
      dns_txt_value: `vitana-verification=${TOKEN}`,
      meta_tag: `<meta name="vitana-site-verification" content="${TOKEN}">`,
    });
    expect(io.fetchSiteHtml).toHaveBeenCalledWith('https://www.acme.example/');
    expect(upsertCall()!.args[0].detail.domain_token).toBe(TOKEN);
  });

  it('an invalid VAT id fails the step', async () => {
    io.checkVatVies.mockResolvedValue({ status: 'invalid', name: null, error: 'INVALID' });
    wire({});
    const r = await check();
    expect(r.body.verification.status).toBe('failed');
    expect(r.body.verification.missing).toContain('vat_invalid');
  });

  it('an unconfirmed email reaches no level and lowers trust_level', async () => {
    io.readEmailConfirmation.mockResolvedValue({ status: 'unconfirmed', email: 'ann@acme.example' });
    const state = wire({ trust_level: 1 });
    const r = await check();
    expect(r.body.verification.level_reached).toBeNull();
    expect(r.body.verification.missing).toContain('email_not_verified');
    expect(state.trust_level).toBe(0);
  });

  it('409 for a rejected org, and nothing is recorded', async () => {
    wire({ lifecycle_state: 'rejected', status: 'rejected' });
    const r = await check();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NOT_CHECKABLE');
    expect(upsertCall()).toBeUndefined();
  });
});

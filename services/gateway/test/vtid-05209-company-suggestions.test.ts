/**
 * VTID-05209 — country and website suggestions for Commerce supplier screens
 * and the Commerce MCP status.
 *
 * Contract: saved values always win; VAT prefix, website country domain and a
 * confirmed business email are the only sources; reliable sources that
 * disagree give no suggestion; the routes are read-only and return plain
 * facts; GET /company-suggestions is not captured by GET /:orgId.
 */

import express from 'express';
import request from 'supertest';
import { countryFromHost, countryFromVatId, inferCompanyFacts } from '../src/services/commerce-company-inference';
import { shapeStatus, shapeSuggested } from '../src/services/commerce-mcp';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const byToken: Record<string, any> = {
      'Bearer owner-1': { user_id: 'owner-1', email: 'ann@kraeuterhaus.de', exafy_admin: false },
      'Bearer other-1': { user_id: 'other-1', email: 'x@example.com', exafy_admin: false },
    };
    const id = byToken[req.headers.authorization];
    if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = id;
    return next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../src/services/platform-detect', () => ({ detectPlatform: jest.fn(), ssrfGuardedFetch: jest.fn() }));
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));

const io = { readEmailConfirmation: jest.fn() };
jest.mock('../src/services/partner-verification-io', () => ({
  checkVatVies: jest.fn(),
  lookupDomainProofTxt: jest.fn(),
  fetchSiteHtml: jest.fn(),
  readEmailConfirmation: (...a: any[]) => io.readEmailConfirmation(...a),
}));

type Call = { table: string; op: string; terminal: string };
let handlers: Record<string, (c: Call) => any>;
let calls: Call[];

function makeFakeSupabase() {
  return {
    auth: { admin: { getUserById: jest.fn() } },
    from(table: string) {
      let op = 'select';
      const run = (terminal: string) => {
        const call = { table, op, terminal };
        calls.push(call);
        const h = handlers[table];
        if (!h) throw new Error(`Unexpected table in test: ${table}`);
        return Promise.resolve(h(call));
      };
      const chain: any = {};
      for (const m of ['eq', 'order', 'limit', 'in']) chain[m] = () => chain;
      chain.select = () => chain;
      for (const w of ['insert', 'update', 'upsert', 'delete']) chain[w] = () => { op = w; return chain; };
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

beforeEach(() => {
  handlers = {};
  calls = [];
  io.readEmailConfirmation.mockResolvedValue({ status: 'confirmed', email: 'ann@kraeuterhaus.de' });
});

describe('countryFromHost', () => {
  it.each([
    ['kraeuterhaus.de', 'DE'],
    ['shop.example.at', 'AT'],
    ['example.co.uk', 'GB'],
    ['shop.example.co.uk', 'GB'],
    ['example.uk', 'GB'],
    ['www.example.com.au', 'AU'],
    ['EXAMPLE.FR', 'FR'],
    ['example.com', null],
    ['example.eu', null],
    ['example.io', null],
    ['example.co', null],
    ['example.ai', null],
    ['example.shop', null],
    ['localhost', null],
    [null, null],
  ])('%s → %s', (host, expected) => {
    expect(countryFromHost(host as string | null)).toBe(expected);
  });
});

describe('countryFromVatId', () => {
  it.each([
    ['DE123456789', 'DE'],
    ['de 123 456 789', 'DE'],
    ['ATU12345678', 'AT'],
    ['EL123456789', 'GR'],
    ['GB123456789', null], // not an EU VAT prefix
    ['123456789', null],
    ['', null],
    [null, null],
  ])('%s → %s', (vat, expected) => {
    expect(countryFromVatId(vat as string | null)).toBe(expected);
  });
});

describe('inferCompanyFacts', () => {
  const confirmed = { email: 'anna@kraeuterhaus.de', emailConfirmed: true };

  it('saved values always win', () => {
    const s = inferCompanyFacts({ stored: { country: 'AT', website: 'https://other.de', vat_id: 'DE123456789' }, ...confirmed });
    expect(s.country).toEqual({ value: 'AT', source: 'stored' });
    expect(s.website).toEqual({ value: 'https://other.de', source: 'stored' });
  });

  it('confirmed business email → website and, with no website known, its country', () => {
    const s = inferCompanyFacts({ ...confirmed });
    expect(s.website).toEqual({ value: 'https://kraeuterhaus.de', source: 'email_domain' });
    expect(s.country).toEqual({ value: 'DE', source: 'email_domain' });
  });

  it('free-mail or unconfirmed email gives nothing', () => {
    expect(inferCompanyFacts({ email: 'anna@gmail.com', emailConfirmed: true })).toEqual({ country: null, website: null });
    expect(inferCompanyFacts({ email: 'anna@kraeuterhaus.de', emailConfirmed: false })).toEqual({ country: null, website: null });
  });

  it('VAT prefix and website domain agreeing → the VAT source', () => {
    const s = inferCompanyFacts({ stored: { website: 'https://kraeuterhaus.de' }, vatId: 'DE123456789' });
    expect(s.country).toEqual({ value: 'DE', source: 'vat_id' });
  });

  it('reliable sources that disagree → no country (the supplier is asked)', () => {
    const s = inferCompanyFacts({ stored: { website: 'https://kraeuterhaus.de', vat_id: 'ATU12345678' } });
    expect(s.country).toBeNull();
  });

  it('a known website decides over the email domain; a .com website gives no country', () => {
    const s = inferCompanyFacts({ website: 'kraeuterhaus.com', ...confirmed });
    expect(s.country).toBeNull();
    expect(s.website).toEqual({ value: 'https://kraeuterhaus.de', source: 'email_domain' });
  });

  it('a typed website without a scheme is read', () => {
    expect(inferCompanyFacts({ website: 'www.kraeuterhaus.at' }).country).toEqual({ value: 'AT', source: 'website_domain' });
  });

  it('an invalid saved country is not treated as saved', () => {
    expect(inferCompanyFacts({ stored: { country: 'germany' }, website: 'x.de' }).country).toEqual({ value: 'DE', source: 'website_domain' });
  });
});

describe('GET /company-suggestions (registration, no business yet)', () => {
  it('401 without a token', async () => {
    const r = await request(app()).get('/api/v1/partner-onboarding/company-suggestions');
    expect(r.status).toBe(401);
  });

  it('is reachable — not captured by GET /:orgId — and returns plain facts only', async () => {
    const r = await request(app()).get('/api/v1/partner-onboarding/company-suggestions').set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      country: { value: 'DE', source: 'email_domain' },
      website: { value: 'https://kraeuterhaus.de', source: 'email_domain' },
    });
    // No org lookup, no membership check, nothing written.
    expect(calls).toEqual([]);
  });

  it('uses the website the supplier is typing', async () => {
    io.readEmailConfirmation.mockResolvedValue({ status: 'confirmed', email: 'anna@gmail.com' });
    const r = await request(app())
      .get('/api/v1/partner-onboarding/company-suggestions?website=shop.example.co.uk')
      .set('Authorization', 'Bearer owner-1');
    expect(r.body.country).toEqual({ value: 'GB', source: 'website_domain' });
    expect(r.body.website).toBeNull();
  });

  it('an unavailable email lookup gives no email-based suggestion', async () => {
    io.readEmailConfirmation.mockResolvedValue({ status: 'unavailable', email: null });
    const r = await request(app()).get('/api/v1/partner-onboarding/company-suggestions').set('Authorization', 'Bearer owner-1');
    expect(r.body).toEqual({ ok: true, country: null, website: null });
  });
});

describe('GET /:orgId/company-suggestions (business profile)', () => {
  function wire(org: Record<string, unknown>, admin = true) {
    handlers.partner_organizations = () => ({ data: { country: null, website: null, vat_id: null, ...org }, error: null });
    handlers.partner_organization_members = (c) =>
      c.terminal === 'maybeSingle' ? { data: admin ? { role: 'org_admin' } : null, error: null } : { data: null, count: 1, error: null };
  }
  const get = (auth = 'Bearer owner-1') =>
    request(app()).get('/api/v1/partner-onboarding/org-1/company-suggestions').set('Authorization', auth);

  it('403 for a caller who is not an admin of that business', async () => {
    wire({}, false);
    const r = await get('Bearer other-1');
    expect(r.status).toBe(403);
  });

  it('saved values win and are not re-derived; the email is not read when both are saved', async () => {
    wire({ country: 'AT', website: 'https://kraeuterhaus.de' });
    const r = await get();
    expect(r.body.country).toEqual({ value: 'AT', source: 'stored' });
    expect(r.body.website).toEqual({ value: 'https://kraeuterhaus.de', source: 'stored' });
    expect(io.readEmailConfirmation).not.toHaveBeenCalled();
  });

  it('missing country: suggested from the saved VAT ID; read-only', async () => {
    wire({ website: 'https://kraeuterhaus.de', vat_id: 'DE123456789' });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.country).toEqual({ value: 'DE', source: 'vat_id' });
    expect(calls.every((c) => c.op === 'select')).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(['country', 'ok', 'website']);
  });

  it('saved VAT and website disagree → no country', async () => {
    wire({ website: 'https://kraeuterhaus.de', vat_id: 'ATU12345678' });
    const r = await get();
    expect(r.body.country).toBeNull();
  });
});

describe('Commerce MCP status: suggested values', () => {
  const body = (org: Record<string, unknown>) => ({
    organization: { id: 'org-1', partner_type: 'supplier_shop', lifecycle_state: 'draft', country: null, website: null, ...org },
    checklist: { next_step: 'company', complete: false, submit_ready: false, submit_missing: ['company'], steps: [{ key: 'company', required: true, status: 'todo' }] },
  });
  const sugg = inferCompanyFacts({ email: 'anna@kraeuterhaus.de', emailConfirmed: true });

  it('adds suggested values and a confirm-first hint while country/website are missing', () => {
    const out = shapeStatus(body({}), 'https://app.example', sugg) as any;
    expect(out.suggested).toEqual({
      country: { value: 'DE', from: "the supplier's confirmed business email address" },
      website: { value: 'https://kraeuterhaus.de', from: "the supplier's confirmed business email address" },
    });
    expect(out.next_action.tool).toBe('update_business');
    expect(out.next_action.how).toMatch(/Confirm the suggested values with the supplier/);
    expect(out.next_action.how).toMatch(/Never save a suggestion without the supplier confirming it/);
  });

  it('never suggests over a saved value', () => {
    expect(shapeSuggested({ country: 'AT', website: 'https://x.at' }, sugg)).toBeNull();
    const out = shapeStatus(body({ country: 'AT' }), 'https://app.example', sugg) as any;
    expect(out.suggested).toEqual({ website: { value: 'https://kraeuterhaus.de', from: "the supplier's confirmed business email address" } });
  });

  it('without suggestions the status is unchanged (existing callers)', () => {
    const a = shapeStatus(body({}), 'https://app.example') as any;
    expect(a.suggested).toBeUndefined();
    expect(a.next_action.how).toBeUndefined();
  });
});

describe('Commerce MCP: every status-shaped response carries the suggestion', () => {
  it('no handler calls shapeStatus without the suggestion argument', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').resolve(__dirname, '../src/services/commerce-mcp.ts'), 'utf8');
    const calls = [...src.matchAll(/shapeStatus\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => !a.includes(': Record<string, any>'));
    expect(calls.length).toBeGreaterThan(0);
    // Top-level arguments only: drop generic type arguments such as Record<string, any>.
    for (const args of calls) expect(args.replace(/<[^>]*>/g, '').split(',').length).toBe(3);
  });
});

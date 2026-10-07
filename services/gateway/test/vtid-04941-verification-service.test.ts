/**
 * VTID-04941 — the verification service the Commerce MCP shares with the
 * portal route: the overall time budget, the store-time website guard and the
 * fetch-time guard. Real service, in-memory database, real SSRF guard.
 */
const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: any[]) => emitOasisEventMock(...a) }));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));

const io = { checkVatVies: jest.fn(), lookupDomainProofTxt: jest.fn(), readEmailConfirmation: jest.fn() };
jest.mock('../src/services/partner-verification-io', () => {
  const actual = jest.requireActual('../src/services/partner-verification-io');
  return {
    ...actual,
    checkVatVies: (...a: any[]) => io.checkVatVies(...a),
    lookupDomainProofTxt: (...a: any[]) => io.lookupDomainProofTxt(...a),
    readEmailConfirmation: (...a: any[]) => io.readEmailConfirmation(...a),
  };
});

import { checkVerification, updateCompany, websiteIsInternal } from '../src/services/partner-onboarding-service';

type Call = { table: string; op: string; args: any[]; filters: Array<[string, any]>; terminal: string };
let handlers: Record<string, (c: Call) => any>;
let calls: Call[];

function fakeSupabase() {
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
      chain.upsert = (...a: any[]) => { op = 'upsert'; args = a; return chain; };
      chain.maybeSingle = () => run('maybeSingle');
      chain.single = () => run('single');
      chain.then = (res: any, rej: any) => run('then').then(res, rej);
      return chain;
    },
  } as any;
}

function wire(org: Record<string, any> = {}) {
  const state = {
    id: 'org-1', org_key: 'acme-abc123', display_name: 'Acme', partner_type: 'affiliate_brand', commerce_vertical: 'general',
    lifecycle_state: 'draft', status: 'pending_review', trust_level: 0, legal_name: 'Acme GmbH', country: 'DE',
    vat_id: null, website: 'https://www.acme.example/', owner_user_id: 'owner-1', created_at: '2026-09-24T00:00:00Z',
    ...org,
  };
  handlers.partner_organizations = (c) => {
    if (c.op === 'update') { Object.assign(state, c.args[0]); return { data: [{ id: state.id }], error: null }; }
    return { data: { ...state }, error: null };
  };
  handlers.partner_organization_members = (c) => (c.terminal === 'maybeSingle' ? { data: { role: 'org_admin' }, error: null } : { data: null, count: 1, error: null });
  handlers.partner_onboarding_steps = (c) => (c.op === 'upsert' ? { data: null, error: null } : c.terminal === 'maybeSingle' ? { data: null, error: null } : { data: [], error: null });
  handlers.partner_terms_acceptances = () => ({ data: [], error: null });
  return state;
}

const caller = { userId: 'owner-1', email: 'ann@elsewhere.example', orgAdminChecked: true };
const upserts = () => calls.filter((c) => c.table === 'partner_onboarding_steps' && c.op === 'upsert');
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  calls = [];
  io.readEmailConfirmation.mockResolvedValue({ status: 'confirmed', email: 'ann@elsewhere.example' });
  io.lookupDomainProofTxt.mockResolvedValue([]);
  io.checkVatVies.mockResolvedValue({ status: 'valid', name: 'ACME' });
  fetchSpy = jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('no network in tests'));
});
afterEach(() => fetchSpy.mockRestore());

describe('time budget', () => {
  test('a check that outlasts the budget comes back partial, unavailable, and credits nothing', async () => {
    wire();
    io.lookupDomainProofTxt.mockImplementation(() => new Promise(() => undefined)); // never answers
    const r = await checkVerification(fakeSupabase(), caller, 'org-1', { budgetMs: 60 });
    expect(r.status).toBe(200);
    expect((r.body as any).verification).toMatchObject({ partial: true, retry_after_seconds: 30, level_reached: null });
    expect((r.body as any).verification.checks.domain).toBe('unavailable');
    expect(upserts()[0].args[0].status).not.toBe('done');
  });
  test('without a budget the checks run to completion (the portal route)', async () => {
    wire();
    io.lookupDomainProofTxt.mockResolvedValue([['vitana-verification=zzz']]);
    const r = await checkVerification(fakeSupabase(), caller, 'org-1');
    expect((r.body as any).verification.partial).toBeUndefined();
  });
  test('the caller must be an org admin of this org', async () => {
    wire();
    handlers.partner_organization_members = () => ({ data: null, error: null });
    const r = await checkVerification(fakeSupabase(), { userId: 'intruder' }, 'org-1', { budgetMs: 100 });
    expect(r.status).toBe(403);
    expect(upserts()).toHaveLength(0);
  });
});

describe('store-time website guard (defence in depth)', () => {
  test.each(['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'https://192.168.1.10/shop', 'http://[::1]/'])(
    'update_business refuses %s and stores nothing',
    async (website) => {
      wire();
      const r = await updateCompany(fakeSupabase(), caller, 'org-1', { website });
      expect(r.status).toBe(400);
      expect(String((r.body as any).error)).toMatch(/public/);
      expect(calls.some((c) => c.table === 'partner_organizations' && c.op === 'update')).toBe(false);
    },
  );
  test('a public address is stored', async () => {
    wire();
    const r = await updateCompany(fakeSupabase(), caller, 'org-1', { website: 'https://93.184.216.34/' });
    expect(r.status).toBe(200);
    expect(calls.some((c) => c.table === 'partner_organizations' && c.op === 'update')).toBe(true);
  });
  test('websiteIsInternal: a host that does not resolve is not a refusal (the fetch guard decides)', async () => {
    expect(await websiteIsInternal('https://this-host-does-not-exist.invalid/')).toBe(false);
  });
});

describe('fetch-time guard', () => {
  test('a website that already points inside is never fetched by check_verification', async () => {
    wire({ website: 'http://169.254.169.254/' });
    const r = await checkVerification(fakeSupabase(), caller, 'org-1', { budgetMs: 5000 });
    expect(r.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((r.body as any).verification.domain_method).toBeNull();
    expect((r.body as any).verification.checks.domain).not.toBe('passed');
  });
});

describe('assertPublicHost (shared SSRF guard)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assertPublicHost } = require('../src/services/platform-detect');
  test.each(['[::1]', '::1', '[::ffff:7f00:1]', '::ffff:a00:5', '[::ffff:a9fe:a9fe]', '::ffff:127.0.0.1', '169.254.169.254', '10.1.2.3', 'fd00::1', 'fe80::1'])(
    'refuses %s',
    async (host) => {
      await expect(assertPublicHost(host)).rejects.toThrow('blocked_private_address');
    },
  );
  test.each(['93.184.216.34', '[2606:4700:4700::1111]', '::ffff:5db8:d822'])('allows the public address %s', async (host) => {
    await expect(assertPublicHost(host)).resolves.toBeUndefined();
  });
});

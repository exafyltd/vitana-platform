/**
 * VTID-04837 — the partner setup writes as shared functions, and retries that
 * are safe: a register retried with the same key returns the same org (no
 * second org, no second "registered" event), and a product retried with the
 * same key returns the product it already created instead of duplicating it.
 * Without a key both behave exactly as before.
 */
const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEventMock(...a) }));

import { createOrgProduct, normalizeSetupKey, registerPartnerOrg } from '../src/services/partner-setup';

type Call = { table: string; op: string; args: any[]; filters: Array<[string, any]> };

/** A tiny PostgREST-shaped fake: each table gets a handler deciding the result. */
function fakeSupabase(handlers: Record<string, (c: Call) => any>, calls: Call[]) {
  return {
    from(table: string) {
      let op = 'select';
      let args: any[] = [];
      const filters: Array<[string, any]> = [];
      const run = () => {
        const c = { table, op, args, filters };
        calls.push(c);
        return Promise.resolve(handlers[table](c));
      };
      const chain: any = {};
      chain.eq = (k: string, v: any) => { filters.push([k, v]); return chain; };
      chain.is = (k: string, v: any) => { filters.push([`is:${k}`, v]); return chain; };
      for (const m of ['order', 'limit', 'in']) chain[m] = () => chain;
      chain.select = (...a: any[]) => { if (op === 'select') args = a; return chain; };
      chain.insert = (...a: any[]) => { op = 'insert'; args = a; return chain; };
      chain.upsert = (...a: any[]) => { op = 'upsert'; args = a; return chain; };
      chain.maybeSingle = run;
      chain.single = run;
      chain.then = (res: any, rej: any) => run().then(res, rej);
      return chain;
    },
  } as any;
}

const REGISTER = {
  org_key: 'acme-ab12',
  display_name: 'Acme',
  org_type: 'shop',
  partner_type: 'supplier_shop',
  country: 'DE',
  website: 'https://acme.example',
};

beforeEach(() => emitOasisEventMock.mockClear());

describe('normalizeSetupKey', () => {
  it('accepts a bounded printable key and refuses anything else', () => {
    expect(normalizeSetupKey('ai-setup:3f2a9c1d')).toBe('ai-setup:3f2a9c1d');
    expect(normalizeSetupKey('  ai-setup:3f2a9c1d  ')).toBe('ai-setup:3f2a9c1d');
    expect(normalizeSetupKey('short')).toBeNull();
    expect(normalizeSetupKey('has space in it')).toBeNull();
    expect(normalizeSetupKey(undefined)).toBeNull();
    expect(normalizeSetupKey('x'.repeat(129))).toBeNull();
  });
});

describe('registerPartnerOrg', () => {
  function world() {
    const orgs: any[] = [];
    const members: any[] = [];
    const calls: Call[] = [];
    const handlers: Record<string, (c: Call) => any> = {
      partner_organizations: (c) => {
        if (c.op === 'insert') {
          const row = c.args[0];
          if (orgs.some((o) => o.org_key === row.org_key)) return { data: null, error: { code: '23505', message: 'dup' } };
          const created = { id: `org-${orgs.length + 1}`, lifecycle_state: 'draft', ...row };
          orgs.push(created);
          return { data: created, error: null };
        }
        const owner = c.filters.find(([k]) => k === 'owner_user_id')?.[1];
        const key = c.filters.find(([k]) => k === 'business_details->>setup_key')?.[1];
        const hit = orgs.find((o) => o.owner_user_id === owner && o.business_details?.setup_key === key);
        return { data: hit ?? null, error: null };
      },
      partner_organization_members: (c) => {
        if (c.op === 'insert') { members.push(c.args[0]); return { data: null, error: null }; }
        const org = c.filters.find(([k]) => k === 'partner_organization_id')?.[1];
        const user = c.filters.find(([k]) => k === 'user_id')?.[1];
        const m = members.find((x) => x.partner_organization_id === org && x.user_id === user);
        return { data: m ? { role: m.role } : null, error: null };
      },
    };
    return { s: fakeSupabase(handlers, calls), orgs, members, calls };
  }

  it('without a key it behaves as before: creates the org and its org_admin, emits once', async () => {
    const w = world();
    const r = await registerPartnerOrg(w.s, 'user-1', { ...REGISTER });
    expect(r.ok && r.status).toBe(201);
    expect(w.orgs).toHaveLength(1);
    expect(w.orgs[0].business_details).toEqual({});
    expect(w.members).toEqual([{ partner_organization_id: 'org-1', user_id: 'user-1', role: 'org_admin', granted_by: 'user-1' }]);
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    // No setup-key lookup without a key.
    expect(w.calls.filter((c) => c.table === 'partner_organizations' && c.op === 'select')).toHaveLength(0);
  });

  it('a retry with the same key returns the same org: no second org, no second event', async () => {
    const w = world();
    const first = await registerPartnerOrg(w.s, 'user-1', { ...REGISTER }, { setupKey: 'ai-setup:key-0001' });
    const again = await registerPartnerOrg(w.s, 'user-1', { ...REGISTER }, { setupKey: 'ai-setup:key-0001' });
    expect(first.ok && first.status).toBe(201);
    expect(again.ok && again.status).toBe(200);
    expect(again.ok && again.data.replayed).toBe(true);
    expect(again.ok && again.data.organization.id).toBe('org-1');
    expect(w.orgs).toHaveLength(1);
    expect(w.orgs[0].business_details).toEqual({ setup_key: 'ai-setup:key-0001' });
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
  });

  it('a replay repairs a missing org_admin membership (the old orphan-org gap)', async () => {
    const w = world();
    await registerPartnerOrg(w.s, 'user-1', { ...REGISTER }, { setupKey: 'ai-setup:key-0002' });
    w.members.length = 0;
    const again = await registerPartnerOrg(w.s, 'user-1', { ...REGISTER }, { setupKey: 'ai-setup:key-0002' });
    expect(again.ok).toBe(true);
    expect(w.members).toHaveLength(1);
  });

  it('another member cannot replay someone else’s key', async () => {
    const w = world();
    await registerPartnerOrg(w.s, 'user-1', { ...REGISTER }, { setupKey: 'ai-setup:key-0003' });
    const other = await registerPartnerOrg(w.s, 'user-2', { ...REGISTER }, { setupKey: 'ai-setup:key-0003' });
    // Same org_key, different owner: the unique key refuses it, no replay.
    expect(other.ok).toBe(false);
    expect(!other.ok && other.status).toBe(409);
  });

  it('keeps the route’s validation errors', async () => {
    const w = world();
    const r = await registerPartnerOrg(w.s, 'user-1', { ...REGISTER, display_name: '' });
    expect(!r.ok && r.status).toBe(400);
    expect(!r.ok && r.body).toEqual({ ok: false, error: 'display_name is required' });
    expect(w.orgs).toHaveLength(0);
  });
});

describe('createOrgProduct', () => {
  const PRODUCT = {
    title: 'Omega 3',
    price_cents: 1999,
    currency: 'eur',
    affiliate_url: 'https://acme.example/p/omega',
    origin_country: 'de',
    ships_to_countries: ['DE'],
  };

  function world() {
    const products: any[] = [];
    const calls: Call[] = [];
    const handlers: Record<string, (c: Call) => any> = {
      products: (c) => {
        if (c.op === 'insert') {
          const row = c.args[0];
          if (products.some((p) => p.source_product_id === row.source_product_id)) return { data: null, error: { code: '23505', message: 'dup' } };
          products.push(row);
          return { data: row, error: null };
        }
        if (c.args[1]?.head) return { data: null, count: products.length, error: null };
        const sid = c.filters.find(([k]) => k === 'source_product_id')?.[1];
        return { data: products.find((p) => p.source_product_id === sid) ?? null, error: null };
      },
      partner_onboarding_steps: () => ({ data: null, error: null }),
    };
    return { s: fakeSupabase(handlers, calls), products, calls };
  }

  it('without a key every call adds a new hidden draft (unchanged behaviour)', async () => {
    const w = world();
    await createOrgProduct(w.s, 'org-1', 'm-1', 'user-1', PRODUCT);
    await createOrgProduct(w.s, 'org-1', 'm-1', 'user-1', PRODUCT);
    expect(w.products).toHaveLength(2);
    expect(w.products.every((p) => p.is_active === false)).toBe(true);
  });

  it('with a key a retry returns the existing product instead of a duplicate', async () => {
    const w = world();
    const first = await createOrgProduct(w.s, 'org-1', 'm-1', 'user-1', PRODUCT, { productKey: 'ai-setup:key-0001:0' });
    const again = await createOrgProduct(w.s, 'org-1', 'm-1', 'user-1', PRODUCT, { productKey: 'ai-setup:key-0001:0' });
    expect(first.ok && first.status).toBe(201);
    expect(again.ok && again.status).toBe(200);
    expect(again.ok && again.data.replayed).toBe(true);
    expect(w.products).toHaveLength(1);
    expect(w.products[0].source_product_id).toBe('supplier_referral:m-1:key:ai-setup:key-0001:0');
  });

  it('refuses an invalid product before writing', async () => {
    const w = world();
    const r = await createOrgProduct(w.s, 'org-1', 'm-1', 'user-1', { ...PRODUCT, ships_to_countries: [] });
    expect(r.ok).toBe(false);
    expect(w.products).toHaveLength(0);
  });

  it('syncStep:false leaves the catalogue step for the caller to sync once', async () => {
    const w = world();
    await createOrgProduct(w.s, 'org-1', 'm-1', 'user-1', PRODUCT, { productKey: 'ai-setup:key-0002:0', syncStep: false });
    expect(w.calls.some((c) => c.table === 'partner_onboarding_steps')).toBe(false);
  });
});

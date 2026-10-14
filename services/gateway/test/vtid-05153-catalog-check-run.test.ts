/**
 * VTID-05153 — the supplier-catalog-check run over fakes (no network, no
 * database): which rows are loaded and picked (category, cap 20, rejected
 * orgs, test/service accounts), what one write sets and filters on, a
 * concurrent edit matching 0 rows, the probe outage, and the L9 metrics.
 */
import {
  ALLOWED_WRITE_KEYS,
  buildWriteBody,
  CatalogCheckDeps,
  guardFilters,
  productionProbe,
  runSupplierCatalogCheck,
} from '../src/services/catalog-check/run';
import { contentHash, CheckRow, ProbeOutcome } from '../src/services/catalog-check/validators';
import { prescreenClaims } from '../src/services/catalog-check/claim-prescreen';

const NOW = new Date('2026-10-14T13:00:00Z');

function product(id: string, over: Partial<CheckRow> = {}): CheckRow {
  return {
    id,
    merchant_id: 'm-1',
    title: `Product ${id}`,
    description: 'Supports normal muscle function.',
    brand: null,
    price_cents: 1990,
    compare_at_price_cents: null,
    currency: 'EUR',
    images: [`https://img.example.com/${id}.jpg`],
    affiliate_url: `https://shop.example.com/${id}`,
    origin_country: 'DE',
    ships_to_countries: ['DE'],
    ships_to_regions: null,
    availability: 'in_stock',
    category: 'supplements',
    subcategory: null,
    attributes: { kind: 'product' },
    gtin: null,
    sku: null,
    certifications: [],
    is_active: false,
    created_at: `2026-10-01T00:00:${id.slice(-2).padStart(2, '0')}Z`,
    ...over,
  };
}

interface World {
  products: CheckRow[];
  merchants: Array<{ id: string; owner_user_id: string | null; partner_organization_id: string | null }>;
  orgs: Array<{ id: string; lifecycle_state: string; owner_user_id: string | null }>;
  excluded: Set<string>;
}

function makeDeps(world: World, opts: { probe?: (url: string) => Promise<ProbeOutcome>; matched?: (filters: string) => number; excludedFails?: boolean } = {}) {
  const gets: string[] = [];
  const patches: Array<{ filters: string; body: Record<string, any> }> = [];
  const deps: CatalogCheckDeps = {
    get: async <T>(path: string): Promise<T> => {
      gets.push(path);
      if (path.startsWith('/rest/v1/products?')) {
        const offset = Number(/offset=(\d+)/.exec(path)![1]);
        return world.products.slice(offset, offset + 1000) as unknown as T;
      }
      const ids = decodeURIComponent(/id=in\.\(([^)]*)\)/.exec(path)![1]).split(',');
      if (path.startsWith('/rest/v1/merchants?')) return world.merchants.filter((m) => ids.includes(m.id)) as unknown as T;
      if (path.startsWith('/rest/v1/partner_organizations?')) return world.orgs.filter((o) => ids.includes(o.id)) as unknown as T;
      throw new Error(`unexpected GET ${path}`);
    },
    patchProducts: async (filters, body) => {
      patches.push({ filters, body });
      return opts.matched ? opts.matched(filters) : 1;
    },
    excludedAccounts: async () => {
      if (opts.excludedFails) throw new Error('excluded accounts unavailable');
      return world.excluded;
    },
    probe: opts.probe ?? (async () => ({ kind: 'ok' })),
    claimCheck: prescreenClaims,
  };
  return { deps, gets, patches };
}

function world(products: CheckRow[]): World {
  return {
    products,
    merchants: [
      { id: 'm-1', owner_user_id: 'owner-1', partner_organization_id: 'org-1' },
      { id: 'm-rej', owner_user_id: 'owner-2', partner_organization_id: 'org-rej' },
      { id: 'm-test', owner_user_id: 'test-bot', partner_organization_id: 'org-test' },
      { id: 'm-portal', owner_user_id: 'owner-4', partner_organization_id: null },
    ],
    orgs: [
      { id: 'org-1', lifecycle_state: 'draft', owner_user_id: 'owner-1' },
      { id: 'org-rej', lifecycle_state: 'rejected', owner_user_id: 'owner-2' },
      { id: 'org-test', lifecycle_state: 'live', owner_user_id: 'test-bot' },
    ],
    excluded: new Set(['test-bot']),
  };
}

describe('candidate selection', () => {
  it('reads only supplier rows of the wave-1 category', async () => {
    const { deps, gets } = makeDeps(world([product('p-01')]));
    await runSupplierCatalogCheck(deps, NOW);
    expect(gets[0]).toMatch(/^\/rest\/v1\/products\?source_network=eq\.supplier_referral&category=eq\.supplements&select=/);
  });

  it('skips rejected orgs, test/service accounts and rows without a known merchant; keeps an org-less portal merchant', async () => {
    const w = world([
      product('p-01'),
      product('p-02', { merchant_id: 'm-rej' }),
      product('p-03', { merchant_id: 'm-test' }),
      product('p-04', { merchant_id: 'm-unknown' }),
      product('p-05', { merchant_id: 'm-portal' }),
    ]);
    const { deps, patches } = makeDeps(w);
    const v = await runSupplierCatalogCheck(deps, NOW);
    expect(patches.map((p) => decodeURIComponent(/id=eq\.([^&]+)/.exec(p.filters)![1])).sort()).toEqual(['p-01', 'p-05']);
    expect((v.findings as any).run).toMatchObject({ pool_rows: 2, excluded_rows: 3, candidates: 2 });
  });

  it('checks at most 20 rows per run', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => product(`p-${String(i).padStart(2, '0')}`));
    const { deps, patches } = makeDeps(world(rows));
    const v = await runSupplierCatalogCheck(deps, NOW);
    expect(patches).toHaveLength(20);
    expect((v.findings as any).metrics.rows_checked).toBe(20);
  });

  it('fails closed when the test/service account list cannot be read: no write', async () => {
    const { deps, patches } = makeDeps(world([product('p-01')]), { excludedFails: true });
    await expect(runSupplierCatalogCheck(deps, NOW)).rejects.toThrow(/excluded accounts/);
    expect(patches).toHaveLength(0);
  });
});

describe('the write', () => {
  it('sets attributes.catalog_check and, on a row that is not live, the normalized fields — never is_active or merchant_id', async () => {
    const { deps, patches } = makeDeps(world([product('p-01', { title: '  Product   p-01 ', currency: 'eur', attributes: { kind: 'product', source: 'csv' } })]));
    await runSupplierCatalogCheck(deps, NOW);
    const { body, filters } = patches[0];
    expect(Object.keys(body).sort()).toEqual(['attributes', 'currency', 'title']);
    expect(body.title).toBe('Product p-01');
    expect(body.currency).toBe('EUR');
    expect(body.attributes.source).toBe('csv');
    expect(body.attributes.catalog_check).toMatchObject({ v: 1, state: 'ready_for_review', strikes: 0, normalized: ['title', 'currency'] });
    for (const k of Object.keys(body)) expect(ALLOWED_WRITE_KEYS).toContain(k);
    // Filters: the row as read, and not live for a write-back.
    expect(filters).toContain('id=eq.p-01');
    expect(filters).toContain(`title=eq.${encodeURIComponent('  Product   p-01 ')}`);
    expect(filters).toContain('currency=eq.eur');
    expect(filters).toContain(`attributes=eq.${encodeURIComponent(JSON.stringify({ kind: 'product', source: 'csv' }))}`);
    expect(filters).toContain('is_active=eq.false');
  });

  it('a live row gets its result only: no write-back, no is_active filter', async () => {
    const { deps, patches } = makeDeps(world([product('p-01', { is_active: true, title: ' x  y ' })]));
    await runSupplierCatalogCheck(deps, NOW);
    expect(Object.keys(patches[0].body)).toEqual(['attributes']);
    expect(patches[0].body.attributes.catalog_check.normalized).toEqual([]);
    expect(patches[0].filters).not.toContain('is_active');
  });

  it('a concurrent edit matches 0 rows: counted as a conflict, no result recorded, checked again next run', async () => {
    const { deps } = makeDeps(world([product('p-01'), product('p-02')]), { matched: (f) => (f.includes('id=eq.p-01') ? 0 : 1) });
    const v = await runSupplierCatalogCheck(deps, NOW);
    expect((v.findings as any).run.write_conflicts).toBe(1);
    expect((v.findings as any).metrics.rows_checked).toBe(1);
    expect(v.status).toBe('success');
  });

  it('a failed write makes the run partial (no breach)', async () => {
    const { deps } = makeDeps(world([product('p-01')]));
    deps.patchProducts = async () => { throw new Error('PATCH products → 500'); };
    const v = await runSupplierCatalogCheck(deps, NOW);
    expect(v.status).toBe('partial');
    expect(v.breach).toBeUndefined();
  });

  it('buildWriteBody refuses any key outside attributes and the normalizable fields', () => {
    expect(() => buildWriteBody({}, { is_active: true } as any)).toThrow(/is_active/);
    expect(() => buildWriteBody({}, { merchant_id: 'x' } as any)).toThrow(/merchant_id/);
    expect(() => buildWriteBody({}, { listing_hold: null } as any)).toThrow(/listing_hold/);
    expect(ALLOWED_WRITE_KEYS).not.toEqual(expect.arrayContaining(['is_active']));
  });

  it('guardFilters pins array fields it writes by set equality and nulls by is.null', () => {
    const r = product('p-01', { images: ['https://a/1.jpg', 'https://a/1.jpg'], compare_at_price_cents: null, currency: null });
    const f = guardFilters(r, { images: ['https://a/1.jpg'] });
    const lit = encodeURIComponent('{"https://a/1.jpg","https://a/1.jpg"}');
    expect(f).toContain(`images=cs.${lit}&images=cd.${lit}`);
    expect(f).toContain('currency=is.null');
  });
});

describe('strikes across runs', () => {
  it('the same failure three runs in a row returns the row to the supplier; then it is not re-checked until edited', async () => {
    const w = world([product('p-01', { price_cents: 0 })]);
    const { deps, patches } = makeDeps(w);
    // Apply each write to the world so the next run reads it.
    const apply = () => { w.products[0] = { ...w.products[0], ...patches[patches.length - 1].body }; };
    let t = NOW.getTime();
    for (const expected of [['needs_fix', 1], ['needs_fix', 2], ['returned_to_supplier', 3]] as const) {
      await runSupplierCatalogCheck(deps, new Date(t));
      apply();
      expect((w.products[0].attributes as any).catalog_check).toMatchObject({ state: expected[0], strikes: expected[1] });
      t += 21 * 3600 * 1000;
    }
    const before = patches.length;
    await runSupplierCatalogCheck(deps, new Date(t));
    expect(patches).toHaveLength(before);
    // The supplier edits the row: checked again, strikes start over.
    w.products[0] = { ...w.products[0], price_cents: 1990 };
    await runSupplierCatalogCheck(deps, new Date(t));
    apply();
    expect((w.products[0].attributes as any).catalog_check).toMatchObject({ state: 'ready_for_review', strikes: 0 });
  });
});

describe('media probe outage', () => {
  it('more than half of the probes failing at the network level: image_unchecked for every row, no image error', async () => {
    const { deps, patches } = makeDeps(world([product('p-01'), product('p-02'), product('p-03')]), {
      probe: async (url) => (url.endsWith('p-03.jpg') ? { kind: 'ok' } : { kind: 'network_error' }),
    });
    const v = await runSupplierCatalogCheck(deps, NOW);
    expect((v.findings as any).run.probes).toEqual({ total: 3, network_errors: 2, outage: true });
    for (const p of patches) {
      expect(p.body.attributes.catalog_check.flags).toContain('image_unchecked');
      expect(p.body.attributes.catalog_check.errors).toEqual([]);
    }
    // image_unchecked rows do not count as ready for approval.
    expect((v.findings as any).metrics.ready_for_approval_share).toBe(0);
  });

  it('without an outage a 404 image is a needs_fix error', async () => {
    const { deps, patches } = makeDeps(world([product('p-01'), product('p-02'), product('p-03')]), {
      probe: async (url) => (url.endsWith('p-01.jpg') ? { kind: 'http_error', status: 404 } : { kind: 'ok' }),
    });
    await runSupplierCatalogCheck(deps, NOW);
    const p1 = patches.find((p) => p.filters.includes('id=eq.p-01'))!;
    expect(p1.body.attributes.catalog_check).toMatchObject({ state: 'needs_fix', errors: [{ code: 'image_unreachable', field: 'images', params: { index: 0, status: 404 } }] });
  });
});

describe('the L9 metrics on fixture rows', () => {
  it('failure rate over the run, ready share over the whole category, per-state and per-code counts, not_measured with reasons', async () => {
    const readyBefore = product('p-09');
    readyBefore.attributes = {
      kind: 'product',
      catalog_check: { v: 1, state: 'ready_for_review', checked_at: NOW.toISOString(), content_hash: contentHash(readyBefore), errors: [], flags: [], normalized: [], fingerprint: '', strikes: 0 },
    };
    const { deps } = makeDeps(world([
      product('p-01'),
      product('p-02', { price_cents: 0 }),
      product('p-03', { images: [] }),
      product('p-04', { description: 'Heilt Krebs.' }),
      readyBefore,
    ]));
    const v = await runSupplierCatalogCheck(deps, NOW);
    const m = (v.findings as any).metrics;
    expect(m).toMatchObject({
      category: 'supplements',
      rows_checked: 4,
      rows_auto_normalized: 1,
      validation_failure_rate: 0.5,
      ready_for_approval_share: 0.4,
      ready_for_approval_target: 0.8,
      by_state: { ready_for_review: 2, needs_fix: 2, needs_review: 1 },
      by_error_code: { price_not_positive: 1, image_missing: 1 },
    });
    expect(m.time_to_listing).toEqual({ state: 'not_measured', reason: expect.any(String) });
    expect(m.human_edits_per_listing).toEqual({ state: 'not_measured', reason: expect.any(String) });
    expect(v.status).toBe('success');
    expect(v.breach).toBeUndefined();
    expect(v.summary).toMatch(/^✅ L9 Supplier catalog: 4 supplements rows checked, ready for approval 40%/);
  });

  it('an empty category is a green run with n/a numbers', async () => {
    const { deps } = makeDeps(world([]));
    const v = await runSupplierCatalogCheck(deps, NOW);
    expect((v.findings as any).metrics).toMatchObject({ rows_checked: 0, validation_failure_rate: null, ready_for_approval_share: null });
    expect(v.status).toBe('success');
  });
});

describe('productionProbe → ProbeOutcome (SSRF-guarded HEAD, stubbed fetch)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const res = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

  it('200 image → ok; 200 html → not_image; 404 → http_error', async () => {
    global.fetch = jest.fn(async () => res(200, { 'content-type': 'image/jpeg' })) as any;
    expect(await productionProbe('https://93.184.216.34/a.jpg')).toEqual({ kind: 'ok' });
    global.fetch = jest.fn(async () => res(200, { 'content-type': 'text/html' })) as any;
    expect(await productionProbe('https://93.184.216.34/a.jpg')).toEqual({ kind: 'not_image', content_type: 'text/html' });
    global.fetch = jest.fn(async () => res(404)) as any;
    expect(await productionProbe('https://93.184.216.34/a.jpg')).toEqual({ kind: 'http_error', status: 404 });
  });

  it('a private host is blocked before any request; a timeout is a network error', async () => {
    const f = jest.fn(async () => res(200, { 'content-type': 'image/png' }));
    global.fetch = f as any;
    expect(await productionProbe('http://127.0.0.1/a.png')).toEqual({ kind: 'blocked' });
    expect(await productionProbe('http://10.0.0.5/a.png')).toEqual({ kind: 'blocked' });
    expect(f).not.toHaveBeenCalled();
    global.fetch = jest.fn(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }) as any;
    expect(await productionProbe('https://93.184.216.34/a.png')).toEqual({ kind: 'network_error' });
  });
});

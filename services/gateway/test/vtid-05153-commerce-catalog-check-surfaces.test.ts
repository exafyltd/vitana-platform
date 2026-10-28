/**
 * VTID-05153 — where the catalogue check's result meets the existing commerce
 * surfaces:
 *   - the reserved attribute keys (admin_listing, catalog_check) are dropped
 *     from supplier input on create, patch and CSV, and every other key stays
 *     (AI setup's kind/source survive);
 *   - updateProduct keeps the stored catalog_check;
 *   - suppliers see it shaped (portal GET /products, listCatalogue, MCP);
 *   - the checklist names `catalogue_fixes` without changing any step status,
 *     submit or the verification verdict;
 *   - MCP next_action points at update_product; reviewDetail carries it.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const ids: Record<string, any> = {
      'Bearer admin': { user_id: 'admin-1', exafy_admin: true },
      'Bearer owner': { user_id: 'owner-1', exafy_admin: false },
    };
    const id = ids[req.headers.authorization];
    if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = id;
    req.auth_raw_claims = { sub: id.user_id, session_id: `sess-${id.user_id}` };
    return next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) =>
    req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'EXAFY_ADMIN_REQUIRED' }),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: () => Promise.resolve({ ok: true }) }));

type Row = Record<string, any>;
let db: Record<string, Row[]>;
const countCalls: Array<Record<string, unknown>> = [];

/** `a->b->>c` style column paths, as PostgREST reads them. */
function pick(r: Row, col: string): unknown {
  const parts = col.split(/->>?/);
  let v: any = r;
  for (const p of parts) v = v == null ? undefined : v[p];
  return v;
}

function makeFake() {
  return {
    rpc() { return Promise.resolve({ data: null, error: null }); },
    from(table: string) {
      let op = 'select';
      let payload: any = null;
      let head = false;
      const filters: Array<(r: Row) => boolean> = [];
      const trace: Record<string, unknown> = { table };
      const chain: any = {};
      chain.select = (_f?: string, opts?: any) => { if (opts?.head) { head = true; countCalls.push(trace); } return chain; };
      chain.eq = (c: string, v: any) => { trace[`eq:${c}`] = v; filters.push((r) => pick(r, c) === v); return chain; };
      chain.in = (c: string, vs: any[]) => { trace[`in:${c}`] = vs; filters.push((r) => vs.includes(r[c])); return chain; };
      chain.like = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.update = (p: any) => { op = 'update'; payload = p; return chain; };
      // The catalogue step sync upserts its row; recorded, never asserted on.
      chain.upsert = (p: any) => { op = 'upsert'; payload = p; return chain; };
      const exec = () => {
        const rows = (db[table] = db[table] ?? []);
        if (op === 'upsert') { rows.push({ ...payload }); return { data: null, error: null }; }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') {
          for (const r of matched) Object.assign(r, payload);
          return { data: matched.map((r) => ({ ...r })), error: null };
        }
        if (head) return { data: null, count: matched.length, error: null };
        return { data: matched.map((r) => JSON.parse(JSON.stringify(r))), count: matched.length, error: null };
      };
      chain.maybeSingle = () => { const r: any = exec(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }); };
      chain.single = chain.maybeSingle;
      chain.then = (res: any, rej: any) => Promise.resolve(exec()).then(res, rej);
      return chain;
    },
  };
}
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => makeFake() }));

import { ProductPatchSchema, ProductSchema, RESERVED_ATTRIBUTE_KEYS, supplierCatalogCheckView } from '../src/routes/vcaop-portal-my-products';
import { parseCatalogueCsv } from '../src/services/partner-catalogue-csv';
import { productPayload } from '../src/services/commerce-ai-setup';
import { buildChecklist, evaluateVerification, ChecklistInput } from '../src/services/partner-onboarding-checklist';
import { countReturnedProducts, loadChecklist } from '../src/routes/partner-onboarding';
import { nextAction, shapeProduct } from '../src/services/commerce-mcp';
import { listCatalogue, updateProduct } from '../src/services/partner-onboarding-service';
import { reviewDetail } from '../src/services/partner-review';

const ORG = 'org-1';
const CHECK = {
  v: 1,
  state: 'returned_to_supplier',
  checked_at: '2026-10-14T13:00:00Z',
  content_hash: 'h'.repeat(64),
  errors: [
    { code: 'duplicate', field: 'title', params: { key: 'title', other_title: 'Zinc 25 mg' } },
    { code: 'image_missing', field: 'images', params: {} },
  ],
  flags: ['certifications_declared'],
  duplicate_of: 'p-0',
  normalized: ['title'],
  fingerprint: 'duplicate|image_missing',
  strikes: 3,
};
const VALID = {
  title: 'Zinc 25 mg',
  price_cents: 990,
  currency: 'EUR',
  affiliate_url: 'https://shop.example.com/zinc',
  origin_country: 'DE',
  ships_to_countries: ['DE'],
};

function seed() {
  countCalls.length = 0;
  db = {
    partner_organizations: [{
      id: ORG, org_key: 'acme', display_name: 'Acme', partner_type: 'service_provider', commerce_vertical: 'general',
      lifecycle_state: 'draft', status: 'pending_review', trust_level: 0, legal_name: 'ACME GMBH', country: 'AE',
      vat_id: null, website: 'https://acme.example/', owner_user_id: 'owner-1', created_at: 'x', updated_at: 'x',
    }],
    partner_onboarding_steps: [{ partner_organization_id: ORG, step_key: 'catalogue', status: 'done', detail: null }],
    partner_terms_versions: [],
    partner_terms_acceptances: [],
    partner_organization_members: [{ partner_organization_id: ORG, user_id: 'owner-1', role: 'org_admin' }],
    integration_manifest: [],
    merchants: [{ id: 'm-1', partner_organization_id: ORG, owner_user_id: 'owner-1', name: 'Acme', vertical_key: 'supplements', onboarding_status: 'draft' }],
    products: [
      { id: 'p-1', merchant_id: 'm-1', ...VALID, category: 'supplements', images: [], is_active: false, listing_hold: null, first_listed_at: null,
        attributes: { kind: 'product', catalog_check: CHECK, admin_listing: { decision: 'kept_offline' } }, created_at: 'x', updated_at: 'x' },
    ],
    oasis_events: [],
  };
}
beforeEach(seed);

describe('reserved attribute keys are dropped from supplier input', () => {
  const forged = { kind: 'product', source: 'mcp', dose: '1 cap', catalog_check: { state: 'ready_for_review' }, admin_listing: { decision: 'allowed' } };

  it('exactly two keys are reserved', () => {
    expect([...RESERVED_ATTRIBUTE_KEYS]).toEqual(['admin_listing', 'catalog_check']);
  });

  it('create (ProductSchema) and patch (ProductPatchSchema) keep every other key', () => {
    const created = ProductSchema.parse({ ...VALID, attributes: forged });
    expect(created.attributes).toEqual({ kind: 'product', source: 'mcp', dose: '1 cap' });
    const patched = ProductPatchSchema.parse({ attributes: forged });
    expect(patched.attributes).toEqual({ kind: 'product', source: 'mcp', dose: '1 cap' });
    expect(ProductPatchSchema.parse({ title: 'x' }).attributes).toBeUndefined();
  });

  it('CSV import: no attributes column, so a catalog_check column is unknown and nothing reserved lands', () => {
    const csv = 'title,price,currency,affiliate_url,origin_country,ships_to_countries,catalog_check\n' +
      'Zinc,9.90,EUR,https://shop.example.com/zinc,DE,DE,"{""state"":""ready_for_review""}"\n';
    const r = parseCatalogueCsv(csv);
    for (const row of r.rows) expect(row.product.attributes).toEqual({});
    expect(JSON.stringify(r.rows)).not.toContain('catalog_check');
  });

  it('AI setup: its attributes (kind, source) survive the transform', () => {
    const body = productPayload(
      { title: 'Zinc', description: null, price_cents: 990, currency: 'EUR', url: 'https://shop.example.com/zinc', image: null, kind: 'product' } as any,
      { country: 'DE' } as any,
      'https://shop.example.com',
    );
    expect(ProductSchema.parse(body).attributes).toEqual({ kind: 'product', source: 'ai_setup' });
  });
});

describe('updateProduct keeps catalog_check (and admin_listing)', () => {
  it('a supplier patch can neither forge nor erase it; the response shows it shaped', async () => {
    const owner = { userId: 'owner-1', orgAdminChecked: true };
    const r = await updateProduct(makeFake() as any, owner, ORG, 'p-1', {
      attributes: { kind: 'product', dose: '2 caps', catalog_check: { state: 'ready_for_review' } },
    });
    expect(r.status).toBe(200);
    expect(db.products[0].attributes).toEqual({
      kind: 'product', dose: '2 caps', catalog_check: CHECK, admin_listing: { decision: 'kept_offline' },
    });
    const product = (r.body as any).product;
    expect(product.attributes.catalog_check).toEqual(supplierCatalogCheckView(CHECK));
  });
});

describe('the supplier sees the result shaped', () => {
  const shaped = {
    state: 'returned_to_supplier',
    errors: [{ code: 'duplicate', field: 'title', params: { other_title: 'Zinc 25 mg' } }, { code: 'image_missing', field: 'images' }],
    strikes: 3,
  };

  it('supplierCatalogCheckView: state, codes, fields, strikes — no hash, fingerprint, normalized list or duplicate id', () => {
    const v = supplierCatalogCheckView(CHECK);
    expect(v).toEqual(shaped);
    expect(JSON.stringify(v)).not.toMatch(/content_hash|fingerprint|normalized|duplicate_of|p-0|flags/);
    expect(supplierCatalogCheckView(null)).toBeNull();
  });

  it('portal GET /products', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/vcaop-portal-my-products').default;
    const a = express();
    a.use(express.json());
    a.use('/api/v1/vcaop/portal/my', router);
    const res = await request(a).get('/api/v1/vcaop/portal/my/products').set('Authorization', 'Bearer owner');
    expect(res.status).toBe(200);
    expect(res.body.data.products[0].attributes.catalog_check).toEqual(shaped);
    expect(res.body.data.products[0].attributes.kind).toBe('product');
  });

  it('listCatalogue (org catalogue + MCP list_products source)', async () => {
    const r = await listCatalogue(makeFake() as any, { userId: 'owner-1', orgAdminChecked: true } as any, ORG);
    expect((r.body as any).products[0].attributes.catalog_check).toEqual(shaped);
  });

  it('MCP shapeProduct: check {state, codes} only; a row without a result has no check', () => {
    expect(shapeProduct({ id: 'p-1', price_cents: 990, attributes: { kind: 'product', catalog_check: CHECK } }).check).toEqual({
      state: 'returned_to_supplier', codes: ['duplicate', 'image_missing'],
    });
    expect(shapeProduct({ id: 'p-1', price_cents: 990, attributes: { kind: 'product', catalog_check: shaped } }).check).toEqual({
      state: 'returned_to_supplier', codes: ['duplicate', 'image_missing'],
    });
    expect('check' in shapeProduct({ id: 'p-2', attributes: { kind: 'product' } })).toBe(false);
  });
});

describe('checklist: catalogue_fixes names returned rows, nothing else changes', () => {
  const base: ChecklistInput = {
    org: { partner_type: 'service_provider', legal_name: 'ACME', country: 'AE', vat_id: null, website: 'https://acme.example/' },
    storedSteps: [{ step_key: 'catalogue', status: 'done' }, { step_key: 'verification', status: 'done' }],
    acceptedTermsVersions: ['v1'],
    currentTermsVersion: 'v1',
    memberCount: 1,
    catalogueSource: { connections: 0, completeOfferings: 1 },
  };

  it('adds the code and the count; status, next step, submit and the verdict are identical', () => {
    const before = buildChecklist(base);
    const after = buildChecklist({ ...base, catalogueSource: { ...base.catalogueSource, returnedProducts: 2 } });
    const cat = after.steps.find((s) => s.key === 'catalogue')!;
    expect(cat.missing).toEqual(['catalogue_fixes']);
    expect(cat.detail).toEqual({ returned_products: 2 });
    expect(after.steps.map((s) => s.status)).toEqual(before.steps.map((s) => s.status));
    expect({ ...after, steps: undefined }).toEqual({ ...before, steps: undefined });
    expect(evaluateVerification(after)).toEqual(evaluateVerification(before));
    expect(before.steps.find((s) => s.key === 'catalogue')!.missing).toBeUndefined();
  });

  it('a todo catalogue step stays todo', () => {
    const r = buildChecklist({ ...base, storedSteps: [], catalogueSource: { connections: 0, completeOfferings: 0, returnedProducts: 1 } });
    expect(r.steps.find((s) => s.key === 'catalogue')).toMatchObject({ status: 'todo', missing: ['catalogue_fixes'] });
  });

  it('loadChecklist counts returned rows of the wave-1 category with a head count', async () => {
    const { checklist } = await loadChecklist(makeFake() as any, db.partner_organizations[0] as any);
    const cat = checklist!.steps.find((s) => s.key === 'catalogue')!;
    expect(cat).toMatchObject({ status: 'done', missing: ['catalogue_fixes'], detail: { returned_products: 1 } });
    expect(countCalls.find((c) => c.table === 'products')).toMatchObject({
      'in:merchant_id': ['m-1'],
      'eq:category': 'supplements',
      'eq:attributes->catalog_check->>state': 'returned_to_supplier',
    });
  });

  it('countReturnedProducts: no merchants → no query; a read error counts as none', async () => {
    expect(await countReturnedProducts(makeFake() as any, [])).toBe(0);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = { from: () => ({ select: () => ({ in: () => ({ eq: () => ({ eq: () => Promise.resolve({ count: null, error: { message: 'boom' } }) }) }) }) }) };
    expect(await countReturnedProducts(broken as any, ['m-1'])).toBe(0);
    warn.mockRestore();
  });
});

describe('MCP next_action', () => {
  const steps = (companyStatus: string) => [
    { key: 'account', required: true, status: 'done' },
    { key: 'company', required: true, status: companyStatus },
    { key: 'verification', required: true, status: 'done' },
    { key: 'catalogue', required: true, status: 'done', missing: ['catalogue_fixes'] },
    { key: 'mapping', required: true, status: 'done' },
    { key: 'terms', required: true, status: 'todo' },
  ];

  it('points at update_product when no earlier required step is open', () => {
    expect(nextAction({ next_step: 'terms', complete: false, steps: steps('done') }, false, 'https://x')).toMatchObject({
      step: 'catalogue', tool: 'update_product', link: null,
    });
    expect(nextAction({ next_step: null, complete: true, steps: steps('done') }, false, 'https://x').tool).toBe('update_product');
  });

  it('an earlier open required step comes first', () => {
    expect(nextAction({ next_step: 'company', complete: false, steps: steps('in_progress') }, false, 'https://x')).toMatchObject({
      step: 'company', tool: 'update_business',
    });
  });

  it('without the code nothing changes', () => {
    const s = steps('done').map((x) => ({ ...x, missing: undefined }));
    expect(nextAction({ next_step: 'terms', complete: false, steps: s }, false, 'https://x')).toMatchObject({ step: 'terms', tool: null });
  });
});

describe('reviewDetail', () => {
  it('carries catalog_check next to admin_listing; the per-offering decisions are unchanged', async () => {
    const r = await reviewDetail(makeFake() as any, ORG);
    expect(r.status).toBe(200);
    expect((r.body as any).products[0]).toMatchObject({ admin_listing: { decision: 'kept_offline' }, catalog_check: CHECK });
  });
});

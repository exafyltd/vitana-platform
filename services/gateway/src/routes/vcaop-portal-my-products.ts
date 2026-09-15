/**
 * Supplier self-service catalogue (VTID-03894).
 *
 * The manual counterpart to the MCP/agent path: a supplier who would rather
 * fill in a form gets one, and this is what it talks to.
 *
 * WHY A NEW ROUTER RATHER THAN REUSING WHAT EXISTS
 *
 *  - `/api/v1/catalog/ingest/*` authenticates with a single PLATFORM-WIDE
 *    `INGEST_API_KEY` (or the service-role key). Handing that to a supplier
 *    would hand them every other supplier's catalogue. It is not scopeable.
 *  - `/api/v1/admin/marketplace/*` is `requireTenantAdmin` and has no POST at
 *    all — it curates rows the analyzer already picked; it cannot create one.
 *  - Writing from the browser is impossible regardless: RLS on `products` is
 *    `FOR ALL TO service_role`, `authenticated` gets SELECT on is_active rows.
 *
 * So: the same owner-scoped shape `vcaop-portal-my.ts` already proves, keyed on
 * `merchants.owner_user_id` (added by this VTID's migration).
 *
 * MAXINA SCOPE NOTE: `products`/`merchants` carry no tenant_id — merchants are
 * global by design and tenant curation happens downstream in
 * `default_feed_config`. "Maxina only" is therefore about the supplier-facing
 * portal and flow, not a column on these rows. Do not invent one here.
 */
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';

const router = Router();

// Any authenticated user, not exafy_admin — a supplier owns their own rows.
// Same posture as vcaop-portal-my.ts, which this router sits alongside.
router.use(requireAuth as any);

function supa(res: Response) {
  const s = getSupabase();
  if (!s) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
    return null;
  }
  return s;
}
const userId = (req: Request): string => String((req as any).identity?.user_id || '');

/* ------------------------------------------------------------------ *
 * GET /verticals — the whole form schema in one call.
 *
 * The form renders from this and the spreadsheet template is generated from
 * it, so the two can never disagree about what a wine needs.
 * ------------------------------------------------------------------ */
router.get('/verticals', async (req: Request, res: Response) => {
  const s = supa(res);
  if (!s) return;

  const [{ data: verticals, error: vErr }, { data: fields, error: fErr }] = await Promise.all([
    s.from('catalog_verticals').select('key,display_label,description,icon,is_regulated,sort_order')
      .eq('is_active', true).order('sort_order'),
    s.from('catalog_vertical_fields')
      .select('vertical_key,field_key,display_label,help_text,data_type,vocabulary,unit,is_prominent,sort_order')
      .eq('is_active', true).order('sort_order'),
  ]);
  if (vErr || fErr) {
    res.status(500).json({ ok: false, error: 'failed to load verticals' });
    return;
  }

  // Only the vocabularies actually referenced by a live field — no point
  // shipping the supplement ingredient list to a form that never asks for it.
  const vocabNames = [...new Set((fields ?? []).map((f: any) => f.vocabulary).filter(Boolean))];
  let options: Record<string, Array<{ value: string; label: string }>> = {};
  if (vocabNames.length > 0) {
    const { data: vocab } = await s.from('catalog_vocabulary')
      .select('vocabulary,value,display_label,sort_order')
      .in('vocabulary', vocabNames).eq('is_active', true).order('sort_order');
    for (const row of vocab ?? []) {
      (options[row.vocabulary] ??= []).push({ value: row.value, label: row.display_label || row.value });
    }
  }

  res.json({
    ok: true,
    data: {
      verticals: (verticals ?? []).map((v: any) => ({
        ...v,
        fields: (fields ?? []).filter((f: any) => f.vertical_key === v.key),
      })),
      options,
    },
  });
});

/* ------------------------------------------------------------------ *
 * The supplier's own merchant row.
 * ------------------------------------------------------------------ */
async function findOwnMerchant(s: any, owner: string) {
  const { data } = await s.from('merchants')
    .select('id,name,vertical_key,onboarding_status,merchant_country,currencies')
    .eq('owner_user_id', owner).maybeSingle();
  return data ?? null;
}

/**
 * The ONLY networks with a real conversion path today, verified against the
 * code rather than a brochure:
 *
 *   awin     — pulled. creditAwinConversions() reads our publisher account's
 *              transactions and resolves each by advertiser id.
 *   admitad  — pushed. routes/vcaop-postback.ts mounts /admitad and nothing else.
 *
 * CJ, Rakuten, Impact and Amazon have NO conversion path. Adding one here
 * without building its plumbing would record a supplier's answer and silently
 * attribute none of their sales — worse than not asking, because it looks
 * like it works.
 */
export const ATTRIBUTING_NETWORKS = ['awin', 'admitad'] as const;

/**
 * What a self-registered supplier's rows are tagged with — and the reason it is
 * NOT `'manual'` (VTID-03894).
 *
 * `checkout-service.ts` routes every cart line by `products.source_network`:
 * anything in its `FIRST_PARTY_SOURCE_NETWORKS` (`manual`, `partner`) debits the
 * BUYER'S VITANA WALLET and writes a CONVERTED order whose meaning is "Vitana
 * fulfils". Everything else clicks out to the merchant and settles later.
 *
 * A supplier product is the second thing. It carries an `affiliate_url` to the
 * supplier's own shop, and nothing in this platform pays a supplier or tells
 * them to ship — `credit-recommender.ts` credits the RECOMMENDER, a community
 * member, not the merchant. Tagged `'manual'`, approving one product would take
 * a member's money for an order nobody would ever fulfil.
 *
 * Direct sale is a deliberate future opt-in that needs payout and fulfilment
 * first. Until then this value must stay outside the first-party set, which
 * `supplier-source-network.test.ts` enforces rather than trusts.
 */
export const SUPPLIER_SOURCE_NETWORK = 'supplier_referral';

const MerchantSchema = z.object({
  name: z.string().min(1).max(256),
  vertical_key: z.string().min(1).max(50),
  merchant_country: z.string().length(2).transform((c) => c.toUpperCase()).optional(),
  storefront_url: z.string().url().optional(),
  // 'other' is a real, allowed answer — a supplier not on a network can still
  // list. It is recorded so "we never asked" and "they told us none" stay
  // distinguishable; it simply carries no advertiser id.
  affiliate_network: z.enum([...ATTRIBUTING_NETWORKS, 'other']).optional(),
  affiliate_advertiser_id: z.string().min(1).max(128).optional(),
  // Typical delivery time per region, in days. Columns already exist on
  // `merchants` and catalog-ingest already populates them from feeds — a
  // supplier who cannot answer leaves them null, which is what they are today.
  //
  // Bounds match catalog-ingest's own schema (types/catalog-ingest.ts) rather
  // than being invented here, so a supplier-entered value and a feed-entered
  // value cannot disagree about what is a legal number.
  //
  // NOTHING RENDERS THESE YET — zero readers in the gateway or the frontend,
  // verified. They are collected so supplier merchants stop being the only
  // ones with a null, not because a buyer currently sees them.
  avg_delivery_days_eu: z.number().int().min(0).max(120).optional(),
  avg_delivery_days_us: z.number().int().min(0).max(120).optional(),
  avg_delivery_days_mena: z.number().int().min(0).max(120).optional(),
}).refine(
  (m) => m.affiliate_network === undefined
    || m.affiliate_network === 'other'
    || (m.affiliate_advertiser_id ?? '').length > 0,
  {
    // Without the id a pulled conversion resolves to `<network>_unknown` and
    // never reaches this merchant. Naming a network with no id is the exact
    // shape of "looks connected, attributes nothing".
    message: 'affiliate_advertiser_id is required when a network is named',
    path: ['affiliate_advertiser_id'],
  },
);

router.post('/merchants', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: this writes a DRAFT row nobody can see yet.
  // CLAUDE.md §6 — OASIS is for state transitions and decisions. The
  // transition worth an event here is APPROVAL (an admin flipping is_active,
  // which is what puts a product in front of members), and that happens on the
  // admin surface, not this one. Emitting on every keystroke-level save would
  // be the "polling ≠ progress" mistake in a different costume.
  const s = supa(res);
  if (!s) return;
  const owner = userId(req);
  if (!owner) {
    res.status(401).json({ ok: false, error: 'unauthenticated' });
    return;
  }

  const parsed = MerchantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_merchant', details: parsed.error.flatten() });
    return;
  }

  const existing = await findOwnMerchant(s, owner);
  if (existing) {
    // One supplier, one merchant. A second POST updates rather than 409s —
    // the form's "save" is idempotent from the supplier's point of view.
    const { data, error } = await s.from('merchants')
      .update(parsed.data)
      .eq('id', existing.id).eq('owner_user_id', owner)
      .select('id,name,vertical_key,onboarding_status').maybeSingle();
    if (error) {
      res.status(500).json({ ok: false, error: 'failed to update merchant' });
      return;
    }
    res.json({ ok: true, data });
    return;
  }

  const { data, error } = await s.from('merchants').insert({
    id: randomUUID(),
    ...parsed.data,
    owner_user_id: owner,
    // UNIQUE (source_network, source_merchant_id): a hand-entered supplier has
    // no upstream id, so mint a stable one rather than collide on null.
    source_network: SUPPLIER_SOURCE_NETWORK,
    source_merchant_id: `${SUPPLIER_SOURCE_NETWORK}:${owner}`,
    onboarding_status: 'draft',
    is_active: false,
  }).select('id,name,vertical_key,onboarding_status').maybeSingle();

  if (error) {
    res.status(500).json({ ok: false, error: 'failed to create merchant' });
    return;
  }
  res.status(201).json({ ok: true, data });
});

/* ------------------------------------------------------------------ *
 * Products.
 * ------------------------------------------------------------------ */

/**
 * The universal core — the ONLY gate on saving a product, in any vertical.
 *
 * `ships_to_countries`/`ships_to_regions`: at least one is genuinely required.
 * `catalog-ingest`'s own refine enforces the same rule, and its comment is
 * blunt about why — a product with neither can never be shown to anybody. It
 * is a required field that merely looks optional, which is exactly the kind a
 * form forgets to ask for.
 */
/**
 * The product fields, WITHOUT the cross-field refine below.
 *
 * Kept separate because `.refine()` returns a ZodEffects, and ZodEffects has
 * no `.partial()` — PATCH needs to build a partial from the plain object.
 * (Calling `.partial()` on the refined schema is a compile error, which is
 * how this was caught: ts-jest transpiles without typechecking, so the test
 * suite was green and `npm run build` was not.)
 */
const ProductFields = z.object({
  title: z.string().min(1).max(512),
  description: z.string().max(10000).optional(),
  brand: z.string().max(256).optional(),
  price_cents: z.number().int().min(0),
  currency: z.string().length(3).transform((c) => c.toUpperCase()),
  compare_at_price_cents: z.number().int().min(0).optional(),
  images: z.array(z.string().url()).default([]),
  affiliate_url: z.string().url(),
  origin_country: z.string().length(2).transform((c) => c.toUpperCase()),
  ships_to_countries: z.array(z.string().length(2)).optional(),
  ships_to_regions: z.array(z.string()).optional(),
  availability: z.enum(['in_stock', 'out_of_stock', 'preorder', 'discontinued', 'unknown']).default('in_stock'),
  category: z.string().max(128).optional(),
  // Vertical-specific answers, keyed by catalog_vertical_fields.field_key.
  attributes: z.record(z.string(), z.unknown()).default({}),
});

/**
 * A product must ship SOMEWHERE.
 *
 * Discover gates every row on `ships_to_countries.includes(country)` OR
 * `ships_to_regions.includes(region)`, so a product naming neither can never
 * be shown to anyone — it would sit in the supplier's portal looking listed
 * and reach no one.
 */
const SHIPS_SOMEWHERE_MESSAGE =
  'ships_to_countries or ships_to_regions must name at least one destination';

export function shipsSomewhere(p: {
  ships_to_countries?: string[];
  ships_to_regions?: string[];
}): boolean {
  return (p.ships_to_countries?.length ?? 0) > 0 || (p.ships_to_regions?.length ?? 0) > 0;
}

const ProductSchema = ProductFields.refine(shipsSomewhere, {
  message: SHIPS_SOMEWHERE_MESSAGE,
  path: ['ships_to_countries'],
});

/**
 * PATCH body: every field optional.
 *
 * Deliberately NOT refined here. The invariant is about the product's final
 * state, and a patch only carries a fragment of it — a patch clearing
 * `ships_to_countries` is perfectly valid if the row already ships to a
 * region. So the check runs in the handler, against the merge of the stored
 * row and the patch, where the real answer lives.
 */
const ProductPatchSchema = ProductFields.partial();

router.get('/products', async (req: Request, res: Response) => {
  const s = supa(res);
  if (!s) return;
  const owner = userId(req);
  if (!owner) {
    res.status(401).json({ ok: false, error: 'unauthenticated' });
    return;
  }

  const merchant = await findOwnMerchant(s, owner);
  if (!merchant) {
    res.json({ ok: true, data: { merchant: null, products: [] } });
    return;
  }

  const { data, error } = await s.from('products')
    .select('id,title,price_cents,currency,images,affiliate_url,availability,category,attributes,is_active,updated_at')
    .eq('merchant_id', merchant.id).order('updated_at', { ascending: false }).limit(500);
  if (error) {
    res.status(500).json({ ok: false, error: 'failed to load products' });
    return;
  }
  res.json({ ok: true, data: { merchant, products: data ?? [] } });
});

router.post('/products', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: this writes a DRAFT row nobody can see yet.
  // CLAUDE.md §6 — OASIS is for state transitions and decisions. The
  // transition worth an event here is APPROVAL (an admin flipping is_active,
  // which is what puts a product in front of members), and that happens on the
  // admin surface, not this one. Emitting on every keystroke-level save would
  // be the "polling ≠ progress" mistake in a different costume.
  const s = supa(res);
  if (!s) return;
  const owner = userId(req);
  if (!owner) {
    res.status(401).json({ ok: false, error: 'unauthenticated' });
    return;
  }

  const merchant = await findOwnMerchant(s, owner);
  if (!merchant) {
    // The form creates the merchant first; reaching here means the client
    // skipped a step, so say which one rather than 500 on a null merchant_id.
    res.status(409).json({ ok: false, error: 'no_merchant', message: 'create your business first' });
    return;
  }

  const parsed = ProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_product', details: parsed.error.flatten() });
    return;
  }
  const p = parsed.data;

  const { data, error } = await s.from('products').insert({
    id: randomUUID(),
    merchant_id: merchant.id,
    source_network: SUPPLIER_SOURCE_NETWORK,
    source_product_id: `${SUPPLIER_SOURCE_NETWORK}:${merchant.id}:${randomUUID()}`,
    ...p,
    // Nothing a supplier types goes live on their own say-so. Discover shows
    // is_active rows; approval flips it, not this endpoint.
    is_active: false,
  }).select('id,title,is_active').maybeSingle();

  if (error) {
    res.status(500).json({ ok: false, error: 'failed to create product' });
    return;
  }
  res.status(201).json({ ok: true, data });
});

router.patch('/products/:id', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: this writes a DRAFT row nobody can see yet.
  // CLAUDE.md §6 — OASIS is for state transitions and decisions. The
  // transition worth an event here is APPROVAL (an admin flipping is_active,
  // which is what puts a product in front of members), and that happens on the
  // admin surface, not this one. Emitting on every keystroke-level save would
  // be the "polling ≠ progress" mistake in a different costume.
  const s = supa(res);
  if (!s) return;
  const owner = userId(req);
  if (!owner) {
    res.status(401).json({ ok: false, error: 'unauthenticated' });
    return;
  }

  const merchant = await findOwnMerchant(s, owner);
  if (!merchant) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }

  const parsed = ProductPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_product', details: parsed.error.flatten() });
    return;
  }

  // Ships-to is checked against the MERGED state, not the patch alone.
  // Clearing ships_to_countries is fine if the row already ships to a region,
  // and emptying both is not — neither is decidable from the patch on its own.
  // Scoped by merchant_id for the same reason as the update below.
  if (
    parsed.data.ships_to_countries !== undefined
    || parsed.data.ships_to_regions !== undefined
  ) {
    const { data: current } = await s.from('products')
      .select('ships_to_countries,ships_to_regions')
      .eq('id', req.params.id).eq('merchant_id', merchant.id).maybeSingle();

    if (!current) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const merged = { ...current, ...parsed.data };
    if (!shipsSomewhere(merged)) {
      res.status(400).json({
        ok: false,
        error: 'invalid_product',
        details: { fieldErrors: { ships_to_countries: [SHIPS_SOMEWHERE_MESSAGE] } },
      });
      return;
    }
  }

  // The merchant_id predicate is the authorization: another supplier's product
  // id simply matches no row, so it 404s rather than leaking its existence.
  const { data, error } = await s.from('products')
    .update(parsed.data)
    .eq('id', req.params.id).eq('merchant_id', merchant.id)
    .select('id,title,is_active').maybeSingle();

  if (error) {
    res.status(500).json({ ok: false, error: 'failed to update product' });
    return;
  }
  if (!data) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  res.json({ ok: true, data });
});

export default router;

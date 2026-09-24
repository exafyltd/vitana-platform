/**
 * VTID-04488 — the catalogue step of partner onboarding, mounted at
 * /api/v1/partner-onboarding (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §6.1, §6.2).
 *
 *   GET   /:orgId/catalogue                 the org's merchant and products
 *   PUT   /:orgId/catalogue/merchant        create or update the org's merchant
 *   POST  /:orgId/catalogue/products        add a product (draft, never live)
 *   PATCH /:orgId/catalogue/products/:id    change one of the org's products
 *
 * The rules are the supplier portal's own (routes/vcaop-portal-my-products.ts,
 * VTID-03894): the same merchant and product schemas, the same ships-to rule,
 * the same `supplier_referral` source network, and nothing a partner types is
 * ever live on their own say-so (`is_active: false`). What changes is the key:
 * the merchant belongs to the partner organization
 * (merchants.partner_organization_id, VTID-04471), not to one user, so any
 * org_admin of the org can maintain it.
 *
 * A merchant the org owner already created through the old portal (keyed on
 * owner_user_id, not yet linked to an org) is adopted instead of duplicated.
 * A merchant created here has no owner_user_id: the old portal looks its
 * merchant up with `.maybeSingle()` on owner_user_id, and a second row per
 * owner would make that lookup fail for them.
 *
 * The catalogue step is `in_progress` once the org has a merchant and `done`
 * once it has at least one product. It is written to partner_onboarding_steps
 * after every change; an OASIS event is emitted only when that status moves.
 *
 * Not here: CSV upload and feed URLs (their own VTID), and the §7 content scan.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { isPartnerType, type PartnerType } from '../services/partner-lifecycle';
import { getCallerId, requireOrgAdmin } from './partner-orgs';
import { loadOrg, respondWithState, type OrgRow, type Supa } from './partner-onboarding';
import {
  MerchantSchema,
  ProductPatchSchema,
  ProductSchema,
  SHIPS_SOMEWHERE_MESSAGE,
  SUPPLIER_SOURCE_NETWORK,
  shipsSomewhere,
} from './vcaop-portal-my-products';

const router = Router();

const MERCHANT_FIELDS = 'id,name,vertical_key,onboarding_status,merchant_country,currencies,partner_organization_id';
const PRODUCT_FIELDS = 'id,title,price_cents,currency,images,affiliate_url,availability,category,attributes,is_active,updated_at';

/** Lifecycle states in which the catalogue can no longer be edited. */
const CATALOGUE_LOCKED_STATES = ['rejected', 'suspended'];

/**
 * The catalog vertical a partner type starts in when the partner does not
 * pick one. Shops and brands sell across verticals, so they must choose.
 */
export const DEFAULT_VERTICAL_BY_TYPE: Readonly<Partial<Record<PartnerType, string>>> = {
  lab: 'diagnostics',
  practitioner_clinic: 'services',
  service_provider: 'services',
};

type CatalogueStatus = 'in_progress' | 'done';

export function catalogueStepStatus(productCount: number): CatalogueStatus {
  return productCount > 0 ? 'done' : 'in_progress';
}

interface MerchantRow {
  id: string;
  name: string;
  vertical_key: string | null;
  onboarding_status: string;
  merchant_country: string | null;
  currencies: unknown;
  partner_organization_id: string | null;
}

async function findOrgMerchant(s: Supa, orgId: string): Promise<{ merchant: MerchantRow | null; error: string | null }> {
  const { data, error } = await s
    .from('merchants')
    .select(MERCHANT_FIELDS)
    .eq('partner_organization_id', orgId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return { merchant: null, error: error.message };
  return { merchant: (data as MerchantRow | null) ?? null, error: null };
}

/** Loads the org and refuses a missing org or one whose catalogue is locked. */
async function loadEditableOrg(s: Supa, req: Request, res: Response): Promise<OrgRow | null> {
  const { org, error } = await loadOrg(s, req.params.orgId);
  if (error) {
    res.status(500).json({ ok: false, error });
    return null;
  }
  if (!org) {
    res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });
    return null;
  }
  if (CATALOGUE_LOCKED_STATES.includes(org.lifecycle_state)) {
    res.status(409).json({ ok: false, error: 'CATALOGUE_LOCKED', lifecycle_state: org.lifecycle_state });
    return null;
  }
  return org;
}

/**
 * Writes the catalogue step row and reports whether its status moved, so the
 * caller emits an event only on a real transition.
 */
async function syncCatalogueStep(
  s: Supa,
  orgId: string,
  merchantId: string,
  callerId: string | null,
): Promise<{ error: string | null; changed: boolean; from: string | null; to: CatalogueStatus; product_count: number }> {
  const [count, prior] = await Promise.all([
    s.from('products').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantId),
    s
      .from('partner_onboarding_steps')
      .select('status')
      .eq('partner_organization_id', orgId)
      .eq('step_key', 'catalogue')
      .maybeSingle(),
  ]);
  if (count.error) return { error: count.error.message, changed: false, from: null, to: 'in_progress', product_count: 0 };
  if (prior.error) return { error: prior.error.message, changed: false, from: null, to: 'in_progress', product_count: 0 };

  const productCount = typeof count.count === 'number' ? count.count : 0;
  const to = catalogueStepStatus(productCount);
  const from = (prior.data as { status?: string } | null)?.status ?? null;
  const now = new Date().toISOString();
  const { error } = await s.from('partner_onboarding_steps').upsert(
    {
      partner_organization_id: orgId,
      step_key: 'catalogue',
      status: to,
      detail: { merchant_id: merchantId, product_count: productCount, counted_at: now },
      updated_by: callerId,
      updated_at: now,
    },
    { onConflict: 'partner_organization_id,step_key' },
  );
  if (error) return { error: error.message, changed: false, from, to, product_count: productCount };
  return { error: null, changed: from !== to, from, to, product_count: productCount };
}

function catalogueEvent(orgId: string, step: { from: string | null; to: string; product_count: number }, callerId: string | null) {
  return emitOasisEvent({
    vtid: 'VTID-04488',
    type: 'partner_org.catalogue_step_changed',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId}: catalogue step ${step.from ?? 'todo'} -> ${step.to} (${step.product_count} products).`,
    payload: { partner_organization_id: orgId, from: step.from, to: step.to, product_count: step.product_count },
    actor_id: callerId ?? undefined,
  });
}

// ==================== Read ====================

router.get('/:orgId/catalogue', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { org, error } = await loadOrg(s, req.params.orgId);
  if (error) return res.status(500).json({ ok: false, error });
  if (!org) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });

  const found = await findOrgMerchant(s, org.id);
  if (found.error) return res.status(500).json({ ok: false, error: found.error });
  if (!found.merchant) return res.json({ ok: true, merchant: null, products: [] });

  const { data, error: pErr } = await s
    .from('products')
    .select(PRODUCT_FIELDS)
    .eq('merchant_id', found.merchant.id)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (pErr) return res.status(500).json({ ok: false, error: pErr.message });
  return res.json({ ok: true, merchant: found.merchant, products: data ?? [] });
});

// ==================== Merchant ====================

router.put('/:orgId/catalogue/merchant', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  // impact-allow-no-oasis: the OASIS event is emitted by catalogueEvent()
  // below, only when the catalogue step's status moves (CLAUDE.md §6: state
  // transitions, not every save).
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  const org = await loadEditableOrg(s, req, res);
  if (!org) return;

  const body = { ...(req.body && typeof req.body === 'object' ? req.body : {}) } as Record<string, unknown>;
  if (body.name === undefined) body.name = org.display_name;
  if (body.vertical_key === undefined && isPartnerType(org.partner_type)) {
    const fallback = DEFAULT_VERTICAL_BY_TYPE[org.partner_type];
    if (fallback) body.vertical_key = fallback;
  }
  if (body.merchant_country === undefined && org.country) body.merchant_country = org.country;
  if (body.storefront_url === undefined && org.website) body.storefront_url = org.website;

  const parsed = MerchantSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid_merchant', details: parsed.error.flatten() });
  }

  const found = await findOrgMerchant(s, org.id);
  if (found.error) return res.status(500).json({ ok: false, error: found.error });
  let merchant = found.merchant;
  let created = false;
  let adopted = false;

  if (merchant) {
    const { data, error } = await s
      .from('merchants')
      .update(parsed.data)
      .eq('id', merchant.id)
      .eq('partner_organization_id', org.id)
      .select(MERCHANT_FIELDS)
      .maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    merchant = (data as MerchantRow | null) ?? merchant;
  } else {
    // The org owner's merchant from the old portal, not yet linked to any org.
    const legacy = await s
      .from('merchants')
      .select('id')
      .eq('owner_user_id', org.owner_user_id)
      .eq('source_network', SUPPLIER_SOURCE_NETWORK)
      .is('partner_organization_id', null)
      .limit(1)
      .maybeSingle();
    if (legacy.error) return res.status(500).json({ ok: false, error: legacy.error.message });

    if (legacy.data) {
      const { data, error } = await s
        .from('merchants')
        .update({ ...parsed.data, partner_organization_id: org.id })
        .eq('id', (legacy.data as { id: string }).id)
        .is('partner_organization_id', null)
        .select(MERCHANT_FIELDS)
        .maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data) return res.status(409).json({ ok: false, error: 'CONCURRENT_UPDATE' });
      merchant = data as MerchantRow;
      adopted = true;
    } else {
      const { data, error } = await s
        .from('merchants')
        .insert({
          id: randomUUID(),
          ...parsed.data,
          partner_organization_id: org.id,
          // UNIQUE (source_network, source_merchant_id): one org, one key.
          source_network: SUPPLIER_SOURCE_NETWORK,
          source_merchant_id: `${SUPPLIER_SOURCE_NETWORK}:org:${org.id}`,
          onboarding_status: 'draft',
          is_active: false,
        })
        .select(MERCHANT_FIELDS)
        .maybeSingle();
      if (error?.code === '23505') return res.status(409).json({ ok: false, error: 'CONCURRENT_UPDATE' });
      if (error || !data) return res.status(500).json({ ok: false, error: error?.message ?? 'merchant insert failed' });
      merchant = data as MerchantRow;
      created = true;
    }
  }

  const step = await syncCatalogueStep(s, org.id, merchant.id, callerId);
  if (step.error) return res.status(500).json({ ok: false, error: step.error });
  if (step.changed) await catalogueEvent(org.id, step, callerId);

  return respondWithState(res, s, org.id, created ? 201 : 200, { merchant, created, adopted });
});

// ==================== Products ====================

router.post('/:orgId/catalogue/products', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  // impact-allow-no-oasis: the OASIS event is emitted by catalogueEvent()
  // below, only when the catalogue step's status moves (CLAUDE.md §6: state
  // transitions, not every save).
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  const org = await loadEditableOrg(s, req, res);
  if (!org) return;

  const found = await findOrgMerchant(s, org.id);
  if (found.error) return res.status(500).json({ ok: false, error: found.error });
  if (!found.merchant) {
    return res.status(409).json({ ok: false, error: 'NO_MERCHANT', message: 'PUT /catalogue/merchant first' });
  }

  const parsed = ProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid_product', details: parsed.error.flatten() });
  }

  const { data, error } = await s
    .from('products')
    .insert({
      id: randomUUID(),
      merchant_id: found.merchant.id,
      source_network: SUPPLIER_SOURCE_NETWORK,
      source_product_id: `${SUPPLIER_SOURCE_NETWORK}:${found.merchant.id}:${randomUUID()}`,
      ...parsed.data,
      // Never live on the partner's own say-so.
      is_active: false,
    })
    .select(PRODUCT_FIELDS)
    .maybeSingle();
  if (error || !data) return res.status(500).json({ ok: false, error: error?.message ?? 'product insert failed' });

  const step = await syncCatalogueStep(s, org.id, found.merchant.id, callerId);
  if (step.error) return res.status(500).json({ ok: false, error: step.error });
  if (step.changed) await catalogueEvent(org.id, step, callerId);

  return respondWithState(res, s, org.id, 201, { product: data });
});

router.patch('/:orgId/catalogue/products/:productId', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  // impact-allow-no-oasis: the OASIS event is emitted by catalogueEvent()
  // below, only when the catalogue step's status moves (CLAUDE.md §6: state
  // transitions, not every save).
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  const org = await loadEditableOrg(s, req, res);
  if (!org) return;

  const found = await findOrgMerchant(s, org.id);
  if (found.error) return res.status(500).json({ ok: false, error: found.error });
  if (!found.merchant) return res.status(404).json({ ok: false, error: 'PRODUCT_NOT_FOUND' });
  const merchantId = found.merchant.id;

  const parsed = ProductPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid_product', details: parsed.error.flatten() });
  }
  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ ok: false, error: 'invalid_product', message: 'no fields to change' });
  }

  // The ships-to rule holds for the product's final state, not the patch.
  if (parsed.data.ships_to_countries !== undefined || parsed.data.ships_to_regions !== undefined) {
    const { data: current, error } = await s
      .from('products')
      .select('ships_to_countries,ships_to_regions')
      .eq('id', req.params.productId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!current) return res.status(404).json({ ok: false, error: 'PRODUCT_NOT_FOUND' });
    if (!shipsSomewhere({ ...(current as object), ...parsed.data })) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_product',
        details: { fieldErrors: { ships_to_countries: [SHIPS_SOMEWHERE_MESSAGE] } },
      });
    }
  }

  // merchant_id is the authorization: another org's product matches no row.
  const { data, error } = await s
    .from('products')
    .update(parsed.data)
    .eq('id', req.params.productId)
    .eq('merchant_id', merchantId)
    .select(PRODUCT_FIELDS)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'PRODUCT_NOT_FOUND' });

  const step = await syncCatalogueStep(s, org.id, merchantId, callerId);
  if (step.error) return res.status(500).json({ ok: false, error: step.error });
  if (step.changed) await catalogueEvent(org.id, step, callerId);

  return respondWithState(res, s, org.id, 200, { product: data });
});

export default router;

/**
 * VTID-04488 — the catalogue step of partner onboarding, mounted at
 * /api/v1/partner-onboarding (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §6.1, §6.2).
 *
 *   GET   /:orgId/catalogue                 the org's merchant and products
 *   PUT   /:orgId/catalogue/merchant        create or update the org's merchant
 *   POST  /:orgId/catalogue/products        add a product (draft, never live)
 *   PATCH /:orgId/catalogue/products/:id    change one of the org's products
 *   POST  /:orgId/catalogue/products/import add many products from a CSV (VTID-04731)
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
 * The CSV import (VTID-04731) is all or nothing: every row is judged by the
 * same ProductSchema first, and one bad row means nothing is written and every
 * error comes back with its line number. `dry_run: true` answers the same
 * report without writing, so a partner can check a file before sending it.
 *
 * Not here: feed URLs (their own VTID) and the §7 content scan.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { parseCatalogueCsv } from '../services/partner-catalogue-csv';
import {
  DEFAULT_VERTICAL_BY_TYPE,
  PRODUCT_FIELDS,
  catalogueEvent,
  catalogueStepStatus,
  createOrgProduct,
  findOrgMerchant,
  normalizeSetupKey,
  syncCatalogueStep,
  upsertOrgMerchant,
} from '../services/partner-setup';
import { getCallerId, isExafyAdmin, requireOrgAdmin } from './partner-orgs';
import { CATALOGUE_LOCKED_STATES, listCatalogue, updateProduct } from '../services/partner-onboarding-service';
import { loadOrg, respondWithState, type OrgRow, type Supa } from './partner-onboarding';
import { SUPPLIER_SOURCE_NETWORK } from './vcaop-portal-my-products';

const router = Router();


/**
 * Re-exported from services/partner-setup.ts (VTID-04837), where the merchant
 * and product writes now live so the AI setup can share them.
 */
export { DEFAULT_VERTICAL_BY_TYPE, catalogueStepStatus };

/** The optional product columns; all nullable with a NULL default. */
const OPTIONAL_PRODUCT_NULLS = {
  description: null,
  brand: null,
  compare_at_price_cents: null,
  ships_to_countries: null,
  ships_to_regions: null,
  category: null,
  subcategory: null,
} as const;

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

// ==================== Read ====================

router.get('/:orgId/catalogue', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  // VTID-04847: shared with the Commerce MCP endpoint.
  const r = await listCatalogue(s, { userId: callerId, exafyAdmin: isExafyAdmin(req), orgAdminChecked: true }, req.params.orgId);
  return res.status(r.status).json(r.body);
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

  const result = await upsertOrgMerchant(s, org, callerId, req.body);
  if (!result.ok) return res.status(result.status).json(result.body);
  const { merchant, created, adopted } = result.data;

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

  // VTID-04837: an optional Idempotency-Key makes a retry return the same product.
  const result = await createOrgProduct(s, org.id, found.merchant.id, callerId, req.body, {
    productKey: normalizeSetupKey(req.get('Idempotency-Key')),
  });
  if (!result.ok) return res.status(result.status).json(result.body);

  return respondWithState(res, s, org.id, result.status, { product: result.data.product });
});

router.post('/:orgId/catalogue/products/import', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  const org = await loadEditableOrg(s, req, res);
  if (!org) return;

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { csv?: unknown; dry_run?: unknown };
  if (typeof body.csv !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_csv', message: 'csv must be the file contents as a string' });
  }
  const dryRun = body.dry_run === true;

  const found = await findOrgMerchant(s, org.id);
  if (found.error) return res.status(500).json({ ok: false, error: found.error });
  if (!found.merchant) {
    return res.status(409).json({ ok: false, error: 'NO_MERCHANT', message: 'PUT /catalogue/merchant first' });
  }
  const merchantId = found.merchant.id;

  const parsed = parseCatalogueCsv(body.csv);
  if (parsed.fileError) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_csv',
      message: parsed.fileError,
      // VTID-04746: translatable in the portal.
      code: parsed.fileErrorCode,
      params: parsed.fileErrorParams ?? {},
      columns: parsed.columns,
    });
  }
  const report = { valid_rows: parsed.rows.length, errors: parsed.errors };
  if (dryRun) return res.json({ ok: true, dry_run: true, ...report });
  if (parsed.errors.length > 0) {
    // All or nothing: a half-imported file is harder to fix than a rejected one.
    return res.status(400).json({ ok: false, error: 'invalid_rows', ...report });
  }

  const drafts = parsed.rows.map(({ product }) => ({
    // Every draft carries the same keys: a PostgREST bulk insert whose
    // objects differ in keys is rejected with PGRST102 (VTID-04095). The
    // optional columns are nullable with a NULL default, so null is what an
    // omitted value means anyway.
    ...OPTIONAL_PRODUCT_NULLS,
    id: randomUUID(),
    merchant_id: merchantId,
    source_network: SUPPLIER_SOURCE_NETWORK,
    source_product_id: `${SUPPLIER_SOURCE_NETWORK}:${merchantId}:${randomUUID()}`,
    ...product,
    // Never live on the partner's own say-so.
    is_active: false,
  }));
  // One statement: PostgREST inserts the array in a single transaction. The
  // NOT NULL columns (images, attributes, availability) always arrive through
  // the schema's defaults (checked against the live table 2026-09-29).
  const { data, error } = await s.from('products').insert(drafts).select(PRODUCT_FIELDS);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  await emitOasisEvent({
    vtid: 'VTID-04731',
    type: 'partner_org.catalogue_imported',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${org.id}: ${drafts.length} draft products imported from CSV.`,
    payload: { partner_organization_id: org.id, merchant_id: merchantId, imported: drafts.length },
    actor_id: callerId ?? undefined,
  });

  const step = await syncCatalogueStep(s, org.id, merchantId, callerId);
  if (step.error) return res.status(500).json({ ok: false, error: step.error });
  if (step.changed) await catalogueEvent(org.id, step, callerId);

  return respondWithState(res, s, org.id, 201, { imported: drafts.length, products: data ?? [] });
});

router.patch('/:orgId/catalogue/products/:productId', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  // impact-allow-no-oasis: the OASIS event is emitted by catalogueEvent()
  // inside updateProduct, only when the catalogue step's status moves
  // (CLAUDE.md §6: state transitions, not every save).
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const r = await updateProduct(s, { userId: callerId, exafyAdmin: isExafyAdmin(req), orgAdminChecked: true }, req.params.orgId, req.params.productId, req.body);
  return res.status(r.status).json(r.body);
});

export default router;

/**
 * VTID-04837 — the partner setup writes, as functions instead of route bodies.
 *
 * Registering a business, upserting its catalogue merchant and adding a
 * product used to live inline in Express handlers. Vitana's voice session
 * holds a verified identity but no user JWT, so its tools cannot call those
 * routes on the member's behalf; the AI setup (and the routes themselves) now
 * share these functions. Every function takes the service-role client and
 * the already-authorised caller: authorisation stays with the caller
 * (requireAuth/requireOrgAdmin on the routes, the membership check in the AI
 * setup).
 *
 * Retries: register and product create were not idempotent (a retried
 * register 409'd on its own org_key; a retried product was duplicated). Both
 * now take an optional key. Without a key they behave exactly as before.
 *   - register: the key is stored as business_details.setup_key and looked up
 *     per owner before inserting; a replay returns the existing org.
 *   - product: the key becomes part of source_product_id, which is UNIQUE per
 *     source_network; a replay returns the existing product.
 */
import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { PARTNER_TYPES, isPartnerType, parseCompanyFacts, verticalForPartnerType } from './partner-lifecycle';
import type { OrgRow, Supa } from '../routes/partner-onboarding';
import { MerchantSchema, ProductSchema, SUPPLIER_SOURCE_NETWORK } from '../routes/vcaop-portal-my-products';

export type SetupResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; body: Record<string, unknown> };

const fail = (status: number, body: Record<string, unknown>): SetupResult<never> => ({ ok: false, status, body });

// ==================== Register ====================

export const COMMERCE_VERTICALS = ['health', 'general'] as const;
export type CommerceVertical = (typeof COMMERCE_VERTICALS)[number];

export function isCommerceVertical(value: unknown): value is CommerceVertical {
  return typeof value === 'string' && (COMMERCE_VERTICALS as readonly string[]).includes(value);
}

const REGISTERED_FIELDS =
  'id, org_key, display_name, org_type, partner_type, commerce_vertical, status, lifecycle_state, legal_name, country, vat_id, website';

export interface RegisteredOrg {
  id: string;
  org_key: string;
  display_name: string;
  org_type: string;
  partner_type: string | null;
  commerce_vertical: CommerceVertical;
  status: string;
  lifecycle_state: string;
}

/** A setup key: printable, bounded, so it can sit in business_details and in an id. */
export function normalizeSetupKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(key) ? key : null;
}

async function findBySetupKey(s: Supa, callerId: string, key: string): Promise<{ org: RegisteredOrg | null; error: string | null }> {
  const { data, error } = await s
    .from('partner_organizations')
    .select(REGISTERED_FIELDS)
    .eq('owner_user_id', callerId)
    .eq('business_details->>setup_key', key)
    .limit(1)
    .maybeSingle();
  if (error) return { org: null, error: error.message };
  return { org: (data as RegisteredOrg | null) ?? null, error: null };
}

async function ensureOrgAdmin(s: Supa, orgId: string, callerId: string): Promise<string | null> {
  const { data, error } = await s
    .from('partner_organization_members')
    .select('role')
    .eq('partner_organization_id', orgId)
    .eq('user_id', callerId)
    .maybeSingle();
  if (error) return error.message;
  if (data) return null;
  const { error: insErr } = await s
    .from('partner_organization_members')
    .insert({ partner_organization_id: orgId, user_id: callerId, role: 'org_admin', granted_by: callerId });
  return insErr ? insErr.message : null;
}

/**
 * POST /partner-orgs/register, as a function. `body` is the request body
 * (org_key, display_name, org_type, partner_type?, commerce_vertical?,
 * business_details?, company facts). Error bodies match the route's.
 */
export async function registerPartnerOrg(
  s: Supa,
  callerId: string,
  body: Record<string, unknown>,
  opts: { setupKey?: string | null } = {},
): Promise<SetupResult<{ organization: RegisteredOrg; replayed: boolean }>> {
  const setupKey = opts.setupKey ?? null;
  const orgKey = typeof body?.org_key === 'string' ? body.org_key.trim().toLowerCase() : '';
  const displayName = typeof body?.display_name === 'string' ? body.display_name.trim() : '';
  const orgType = typeof body?.org_type === 'string' ? body.org_type.trim() : '';
  const rawPartnerType = body?.partner_type;
  let commerceVertical = body?.commerce_vertical;
  const businessDetails =
    body?.business_details && typeof body.business_details === 'object' ? (body.business_details as Record<string, unknown>) : {};

  if (!orgKey) return fail(400, { ok: false, error: 'org_key is required' });
  if (!displayName) return fail(400, { ok: false, error: 'display_name is required' });
  if (!orgType) return fail(400, { ok: false, error: 'org_type is required' });
  // VTID-04471 — partner_type is the enforced vocabulary; when given it
  // decides commerce_vertical (the DB trigger derives it the same way).
  // Without it, commerce_vertical stays required as before.
  const partnerType = rawPartnerType === undefined || rawPartnerType === null || rawPartnerType === '' ? null : rawPartnerType;
  if (partnerType !== null && !isPartnerType(partnerType)) {
    return fail(400, { ok: false, error: `partner_type must be one of: ${PARTNER_TYPES.join(', ')}` });
  }
  if (partnerType !== null) {
    const derived = verticalForPartnerType(partnerType);
    if (commerceVertical !== undefined && commerceVertical !== null && commerceVertical !== derived) {
      return fail(400, { ok: false, error: `commerce_vertical must be '${derived}' for partner_type '${partnerType}'` });
    }
    commerceVertical = derived;
  }
  if (!isCommerceVertical(commerceVertical)) {
    return fail(400, { ok: false, error: `commerce_vertical must be one of: ${COMMERCE_VERTICALS.join(', ')}` });
  }
  const companyFacts = parseCompanyFacts(body);
  if (!companyFacts.ok) return fail(400, { ok: false, error: companyFacts.error });

  const replay = async (): Promise<SetupResult<{ organization: RegisteredOrg; replayed: boolean }> | null> => {
    if (!setupKey) return null;
    const found = await findBySetupKey(s, callerId, setupKey);
    if (found.error) return fail(500, { ok: false, error: found.error });
    if (!found.org) return null;
    const memberErr = await ensureOrgAdmin(s, found.org.id, callerId);
    if (memberErr) return fail(500, { ok: false, error: memberErr });
    return { ok: true, status: 200, data: { organization: found.org, replayed: true } };
  };

  const prior = await replay();
  if (prior) return prior;

  const { data: org, error: orgErr } = await s
    .from('partner_organizations')
    .insert({
      org_key: orgKey,
      display_name: displayName,
      org_type: orgType,
      commerce_vertical: commerceVertical,
      status: 'pending_review',
      owner_user_id: callerId,
      business_details: setupKey ? { ...businessDetails, setup_key: setupKey } : businessDetails,
      ...(partnerType !== null ? { partner_type: partnerType } : {}),
      ...companyFacts.facts,
    })
    .select(REGISTERED_FIELDS)
    .single();
  if (orgErr || !org) {
    if (orgErr?.code === '23505') {
      // A concurrent request with the same key won the insert.
      const raced = await replay();
      if (raced) return raced;
      return fail(409, { ok: false, error: 'org_key already taken' });
    }
    return fail(500, { ok: false, error: orgErr?.message ?? 'partner_organizations insert failed' });
  }
  const orgRow = org as RegisteredOrg;

  const { error: memberErr } = await s
    .from('partner_organization_members')
    .insert({ partner_organization_id: orgRow.id, user_id: callerId, role: 'org_admin', granted_by: callerId });
  if (memberErr) return fail(500, { ok: false, error: memberErr.message });

  await emitOasisEvent({
    vtid: 'VTID-03932',
    type: 'partner_org.registered',
    source: 'partner-orgs',
    status: 'success',
    message: `Partner organization "${orgRow.display_name}" (${orgRow.org_key}) self-registered by ${callerId}.`,
    payload: { partner_organization_id: orgRow.id, org_key: orgRow.org_key, org_type: orgRow.org_type, partner_type: orgRow.partner_type ?? null },
    actor_id: callerId,
  });

  return { ok: true, status: 201, data: { organization: orgRow, replayed: false } };
}

// ==================== Catalogue ====================

export const MERCHANT_FIELDS = 'id,name,vertical_key,onboarding_status,merchant_country,currencies,partner_organization_id';
export const PRODUCT_FIELDS =
  'id,title,price_cents,currency,images,affiliate_url,availability,category,subcategory,attributes,is_active,updated_at';

/**
 * The catalog vertical a partner type starts in when the partner does not
 * pick one. Shops and brands sell across verticals, so they must choose.
 */
export const DEFAULT_VERTICAL_BY_TYPE: Readonly<Partial<Record<string, string>>> = {
  lab: 'diagnostics',
  practitioner_clinic: 'services',
  service_provider: 'services',
};

export type CatalogueStatus = 'in_progress' | 'done';

export function catalogueStepStatus(productCount: number): CatalogueStatus {
  return productCount > 0 ? 'done' : 'in_progress';
}

export interface MerchantRow {
  id: string;
  name: string;
  vertical_key: string | null;
  onboarding_status: string;
  merchant_country: string | null;
  currencies: unknown;
  partner_organization_id: string | null;
}

export async function findOrgMerchant(s: Supa, orgId: string): Promise<{ merchant: MerchantRow | null; error: string | null }> {
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

/**
 * Writes the catalogue step row and reports whether its status moved, so the
 * caller emits an event only on a real transition.
 */
export async function syncCatalogueStep(
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

export function catalogueEvent(orgId: string, step: { from: string | null; to: string; product_count: number }, callerId: string | null) {
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

/** Syncs the catalogue step and emits its event only on a real transition. */
async function syncAndAnnounce(s: Supa, orgId: string, merchantId: string, callerId: string | null): Promise<string | null> {
  const step = await syncCatalogueStep(s, orgId, merchantId, callerId);
  if (step.error) return step.error;
  if (step.changed) await catalogueEvent(orgId, step, callerId);
  return null;
}

/**
 * PUT /:orgId/catalogue/merchant, as a function: update the org's merchant,
 * adopt the owner's unlinked portal merchant, or create a hidden draft one.
 * Name, vertical (per partner type), country and storefront default from the
 * org. `org` must already be checked as editable by the caller.
 */
export async function upsertOrgMerchant(
  s: Supa,
  org: OrgRow,
  callerId: string | null,
  rawBody: unknown,
): Promise<SetupResult<{ merchant: MerchantRow; created: boolean; adopted: boolean }>> {
  const body = { ...(rawBody && typeof rawBody === 'object' ? rawBody : {}) } as Record<string, unknown>;
  if (body.name === undefined) body.name = org.display_name;
  if (body.vertical_key === undefined && isPartnerType(org.partner_type)) {
    const fallback = DEFAULT_VERTICAL_BY_TYPE[org.partner_type];
    if (fallback) body.vertical_key = fallback;
  }
  if (body.merchant_country === undefined && org.country) body.merchant_country = org.country;
  if (body.storefront_url === undefined && org.website) body.storefront_url = org.website;

  const parsed = MerchantSchema.safeParse(body);
  if (!parsed.success) return fail(400, { ok: false, error: 'invalid_merchant', details: parsed.error.flatten() });

  const found = await findOrgMerchant(s, org.id);
  if (found.error) return fail(500, { ok: false, error: found.error });
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
    if (error) return fail(500, { ok: false, error: error.message });
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
    if (legacy.error) return fail(500, { ok: false, error: legacy.error.message });

    if (legacy.data) {
      const { data, error } = await s
        .from('merchants')
        .update({ ...parsed.data, partner_organization_id: org.id })
        .eq('id', (legacy.data as { id: string }).id)
        .is('partner_organization_id', null)
        .select(MERCHANT_FIELDS)
        .maybeSingle();
      if (error) return fail(500, { ok: false, error: error.message });
      if (!data) return fail(409, { ok: false, error: 'CONCURRENT_UPDATE' });
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
      if (error?.code === '23505') return fail(409, { ok: false, error: 'CONCURRENT_UPDATE' });
      if (error || !data) return fail(500, { ok: false, error: error?.message ?? 'merchant insert failed' });
      merchant = data as MerchantRow;
      created = true;
    }
  }

  const stepErr = await syncAndAnnounce(s, org.id, merchant.id, callerId);
  if (stepErr) return fail(500, { ok: false, error: stepErr });
  return { ok: true, status: created ? 201 : 200, data: { merchant, created, adopted } };
}

/**
 * POST /:orgId/catalogue/products, as a function. Always a hidden draft
 * (is_active false). With `productKey` the insert is idempotent: a retry with
 * the same key returns the product it already created.
 */
export async function createOrgProduct(
  s: Supa,
  orgId: string,
  merchantId: string,
  callerId: string | null,
  rawBody: unknown,
  opts: { productKey?: string | null; syncStep?: boolean } = {},
): Promise<SetupResult<{ product: Record<string, unknown>; replayed: boolean }>> {
  const parsed = ProductSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, { ok: false, error: 'invalid_product', details: parsed.error.flatten() });

  const key = opts.productKey ?? null;
  const sourceProductId = `${SUPPLIER_SOURCE_NETWORK}:${merchantId}:${key ? `key:${key}` : randomUUID()}`;
  const { data, error } = await s
    .from('products')
    .insert({
      id: randomUUID(),
      merchant_id: merchantId,
      source_network: SUPPLIER_SOURCE_NETWORK,
      source_product_id: sourceProductId,
      ...parsed.data,
      // Never live on the partner's own say-so.
      is_active: false,
    })
    .select(PRODUCT_FIELDS)
    .maybeSingle();

  if (error?.code === '23505' && key) {
    const existing = await s
      .from('products')
      .select(PRODUCT_FIELDS)
      .eq('source_network', SUPPLIER_SOURCE_NETWORK)
      .eq('source_product_id', sourceProductId)
      .maybeSingle();
    if (existing.error || !existing.data) return fail(500, { ok: false, error: existing.error?.message ?? 'product replay lookup failed' });
    return { ok: true, status: 200, data: { product: existing.data as Record<string, unknown>, replayed: true } };
  }
  if (error || !data) return fail(500, { ok: false, error: error?.message ?? 'product insert failed' });

  if (opts.syncStep !== false) {
    const stepErr = await syncAndAnnounce(s, orgId, merchantId, callerId);
    if (stepErr) return fail(500, { ok: false, error: stepErr });
  }
  return { ok: true, status: 201, data: { product: data as Record<string, unknown>, replayed: false } };
}

/** For callers that add several products and sync the step once at the end. */
export { syncAndAnnounce as syncCatalogueStepAndAnnounce };

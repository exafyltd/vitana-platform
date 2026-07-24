/**
 * Marketplace Voice Assistant (expansion v3, sections A17–A30) — shared
 * helpers for the two MVA tool modules (marketplace-guide-tools.ts,
 * marketplace-journey-tools.ts).
 *
 * Real backings (verified against routes/migrations before writing, same
 * discipline as marketplace-discovery-tools.ts):
 *
 *   - Guide state (goal, criteria, current picks + rationales, selection)
 *     lives as ONE per-user row in `memory_items`
 *     (content_json.type = 'marketplace_guide_state'), the canonical
 *     infinite-memory table (VTID-01104). No new table.
 *   - Preferences live in `memory_facts` under `marketplace_pref_*` keys,
 *     written through writeFact() (memory-facts-service.ts — identity-lock
 *     checks + OASIS events + auto-supersession) and read directly with the
 *     same superseded_by-null filter awareness-tools.ts uses.
 *   - Products come from `public.products` (VTID-02000 live catalog) with
 *     the exact column set routes/discover-search.ts selects (incl.
 *     dietary_tags, contains_allergens, ships_to_countries, safety_notes).
 *   - Cart staging mirrors marketplace-discovery-tools.ts: one active
 *     `universal_carts` row per user, items into `universal_cart_items`
 *     with source_surface 'voice', audit via emitCartEvent() imported from
 *     routes/universal-cart.ts. NEVER calls checkout/Stripe/wallet debit.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { emitCartEvent } from '../../routes/universal-cart';

export const MVA_VTID = 'MVA-MARKETPLACE-VA';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_CURRENCY = 'EUR';

// ---------------------------------------------------------------------------
// Generic helpers (same shapes as the sibling tool modules)
// ---------------------------------------------------------------------------

export function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

export async function resolveTenantId(id: OrbToolIdentity, sb: SupabaseClient): Promise<string | null> {
  if (id.tenant_id) return id.tenant_id;
  try {
    const { data } = await sb
      .from('app_users')
      .select('tenant_id')
      .eq('user_id', id.user_id)
      .maybeSingle();
    return (data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
  } catch {
    return null;
  }
}

export function navDirective(
  screen_id: string,
  route: string,
  title: string,
  reason: string,
): Record<string, unknown> {
  return { type: 'orb_directive', directive: 'navigate', screen_id, route, title, reason, vtid: MVA_VTID };
}

export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function fmtPrice(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents == null) return 'price unavailable';
  const amount = (cents / 100).toFixed(2);
  return `${amount} ${currency ?? DEFAULT_CURRENCY}`;
}

/** Normalizes a string-or-array tool arg into a trimmed string array. */
export function toList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter((v) => v !== '');
  }
  const s = String(raw ?? '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

// ---------------------------------------------------------------------------
// Products (public.products — VTID-02000 live catalog)
// ---------------------------------------------------------------------------

export interface ProductRow {
  id: string;
  title: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  subcategory: string | null;
  price_cents: number | null;
  currency: string | null;
  compare_at_price_cents: number | null;
  rating: number | null;
  review_count: number | null;
  availability: string;
  dietary_tags: string[] | null;
  health_goals: string[] | null;
  ingredients_primary: string[] | null;
  contains_allergens: string[] | null;
  ships_to_countries: string[] | null;
  dosage: string | null;
  serving_size: string | null;
  servings_per_container: number | null;
  safety_notes: string | null;
}

export const PRODUCT_COLS =
  'id, title, description, brand, category, subcategory, price_cents, currency, compare_at_price_cents, ' +
  'rating, review_count, availability, dietary_tags, health_goals, ingredients_primary, contains_allergens, ' +
  'ships_to_countries, dosage, serving_size, servings_per_container, safety_notes';

export function speakProduct(p: ProductRow): string {
  return `"${p.title}"${p.brand ? ` by ${p.brand}` : ''} — ${fmtPrice(p.price_cents, p.currency)}${
    p.rating != null ? `, rated ${p.rating.toFixed(1)}/5` : ''
  }`;
}

/** Resolve one product by UUID or fuzzy title (rating-ranked, active only). */
export async function resolveProduct(
  sb: SupabaseClient,
  productId: string,
  query: string,
): Promise<{ ok: true; product: ProductRow | null } | { ok: false; error: string }> {
  if (UUID_RE.test(productId)) {
    const { data, error } = await sb
      .from('products')
      .select(PRODUCT_COLS)
      .eq('id', productId)
      .eq('is_active', true)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, product: (data as unknown as ProductRow | null) ?? null };
  }
  if (query) {
    const { data, error } = await sb
      .from('products')
      .select(PRODUCT_COLS)
      .eq('is_active', true)
      .ilike('title', `%${query}%`)
      .order('rating', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, product: (data as unknown as ProductRow | null) ?? null };
  }
  return { ok: true, product: null };
}

// ---------------------------------------------------------------------------
// Services (public.services_catalog — VTID-01092)
// ---------------------------------------------------------------------------

export interface ServiceRow {
  id: string;
  name: string;
  service_type: string;
  provider_name: string | null;
  topic_keys: string[] | null;
  metadata: Record<string, unknown> | null;
}

export const SERVICE_COLS = 'id, name, service_type, provider_name, topic_keys, metadata';

// ---------------------------------------------------------------------------
// Marketplace preferences (memory_facts `marketplace_pref_*` keys)
// ---------------------------------------------------------------------------

/** The full closed set of preference fact keys the MVA reads/writes. */
export const MARKETPLACE_PREF_KEYS = [
  'marketplace_pref_budget_monthly_cents',
  'marketplace_pref_dietary',
  'marketplace_pref_values',
  'marketplace_pref_exclusions',
  'marketplace_pref_excluded_brands',
  'marketplace_pref_excluded_categories',
  'marketplace_pref_format',
] as const;

export type MarketplacePrefKey = (typeof MARKETPLACE_PREF_KEYS)[number];

export interface MarketplacePrefs {
  budget_monthly_cents: number | null;
  dietary: string[];
  values: string[];
  exclusions: string[];
  excluded_brands: string[];
  excluded_categories: string[];
  format: string[];
}

export function emptyPrefs(): MarketplacePrefs {
  return {
    budget_monthly_cents: null,
    dietary: [],
    values: [],
    exclusions: [],
    excluded_brands: [],
    excluded_categories: [],
    format: [],
  };
}

/** Current (non-superseded) marketplace preference facts for the user. */
export async function loadMarketplacePrefs(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<MarketplacePrefs> {
  const prefs = emptyPrefs();
  try {
    const { data } = await sb
      .from('memory_facts')
      .select('fact_key, fact_value')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .in('fact_key', [...MARKETPLACE_PREF_KEYS])
      .eq('entity', 'self')
      .is('superseded_by', null);
    for (const row of (data as Array<{ fact_key: string; fact_value: string }>) ?? []) {
      const v = (row.fact_value ?? '').trim();
      if (!v) continue;
      switch (row.fact_key as MarketplacePrefKey) {
        case 'marketplace_pref_budget_monthly_cents': {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) prefs.budget_monthly_cents = Math.round(n);
          break;
        }
        case 'marketplace_pref_dietary':
          prefs.dietary = toList(v);
          break;
        case 'marketplace_pref_values':
          prefs.values = toList(v);
          break;
        case 'marketplace_pref_exclusions':
          prefs.exclusions = toList(v);
          break;
        case 'marketplace_pref_excluded_brands':
          prefs.excluded_brands = toList(v);
          break;
        case 'marketplace_pref_excluded_categories':
          prefs.excluded_categories = toList(v);
          break;
        case 'marketplace_pref_format':
          prefs.format = toList(v);
          break;
      }
    }
  } catch {
    /* prefs are best-effort personalization seed data */
  }
  return prefs;
}

export function describePrefs(prefs: MarketplacePrefs): string {
  const parts: string[] = [];
  if (prefs.budget_monthly_cents != null) parts.push(`budget ${fmtPrice(prefs.budget_monthly_cents, null)}/month`);
  if (prefs.dietary.length) parts.push(`dietary: ${prefs.dietary.join(', ')}`);
  if (prefs.values.length) parts.push(`values: ${prefs.values.join(', ')}`);
  if (prefs.exclusions.length) parts.push(`avoids: ${prefs.exclusions.join(', ')}`);
  if (prefs.excluded_brands.length) parts.push(`excluded brands: ${prefs.excluded_brands.join(', ')}`);
  if (prefs.excluded_categories.length) parts.push(`excluded categories: ${prefs.excluded_categories.join(', ')}`);
  if (prefs.format.length) parts.push(`preferred format: ${prefs.format.join(', ')}`);
  return parts.length ? parts.join('; ') : 'no saved marketplace preferences';
}

/**
 * Drop products that conflict with the user's saved exclusions. Only checks
 * DECLARED product data (brand, category, dietary_tags, contains_allergens,
 * title keywords) — never guesses. Returns kept items + per-drop reasons so
 * handlers can be transparent about what was filtered and why.
 */
export function applyPrefExclusions(
  items: ProductRow[],
  prefs: MarketplacePrefs,
): { kept: ProductRow[]; dropped: Array<{ title: string; reason: string }> } {
  const kept: ProductRow[] = [];
  const dropped: Array<{ title: string; reason: string }> = [];
  const brandBlock = new Set(prefs.excluded_brands.map((b) => b.toLowerCase()));
  const categoryBlock = new Set(prefs.excluded_categories.map((c) => c.toLowerCase()));
  const exclusionTerms = prefs.exclusions.map((e) => e.toLowerCase());

  for (const p of items) {
    if (p.brand && brandBlock.has(p.brand.toLowerCase())) {
      dropped.push({ title: p.title, reason: `excluded brand ${p.brand}` });
      continue;
    }
    const cat = (p.category ?? '').toLowerCase();
    const subcat = (p.subcategory ?? '').toLowerCase();
    if ((cat && categoryBlock.has(cat)) || (subcat && categoryBlock.has(subcat))) {
      dropped.push({ title: p.title, reason: `excluded category ${p.category ?? p.subcategory}` });
      continue;
    }
    const haystack = `${p.title} ${p.category ?? ''} ${p.subcategory ?? ''}`.toLowerCase();
    const hitTerm = exclusionTerms.find((t) => t && haystack.includes(t));
    if (hitTerm) {
      dropped.push({ title: p.title, reason: `matches exclusion "${hitTerm}"` });
      continue;
    }
    kept.push(p);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Guide state (memory_items content_json.type = 'marketplace_guide_state')
// ---------------------------------------------------------------------------

export interface GuidePick {
  kind: 'product' | 'service';
  id: string;
  title: string;
  price_cents: number | null;
  currency: string | null;
  rationale: string;
  safety_flags?: string[];
}

export interface GuideCriteria {
  budget_max_cents?: number | null;
  formats?: string[];
  urgency?: string | null;
  exclusions?: string[];
  location?: string | null;
  priorities?: string[];
}

export interface GuideState {
  goal: string;
  intent: string | null;
  criteria: GuideCriteria;
  picks: GuidePick[];
  selected: GuidePick | null;
  updated_at: string;
}

export function emptyGuideState(goal: string): GuideState {
  return { goal, intent: null, criteria: {}, picks: [], selected: null, updated_at: new Date().toISOString() };
}

const GUIDE_STATE_TYPE = 'marketplace_guide_state';

/** Latest guide-state row for the user, or null if none exists yet. */
export async function loadGuideState(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<{ rowId: string; state: GuideState } | null> {
  try {
    const { data } = await sb
      .from('memory_items')
      .select('id, content_json')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .eq('content_json->>type', GUIDE_STATE_TYPE)
      .order('occurred_at', { ascending: false })
      .limit(1);
    const row = (data as Array<{ id: string; content_json: Record<string, unknown> }>)?.[0];
    if (!row) return null;
    const cj = row.content_json ?? {};
    const state: GuideState = {
      goal: typeof cj.goal === 'string' ? cj.goal : '',
      intent: typeof cj.intent === 'string' ? cj.intent : null,
      criteria: (cj.criteria as GuideCriteria) ?? {},
      picks: Array.isArray(cj.picks) ? (cj.picks as GuidePick[]) : [],
      selected: (cj.selected as GuidePick | null) ?? null,
      updated_at: typeof cj.updated_at === 'string' ? cj.updated_at : new Date(0).toISOString(),
    };
    return { rowId: row.id, state };
  } catch {
    return null;
  }
}

/** Upsert the guide state: update the existing row or insert the first one. */
export async function saveGuideState(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  state: GuideState,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const stamped: GuideState = { ...state, updated_at: new Date().toISOString() };
  const content = `Marketplace guide: ${stamped.goal || 'no goal yet'}`;
  const contentJson = { type: GUIDE_STATE_TYPE, ...stamped };
  try {
    const existing = await loadGuideState(sb, tenantId, userId);
    if (existing) {
      const { error } = await sb
        .from('memory_items')
        .update({ content, content_json: contentJson, occurred_at: stamped.updated_at })
        .eq('id', existing.rowId);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }
    const { error } = await sb.from('memory_items').insert({
      tenant_id: tenantId,
      user_id: userId,
      category_key: 'preferences',
      source: 'system',
      content,
      content_json: contentJson,
      importance: 30,
      occurred_at: stamped.updated_at,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'guide_state_save_failed' };
  }
}

// ---------------------------------------------------------------------------
// Universal cart staging (mirror of marketplace-discovery-tools.ts)
// ---------------------------------------------------------------------------

function isNoRowsError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'PGRST116';
}
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/**
 * Get-or-create the caller's ONE active universal cart (same resolution
 * block as marketplace-discovery-tools.ts / routes/shopping-agent.ts).
 */
export async function getOrCreateActiveCart(
  sb: SupabaseClient,
  userId: string,
  tenantId: string | null,
): Promise<{ ok: true; cartId: string } | { ok: false; error: string }> {
  const lookup = await sb.from('universal_carts').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle();
  if (lookup.error && !isNoRowsError(lookup.error)) return { ok: false, error: lookup.error.message };
  if (lookup.data?.id) return { ok: true, cartId: lookup.data.id as string };

  const created = await sb
    .from('universal_carts')
    .insert({ user_id: userId, tenant_id: tenantId, status: 'active', metadata: {} })
    .select('id')
    .single();
  if (created.error && isUniqueViolation(created.error)) {
    const raced = await sb.from('universal_carts').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle();
    if (raced.data?.id) return { ok: true, cartId: raced.data.id as string };
    return { ok: false, error: 'cart_create_failed' };
  }
  if (created.error || !created.data?.id) return { ok: false, error: created.error?.message ?? 'cart_create_failed' };

  await emitCartEvent({ cart_id: created.data.id as string, user_id: userId, event_type: 'cart.created', event_payload: {} });
  return { ok: true, cartId: created.data.id as string };
}

/**
 * Stage ONE product into the user's active cart with a voice-origin audit
 * trail. Payment policy: staging only + /cart screen handoff — this helper
 * (and everything that calls it) never touches checkout/Stripe/wallet.
 */
export async function stageProductInCart(
  sb: SupabaseClient,
  id: OrbToolIdentity,
  product: ProductRow,
  origin: string,
  rationale: string,
): Promise<{ ok: true; itemId: string; cartId: string } | { ok: false; error: string }> {
  const cartRes = await getOrCreateActiveCart(sb, id.user_id, id.tenant_id);
  if (!cartRes.ok) return { ok: false, error: cartRes.error };
  const cartId = cartRes.cartId;

  const itemType = product.category === 'supplements' ? 'supplement' : 'partner_product';
  const insertPayload: Record<string, unknown> = {
    cart_id: cartId,
    item_type: itemType,
    product_id: product.id,
    quantity: 1,
    status: 'active',
    source_surface: 'voice',
    metadata: { origin, rationale, vtid: MVA_VTID },
  };
  if (product.price_cents !== null) insertPayload.unit_price_cents_snapshot = product.price_cents;
  if (product.currency !== null) insertPayload.currency_snapshot = product.currency;

  const inserted = await sb.from('universal_cart_items').insert(insertPayload).select('id').single();
  if (inserted.error || !inserted.data) return { ok: false, error: inserted.error?.message ?? 'item_insert_failed' };
  const itemId = inserted.data.id as string;
  await emitCartEvent({
    cart_id: cartId,
    user_id: id.user_id,
    event_type: 'item.added',
    event_payload: { cart_item_id: itemId, product_id: product.id, quantity_before: 0, quantity_after: 1, source_surface: 'voice' },
  });
  return { ok: true, itemId, cartId };
}

// ---------------------------------------------------------------------------
// Health-domain boundary — appended to every diagnostics/health-adjacent
// answer so the model repeats it instead of improvising medical framing.
// ---------------------------------------------------------------------------

export const HEALTH_BOUNDARY_NOTE =
  'Remind the user: this does not diagnose any condition or replace medical evaluation — ' +
  'a qualified professional should interpret health concerns.';

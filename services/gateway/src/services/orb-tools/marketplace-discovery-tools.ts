/**
 * A1 Commerce & Marketplace Discovery voice tools.
 *
 * Real backings verified by grepping the actual gateway routes/services/
 * migrations before writing any handler (per the wave-1 shared brief):
 *
 *   - search_marketplace / get_product_details / browse_supplements /
 *     browse_deals_offers → the SAME `public.products` table
 *     routes/discover-search.ts (GET /search, GET /product/:id) and
 *     routes/discover-feed.ts query. This is the live, populated VTID-02000
 *     marketplace catalog (images, price_cents, affiliate_url, rating,
 *     availability, compare_at_price_cents, etc.) — NOT the sparse
 *     VTID-01092 `products_catalog` memory table some older tools
 *     (discovery-tools.ts's global_search) use for a different purpose.
 *     "Deals" are derived honestly from the real
 *     compare_at_price_cents > price_cents columns; there is no separate
 *     deals/promotions table.
 *   - browse_wellness_services / browse_doctors_coaches / get_provider_profile
 *     → `public.services_catalog` (VTID-01092 migration
 *     20251231100000_vtid_01092_services_products_memory.sql), columns
 *     verified as (id, tenant_id, name, service_type, topic_keys,
 *     provider_name, metadata, created_at). service_type CHECK includes
 *     'coach' | 'doctor' | 'lab' | 'wellness' | 'nutrition' | 'fitness' |
 *     'therapy' | 'other'. Same columns discovery-tools.ts's global_search
 *     already reads from this table.
 *   - get_ai_product_picks → reuses runPropose() from
 *     services/shopping-agent/agent-core.ts verbatim (the exact planning +
 *     limitations-filtered search + annotation logic
 *     routes/shopping-agent.ts POST /propose calls) with a local insertPick
 *     writer that inserts into universal_cart_items directly via the
 *     service-role `sb` this dispatcher always passes (see
 *     routes/orb-tool.ts's `adminClient() || getSupabase()` — every sibling
 *     tool file in this directory does explicit user_id/tenant_id scoping
 *     rather than an RLS-scoped user client, and this file follows the same
 *     convention). NEVER re-implements the AI planning logic itself.
 *   - reorder_last_order → reuses buildReorderPicks() from
 *     services/shopping-agent/reorder-core.ts verbatim (the exact
 *     dedupe → hydrate → drop-out-of-stock → re-snapshot logic
 *     routes/shopping-agent.ts POST /reorder calls), with maxItems=1 so
 *     "last order" resolves to the single most-recently-purchased,
 *     still-purchasable product. Two-step confirm per the shared brief.
 *   - list_my_orders / get_order_status → `public.product_orders`
 *     (supabase/migrations/20260416180000_vtid_02000_fix_products_v2.sql),
 *     columns verified as (id, user_id, tenant_id, product_id, merchant_id,
 *     state, amount_cents, currency, purchased_at, created_at, ...).
 *   - Cart writes (get_ai_product_picks, reorder_last_order confirm step)
 *     reuse emitCartEvent()/sanitizeEventPayload() imported directly from
 *     routes/universal-cart.ts (already an established cross-module import —
 *     routes/shopping-agent.ts imports the same two functions from the same
 *     file) instead of re-deriving the audit-payload whitelist rules.
 *
 * Explicitly STUBBED (no real backing found — see each handler's comment):
 *   - add_supplement_to_regimen / list_my_supplements /
 *     remove_supplement_from_regimen: the frontend's personal supplement
 *     tracker (useUserSupplements.ts) reads/writes `user_supplements`
 *     directly against Supabase. That table is explicitly named as an
 *     OUT-OF-SCOPE "Lovable-side ghost table" the gateway must never read
 *     or write in
 *     supabase/migrations/20260605000000_VTID_03186_universal_cart_schema.sql
 *     (see the VTID-03186 NOTICE block), tracked for convergence under
 *     VTID-03176 / issue #2371. Inventing a gateway-side read/write path to
 *     it would violate that explicit architectural decision.
 *   - apply_discount_code: same story — `user_discount_codes`
 *     (useDiscountCode.ts) is in the SAME out-of-scope ghost-table list.
 *   - get_coach_compatibility: no compatibility-scoring table, RPC, or
 *     service function exists anywhere in the codebase. Fabricating a
 *     scoring algorithm would violate the "never hallucinate" hard rule.
 *
 * Payment policy: get_ai_product_picks and reorder_last_order only ever
 * stage `universal_cart_items` (exactly like the real /propose and /reorder
 * HTTP routes) and return a `navigate` directive at the cart screen for the
 * user to review + pay. Neither tool ever calls checkout/Stripe/wallet debit.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { emitCartEvent } from '../../routes/universal-cart';
import { getUserHealthContext } from '../user-health-context';
import { getMonthlySpend } from '../budget/spend-service';
import { runPropose, type AnnotatedPick, type InsertPickFn } from '../shopping-agent/agent-core';
import { buildReorderPicks } from '../shopping-agent/reorder-core';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CURRENCY = 'EUR';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

async function resolveTenantId(id: OrbToolIdentity, sb: SupabaseClient): Promise<string | null> {
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

function navDirective(
  screen_id: string,
  route: string,
  title: string,
  reason: string,
): Record<string, unknown> {
  return { type: 'orb_directive', directive: 'navigate', screen_id, route, title, reason, vtid: 'A1-MARKETPLACE-DISCOVERY' };
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function fmtPrice(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents == null) return 'price unavailable';
  const amount = (cents / 100).toFixed(2);
  return `${amount} ${currency ?? DEFAULT_CURRENCY}`;
}

interface ProductRow {
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
  affiliate_url?: string | null;
  dosage?: string | null;
  serving_size?: string | null;
  safety_notes?: string | null;
}

const PRODUCT_COLS =
  'id, title, description, brand, category, subcategory, price_cents, currency, compare_at_price_cents, rating, review_count, availability, affiliate_url, dosage, serving_size, safety_notes';

function speakProduct(p: ProductRow): string {
  return `"${p.title}"${p.brand ? ` by ${p.brand}` : ''} — ${fmtPrice(p.price_cents, p.currency)}${
    p.rating != null ? `, rated ${p.rating.toFixed(1)}/5` : ''
  }`;
}

// ---------------------------------------------------------------------------
// 1. search_marketplace
// ---------------------------------------------------------------------------

export async function tool_search_marketplace(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('search_marketplace', id);
  if (gate) return gate;
  const q = String(args.q ?? args.query ?? '').trim();
  const category = String(args.category ?? '').trim();
  const priceMin = args.price_min_cents != null ? Number(args.price_min_cents) : null;
  const priceMax = args.price_max_cents != null ? Number(args.price_max_cents) : null;
  const limit = clampInt(args.limit, 1, 10, 5);

  try {
    let query = sb.from('products').select(PRODUCT_COLS).eq('is_active', true);
    if (q) {
      const sanitized = q.replace(/[&|!<>()]/g, ' ').trim();
      if (sanitized) query = query.textSearch('search_text', sanitized, { config: 'simple', type: 'websearch' });
    }
    if (category) query = query.eq('category', category);
    if (priceMin != null && Number.isFinite(priceMin)) query = query.gte('price_cents', priceMin);
    if (priceMax != null && Number.isFinite(priceMax)) query = query.lte('price_cents', priceMax);
    query = query.order('rating', { ascending: false, nullsFirst: false }).limit(limit);

    const { data, error } = await query;
    if (error) return { ok: false, error: error.message };
    const items = (data as ProductRow[]) ?? [];

    const route = `/discover/marketplace${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    if (items.length === 0) {
      return {
        ok: true,
        result: { items: [], decision: 'list_only', directive: navDirective('DISCOVER.MARKETPLACE', route, 'Marketplace', 'search_marketplace empty') },
        text: q
          ? `I couldn't find anything in the marketplace matching "${q}". Want me to widen the search?`
          : "What are you looking for in the marketplace?",
      };
    }

    return {
      ok: true,
      result: {
        items: items.map((p) => ({
          product_id: p.id,
          title: p.title,
          price_cents: p.price_cents,
          currency: p.currency,
          rating: p.rating,
          availability: p.availability,
        })),
        decision: 'list_only',
        directive: navDirective('DISCOVER.MARKETPLACE', route, 'Marketplace', 'search_marketplace results'),
      },
      text: `I found ${items.length} item${items.length === 1 ? '' : 's'}: ${items.map(speakProduct).join('; ')}. Opening the marketplace.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'search_marketplace failed' };
  }
}

// ---------------------------------------------------------------------------
// 2. get_product_details
// ---------------------------------------------------------------------------

export async function tool_get_product_details(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_product_details', id);
  if (gate) return gate;
  const productId = String(args.product_id ?? '').trim();
  const query = String(args.query ?? args.title ?? '').trim();

  try {
    let product: ProductRow | null = null;

    if (UUID_RE.test(productId)) {
      const { data, error } = await sb
        .from('products')
        .select(PRODUCT_COLS)
        .eq('id', productId)
        .eq('is_active', true)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      product = (data as ProductRow | null) ?? null;
    } else if (query) {
      const { data, error } = await sb
        .from('products')
        .select(PRODUCT_COLS)
        .eq('is_active', true)
        .ilike('title', `%${query}%`)
        .order('rating', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      product = (data as ProductRow | null) ?? null;
    } else {
      return { ok: false, error: 'get_product_details requires a product_id or a product name to look up.' };
    }

    if (!product) {
      return {
        ok: true,
        result: { found: false },
        text: `I couldn't find that product${query ? ` ("${query}")` : ''} in the marketplace.`,
      };
    }

    const route = `/discover/product/${encodeURIComponent(product.id)}`;
    return {
      ok: true,
      result: {
        product_id: product.id,
        title: product.title,
        description: product.description,
        brand: product.brand,
        price_cents: product.price_cents,
        currency: product.currency,
        rating: product.rating,
        review_count: product.review_count,
        availability: product.availability,
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.PRODUCT_DETAIL', route, product.title, 'get_product_details resolved'),
        redirect: { route },
      },
      text: `${speakProduct(product)}.${product.description ? ` ${product.description.slice(0, 200)}` : ''} Opening the product page.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_product_details failed' };
  }
}

// ---------------------------------------------------------------------------
// 3. browse_supplements
// ---------------------------------------------------------------------------

export async function tool_browse_supplements(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('browse_supplements', id);
  if (gate) return gate;
  const limit = clampInt(args.limit, 1, 10, 8);
  try {
    const { data, error } = await sb
      .from('products')
      .select(PRODUCT_COLS)
      .eq('is_active', true)
      .eq('category', 'supplements')
      .order('rating', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) return { ok: false, error: error.message };
    const items = (data as ProductRow[]) ?? [];
    const route = '/discover/supplements';
    if (items.length === 0) {
      return {
        ok: true,
        result: { items: [], directive: navDirective('DISCOVER.SUPPLEMENTS', route, 'Supplements', 'browse_supplements empty') },
        text: 'There are no supplements in the marketplace catalog right now.',
      };
    }
    return {
      ok: true,
      result: {
        items: items.map((p) => ({ product_id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, rating: p.rating })),
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.SUPPLEMENTS', route, 'Supplements', 'browse_supplements'),
        redirect: { route },
      },
      text: `Here are ${items.length} supplements: ${items.map(speakProduct).join('; ')}. Opening the supplements shop.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'browse_supplements failed' };
  }
}

// ---------------------------------------------------------------------------
// 4-6. Personal supplement regimen — STUBBED (see file header).
// ---------------------------------------------------------------------------

const REGIMEN_UNAVAILABLE =
  'The personal supplement regimen tracker (user_supplements) is an explicit ' +
  'out-of-scope "Lovable-side ghost table" the gateway is documented to never ' +
  'read or write (VTID-03186 migration NOTICE; tracked under VTID-03176 / ' +
  'issue #2371). This tool has no real backing yet.';

export async function tool_add_supplement_to_regimen(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('add_supplement_to_regimen', id);
  if (gate) return gate;
  return { ok: false, error: `add_supplement_to_regimen is not available yet — ${REGIMEN_UNAVAILABLE}` };
}

export async function tool_list_my_supplements(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('list_my_supplements', id);
  if (gate) return gate;
  return { ok: false, error: `list_my_supplements is not available yet — ${REGIMEN_UNAVAILABLE}` };
}

export async function tool_remove_supplement_from_regimen(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('remove_supplement_from_regimen', id);
  if (gate) return gate;
  return { ok: false, error: `remove_supplement_from_regimen is not available yet — ${REGIMEN_UNAVAILABLE}` };
}

// ---------------------------------------------------------------------------
// 7. browse_wellness_services
// ---------------------------------------------------------------------------

interface ServiceRow {
  id: string;
  name: string;
  service_type: string;
  provider_name: string | null;
  topic_keys: string[] | null;
  metadata: Record<string, unknown> | null;
}
const SERVICE_COLS = 'id, name, service_type, provider_name, topic_keys, metadata';
const WELLNESS_TYPES = ['wellness', 'nutrition', 'fitness', 'therapy', 'lab', 'other'];
const PRACTITIONER_TYPES = ['doctor', 'coach'];

export async function tool_browse_wellness_services(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('browse_wellness_services', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'browse_wellness_services requires a known tenant context.' };
  const limit = clampInt(args.limit, 1, 10, 8);
  try {
    const { data, error } = await sb
      .from('services_catalog')
      .select(SERVICE_COLS)
      .eq('tenant_id', tenantId)
      .in('service_type', WELLNESS_TYPES)
      .limit(limit);
    if (error) return { ok: false, error: error.message };
    const items = (data as ServiceRow[]) ?? [];
    const route = '/discover/wellness-services';
    if (items.length === 0) {
      return {
        ok: true,
        result: { items: [], directive: navDirective('DISCOVER.WELLNESS_SERVICES', route, 'Wellness Services', 'browse_wellness_services empty') },
        text: "There aren't any wellness services listed yet.",
      };
    }
    return {
      ok: true,
      result: {
        items: items.map((s) => ({ service_id: s.id, name: s.name, service_type: s.service_type, provider_name: s.provider_name })),
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.WELLNESS_SERVICES', route, 'Wellness Services', 'browse_wellness_services'),
        redirect: { route },
      },
      text: `Wellness services: ${items.map((s) => `"${s.name}"${s.provider_name ? ` with ${s.provider_name}` : ''}`).join('; ')}. Opening wellness services.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'browse_wellness_services failed' };
  }
}

// ---------------------------------------------------------------------------
// 8. get_provider_profile
// ---------------------------------------------------------------------------

export async function tool_get_provider_profile(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_provider_profile', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'get_provider_profile requires a known tenant context.' };
  const serviceId = String(args.provider_id ?? args.service_id ?? '').trim();
  const query = String(args.query ?? args.name ?? '').trim();
  try {
    let row: ServiceRow | null = null;
    if (UUID_RE.test(serviceId)) {
      const { data, error } = await sb
        .from('services_catalog')
        .select(SERVICE_COLS)
        .eq('tenant_id', tenantId)
        .eq('id', serviceId)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      row = (data as ServiceRow | null) ?? null;
    } else if (query) {
      const { data, error } = await sb
        .from('services_catalog')
        .select(SERVICE_COLS)
        .eq('tenant_id', tenantId)
        .or(`name.ilike.%${query}%,provider_name.ilike.%${query}%`)
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      row = (data as ServiceRow | null) ?? null;
    } else {
      return { ok: false, error: 'get_provider_profile requires a provider_id or a name to look up.' };
    }

    if (!row) {
      return { ok: true, result: { found: false }, text: `I couldn't find a provider matching ${query ? `"${query}"` : 'that'}.` };
    }

    const route = `/discover/provider/${encodeURIComponent(row.id)}`;
    return {
      ok: true,
      result: {
        service_id: row.id,
        name: row.name,
        service_type: row.service_type,
        provider_name: row.provider_name,
        topic_keys: row.topic_keys ?? [],
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.PROVIDER_PROFILE', route, row.name, 'get_provider_profile resolved'),
        redirect: { route },
      },
      text: `"${row.name}"${row.provider_name ? ` (${row.provider_name})` : ''} — ${row.service_type}. Opening the provider profile.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_provider_profile failed' };
  }
}

// ---------------------------------------------------------------------------
// 9. browse_doctors_coaches
// ---------------------------------------------------------------------------

export async function tool_browse_doctors_coaches(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('browse_doctors_coaches', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'browse_doctors_coaches requires a known tenant context.' };
  const limit = clampInt(args.limit, 1, 10, 8);
  try {
    const { data, error } = await sb
      .from('services_catalog')
      .select(SERVICE_COLS)
      .eq('tenant_id', tenantId)
      .in('service_type', PRACTITIONER_TYPES)
      .limit(limit);
    if (error) return { ok: false, error: error.message };
    const items = (data as ServiceRow[]) ?? [];
    const route = '/discover/doctors-coaches';
    if (items.length === 0) {
      return {
        ok: true,
        result: { items: [], directive: navDirective('DISCOVER.DOCTORS_COACHES', route, 'Doctors & Coaches', 'browse_doctors_coaches empty') },
        text: "There aren't any doctors or coaches listed yet.",
      };
    }
    return {
      ok: true,
      result: {
        items: items.map((s) => ({ service_id: s.id, name: s.name, service_type: s.service_type, provider_name: s.provider_name })),
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.DOCTORS_COACHES', route, 'Doctors & Coaches', 'browse_doctors_coaches'),
        redirect: { route },
      },
      text: `Doctors & coaches: ${items.map((s) => `"${s.name}" (${s.service_type})`).join('; ')}. Opening doctors & coaches.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'browse_doctors_coaches failed' };
  }
}

// ---------------------------------------------------------------------------
// 10. get_coach_compatibility — STUBBED (see file header).
// ---------------------------------------------------------------------------

export async function tool_get_coach_compatibility(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_coach_compatibility', id);
  if (gate) return gate;
  return {
    ok: false,
    error:
      'get_coach_compatibility is not available yet — no compatibility-scoring table, RPC, or service exists in this ' +
      'codebase. Fabricating a score here would be inventing data, which is not allowed.',
  };
}

// ---------------------------------------------------------------------------
// 11. browse_deals_offers
// ---------------------------------------------------------------------------

export async function tool_browse_deals_offers(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('browse_deals_offers', id);
  if (gate) return gate;
  const limit = clampInt(args.limit, 1, 10, 8);
  try {
    // "Deals" are derived honestly from the real products.compare_at_price_cents
    // column (no dedicated deals/promotions table exists) — a product is "on
    // sale" when its compare_at_price_cents (the pre-discount reference price)
    // is present and greater than its current price_cents.
    const { data, error } = await sb
      .from('products')
      .select(PRODUCT_COLS)
      .eq('is_active', true)
      .eq('availability', 'in_stock')
      .not('compare_at_price_cents', 'is', null)
      .order('rating', { ascending: false, nullsFirst: false })
      .limit(50);
    if (error) return { ok: false, error: error.message };
    const onSale = ((data as ProductRow[]) ?? []).filter(
      (p) => p.compare_at_price_cents != null && p.price_cents != null && p.compare_at_price_cents > p.price_cents,
    );
    onSale.sort((a, b) => {
      const discA = (a.compare_at_price_cents! - a.price_cents!) / a.compare_at_price_cents!;
      const discB = (b.compare_at_price_cents! - b.price_cents!) / b.compare_at_price_cents!;
      return discB - discA;
    });
    const items = onSale.slice(0, limit);
    const route = '/discover/deals-offers';

    if (items.length === 0) {
      return {
        ok: true,
        result: { items: [], directive: navDirective('DISCOVER.DEALS', route, 'Deals & Offers', 'browse_deals_offers empty') },
        text: "There aren't any active deals in the marketplace right now.",
      };
    }
    const speak = (p: ProductRow) => {
      const pct = Math.round(((p.compare_at_price_cents! - p.price_cents!) / p.compare_at_price_cents!) * 100);
      return `"${p.title}" — ${fmtPrice(p.price_cents, p.currency)} (${pct}% off ${fmtPrice(p.compare_at_price_cents, p.currency)})`;
    };
    return {
      ok: true,
      result: {
        items: items.map((p) => ({
          product_id: p.id,
          title: p.title,
          price_cents: p.price_cents,
          compare_at_price_cents: p.compare_at_price_cents,
          currency: p.currency,
        })),
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.DEALS', route, 'Deals & Offers', 'browse_deals_offers'),
        redirect: { route },
      },
      text: `Current deals: ${items.map(speak).join('; ')}. Opening deals & offers.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'browse_deals_offers failed' };
  }
}

// ---------------------------------------------------------------------------
// 12. apply_discount_code — STUBBED (see file header).
// ---------------------------------------------------------------------------

export async function tool_apply_discount_code(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('apply_discount_code', id);
  if (gate) return gate;
  return {
    ok: false,
    error:
      'apply_discount_code is not available yet — the discount-code table (user_discount_codes) used by the ' +
      "frontend's useDiscountCode.ts is an explicit out-of-scope \"Lovable-side ghost table\" the gateway is " +
      'documented to never read or write (VTID-03186 migration NOTICE; tracked under VTID-03176 / issue #2371).',
  };
}

// ---------------------------------------------------------------------------
// Cart helpers shared by get_ai_product_picks + reorder_last_order.
// ---------------------------------------------------------------------------

function isNoRowsError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'PGRST116';
}
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/**
 * Get-or-create the caller's ONE active universal cart. Mirrors the
 * resolution block in routes/shopping-agent.ts's resolveActiveCartId, using
 * the service-role `sb` this dispatcher passes (explicit user_id/tenant_id
 * scoping instead of an RLS-scoped user client, matching every other handler
 * in this tool-file family — see routes/orb-tool.ts).
 */
async function getOrCreateActiveCart(
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

// ---------------------------------------------------------------------------
// 13. get_ai_product_picks
// ---------------------------------------------------------------------------

export async function tool_get_ai_product_picks(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_ai_product_picks', id);
  if (gate) return gate;
  const prompt = String(args.prompt ?? args.query ?? '').trim();
  if (!prompt) {
    return { ok: false, error: 'get_ai_product_picks requires a description of what the user is looking for.' };
  }
  const maxItems = clampInt(args.max_items, 1, 6, 4);

  try {
    const ctx = await getUserHealthContext(id.user_id);
    const cartRes = await getOrCreateActiveCart(sb, id.user_id, id.tenant_id);
    if (!cartRes.ok) return { ok: false, error: cartRes.error };
    const cartId = cartRes.cartId;
    const monthlySpendCents = await getMonthlySpend(sb, id.user_id, ctx.currency ?? DEFAULT_CURRENCY);
    const runId = randomUUID();

    const insertPick: InsertPickFn = async (pick: AnnotatedPick, rid: string, proposedAt: string) => {
      const insertPayload: Record<string, unknown> = {
        cart_id: cartId,
        item_type: pick.item_type,
        product_id: pick.product_id,
        quantity: 1,
        status: 'active',
        source_surface: 'voice',
        metadata: {
          origin: 'agent',
          rationale: pick.rationale,
          safety_flags: pick.safety_flags,
          confidence: pick.confidence,
          run_id: rid,
          proposed_at: proposedAt,
        },
      };
      if (pick.unit_price_cents_snapshot !== null) insertPayload.unit_price_cents_snapshot = pick.unit_price_cents_snapshot;
      if (pick.currency_snapshot !== null) insertPayload.currency_snapshot = pick.currency_snapshot;

      const inserted = await sb.from('universal_cart_items').insert(insertPayload).select('id').single();
      if (inserted.error || !inserted.data) return { ok: false, error: inserted.error?.message ?? 'item_insert_failed' };
      const itemId = inserted.data.id as string;
      await emitCartEvent({
        cart_id: cartId,
        user_id: id.user_id,
        event_type: 'item.added',
        event_payload: { cart_item_id: itemId, product_id: pick.product_id, quantity_before: 0, quantity_after: 1, source_surface: 'voice' },
      });
      return { ok: true, item_id: itemId };
    };

    const result = await runPropose({ prompt, maxItems, ctx, supabase: sb, insertPick, runId, monthly_spend_cents: monthlySpendCents });

    if (!result.ok) {
      if (result.error === 'llm_unavailable') {
        return { ok: false, error: 'get_ai_product_picks is temporarily unavailable — no AI provider is reachable right now.' };
      }
      return { ok: false, error: result.error ?? 'get_ai_product_picks failed' };
    }

    const proposed = result.proposed ?? [];
    const route = '/cart';
    if (proposed.length === 0) {
      return {
        ok: true,
        result: { proposed: [], advisory: result.advisory ?? [] },
        text: "I couldn't find anything in the marketplace matching that request right now.",
      };
    }
    return {
      ok: true,
      result: {
        run_id: result.run_id,
        proposed,
        advisory: result.advisory ?? [],
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.CART', route, 'Shopping Cart', 'get_ai_product_picks proposed'),
        redirect: { route },
      },
      text: `I've added ${proposed.length} pick${proposed.length === 1 ? '' : 's'} to your cart: ${proposed
        .map((p) => `"${p.title}" (${p.rationale})`)
        .join('; ')}. Review and confirm payment on your screen.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_ai_product_picks failed' };
  }
}

// ---------------------------------------------------------------------------
// 14. list_my_orders
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  product_id: string | null;
  state: string;
  amount_cents: number | null;
  currency: string | null;
  purchased_at: string | null;
  created_at: string;
}
const ORDER_COLS = 'id, product_id, state, amount_cents, currency, purchased_at, created_at';

export async function tool_list_my_orders(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('list_my_orders', id);
  if (gate) return gate;
  const limit = clampInt(args.limit, 1, 20, 10);
  try {
    const { data, error } = await sb
      .from('product_orders')
      .select(ORDER_COLS)
      .eq('user_id', id.user_id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return { ok: false, error: error.message };
    const orders = (data as OrderRow[]) ?? [];
    const route = '/discover/orders';
    if (orders.length === 0) {
      return {
        ok: true,
        result: { orders: [], directive: navDirective('DISCOVER.ORDERS', route, 'Orders', 'list_my_orders empty') },
        text: "You don't have any orders yet.",
      };
    }
    // Resolve product titles for a readable summary (best-effort).
    const productIds = orders.map((o) => o.product_id).filter((v): v is string => !!v);
    const titleById = new Map<string, string>();
    if (productIds.length > 0) {
      const { data: products } = await sb.from('products').select('id, title').in('id', productIds);
      for (const p of (products as Array<{ id: string; title: string }>) ?? []) titleById.set(p.id, p.title);
    }
    const speak = (o: OrderRow) =>
      `${o.product_id ? titleById.get(o.product_id) ?? 'an item' : 'an item'} — ${o.state}${
        o.amount_cents != null ? ` (${fmtPrice(o.amount_cents, o.currency)})` : ''
      }`;
    return {
      ok: true,
      result: {
        orders: orders.map((o) => ({
          order_id: o.id,
          product_id: o.product_id,
          title: o.product_id ? titleById.get(o.product_id) ?? null : null,
          state: o.state,
          amount_cents: o.amount_cents,
          currency: o.currency,
          purchased_at: o.purchased_at,
        })),
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.ORDERS', route, 'Orders', 'list_my_orders'),
        redirect: { route },
      },
      text: `Your recent orders: ${orders.map(speak).join('; ')}. Opening your orders.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'list_my_orders failed' };
  }
}

// ---------------------------------------------------------------------------
// 15. get_order_status
// ---------------------------------------------------------------------------

export async function tool_get_order_status(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_order_status', id);
  if (gate) return gate;
  const orderId = String(args.order_id ?? '').trim();
  try {
    let order: OrderRow | null = null;
    if (UUID_RE.test(orderId)) {
      const { data, error } = await sb
        .from('product_orders')
        .select(ORDER_COLS)
        .eq('id', orderId)
        .eq('user_id', id.user_id)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      order = (data as OrderRow | null) ?? null;
    } else {
      // No order_id given → track the most recent order (a reasonable
      // default for "where's my order?").
      const { data, error } = await sb
        .from('product_orders')
        .select(ORDER_COLS)
        .eq('user_id', id.user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      order = (data as OrderRow | null) ?? null;
    }

    if (!order) {
      return { ok: true, result: { found: false }, text: "I couldn't find that order." };
    }
    let title: string | null = null;
    if (order.product_id) {
      const { data: product } = await sb.from('products').select('title').eq('id', order.product_id).maybeSingle();
      title = (product as { title?: string } | null)?.title ?? null;
    }
    const route = '/discover/orders';
    return {
      ok: true,
      result: {
        order_id: order.id,
        title,
        state: order.state,
        amount_cents: order.amount_cents,
        currency: order.currency,
        purchased_at: order.purchased_at,
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.ORDERS', route, 'Orders', 'get_order_status resolved'),
        redirect: { route },
      },
      text: `Your order${title ? ` for "${title}"` : ''} is ${order.state}${
        order.amount_cents != null ? ` (${fmtPrice(order.amount_cents, order.currency)})` : ''
      }.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_order_status failed' };
  }
}

// ---------------------------------------------------------------------------
// 16. reorder_last_order (⚠️ two-step confirm)
// ---------------------------------------------------------------------------

export async function tool_reorder_last_order(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('reorder_last_order', id);
  if (gate) return gate;
  try {
    const ctx = await getUserHealthContext(id.user_id);
    // maxItems=1: buildReorderPicks returns picks most-recently-purchased-first,
    // so 1 resolves to exactly "the last order" (still purchasable today).
    const picks = await buildReorderPicks(sb, ctx, 1);

    if (picks.length === 0) {
      return {
        ok: true,
        result: { reordered: false },
        text: "I couldn't find a previous order of yours that's still available to reorder.",
      };
    }
    const pick = picks[0];

    if (args.confirm !== true) {
      return {
        ok: true,
        result: {
          needs_confirmation: true,
          product_id: pick.product_id,
          title: pick.title,
          price_cents: pick.unit_price_cents_snapshot,
          currency: pick.currency_snapshot,
        },
        text: `Confirm with the user: add "${pick.title}" (${fmtPrice(pick.unit_price_cents_snapshot, pick.currency_snapshot)}) — your last order — back to the cart? When they say yes, call reorder_last_order again with confirm:true.`,
      };
    }

    const cartRes = await getOrCreateActiveCart(sb, id.user_id, id.tenant_id);
    if (!cartRes.ok) return { ok: false, error: cartRes.error };
    const cartId = cartRes.cartId;
    const runId = randomUUID();
    const proposedAt = new Date().toISOString();

    const insertPayload: Record<string, unknown> = {
      cart_id: cartId,
      item_type: pick.item_type,
      product_id: pick.product_id,
      quantity: 1,
      status: 'active',
      source_surface: 'voice',
      metadata: {
        origin: 'reorder',
        rationale: pick.rationale,
        safety_flags: pick.safety_flags,
        confidence: pick.confidence,
        run_id: runId,
        proposed_at: proposedAt,
        previously_purchased_at: pick.previously_purchased_at,
      },
    };
    if (pick.unit_price_cents_snapshot !== null) insertPayload.unit_price_cents_snapshot = pick.unit_price_cents_snapshot;
    if (pick.currency_snapshot !== null) insertPayload.currency_snapshot = pick.currency_snapshot;

    const inserted = await sb.from('universal_cart_items').insert(insertPayload).select('id').single();
    if (inserted.error || !inserted.data) {
      return { ok: false, error: inserted.error?.message ?? 'reorder_insert_failed' };
    }
    const itemId = inserted.data.id as string;
    await emitCartEvent({
      cart_id: cartId,
      user_id: id.user_id,
      event_type: 'item.added',
      event_payload: { cart_item_id: itemId, product_id: pick.product_id, quantity_before: 0, quantity_after: 1, source_surface: 'voice' },
    });

    const route = '/cart';
    return {
      ok: true,
      result: {
        reordered: true,
        item_id: itemId,
        product_id: pick.product_id,
        title: pick.title,
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.CART', route, 'Shopping Cart', 'reorder_last_order added'),
        redirect: { route },
      },
      text: `Done — I've added "${pick.title}" back to your cart. Confirm payment on your screen.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'reorder_last_order failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const MARKETPLACE_DISCOVERY_TOOL_HANDLERS: Record<string, Handler> = {
  search_marketplace: tool_search_marketplace,
  get_product_details: tool_get_product_details,
  browse_supplements: tool_browse_supplements,
  add_supplement_to_regimen: tool_add_supplement_to_regimen,
  list_my_supplements: tool_list_my_supplements,
  remove_supplement_from_regimen: tool_remove_supplement_from_regimen,
  browse_wellness_services: tool_browse_wellness_services,
  get_provider_profile: tool_get_provider_profile,
  browse_doctors_coaches: tool_browse_doctors_coaches,
  get_coach_compatibility: tool_get_coach_compatibility,
  browse_deals_offers: tool_browse_deals_offers,
  apply_discount_code: tool_apply_discount_code,
  get_ai_product_picks: tool_get_ai_product_picks,
  list_my_orders: tool_list_my_orders,
  get_order_status: tool_get_order_status,
  reorder_last_order: tool_reorder_last_order,
};

export const MARKETPLACE_DISCOVERY_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'search_marketplace',
    description: [
      'Search the Maxina marketplace for products by free-text query, category,',
      'or price range. CALL WHEN the user says: "search the marketplace for ...",',
      '"find me some ...", "durchsuche den Marktplatz nach ...".',
      'Read the top results (name, price, rating) aloud.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text search query.' },
        category: { type: 'string', description: 'Exact product category (e.g. "supplements").' },
        price_min_cents: { type: 'number', description: 'Minimum price in cents.' },
        price_max_cents: { type: 'number', description: 'Maximum price in cents.' },
        limit: { type: 'number', description: 'Max results to return (default 5, max 10).' },
      },
      required: [],
    },
  },
  {
    name: 'get_product_details',
    description: [
      'Get details for one marketplace product by id or by spoken name.',
      'CALL WHEN the user asks: "tell me about ...", "what is ... exactly",',
      '"erzähl mir mehr über ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Exact product UUID when known from a previous tool result.' },
        query: { type: 'string', description: 'Spoken product name (fuzzy matched).' },
      },
      required: [],
    },
  },
  {
    name: 'browse_supplements',
    description: [
      'Browse the marketplace supplements shop (NOT the personal supplement',
      'tracker — that is unavailable via voice today).',
      'CALL WHEN the user says: "show me supplements", "what supplements do you',
      'have", "zeig mir Nahrungsergänzungsmittel".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 8, max 10).' } },
      required: [],
    },
  },
  {
    name: 'add_supplement_to_regimen',
    description:
      'NOT CURRENTLY AVAILABLE via voice — always returns an error explaining ' +
      'the personal supplement tracker has no gateway-side backing yet. Do not ' +
      'call unless the user explicitly asks to add a supplement to their ' +
      'personal regimen/tracker, then relay the unavailability honestly.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Supplement name.' } },
      required: [],
    },
  },
  {
    name: 'list_my_supplements',
    description:
      'NOT CURRENTLY AVAILABLE via voice — always returns an error. Do not call ' +
      'unless the user explicitly asks to hear their personal supplement list, ' +
      'then relay the unavailability honestly.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'remove_supplement_from_regimen',
    description:
      'NOT CURRENTLY AVAILABLE via voice — always returns an error. Do not call ' +
      'unless the user explicitly asks to remove a supplement from their ' +
      'personal regimen, then relay the unavailability honestly.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Supplement name.' } },
      required: [],
    },
  },
  {
    name: 'browse_wellness_services',
    description: [
      'Browse wellness/nutrition/fitness/therapy/lab services listed in the',
      'Maxina marketplace. CALL WHEN the user asks about wellness services,',
      'massage, spa, recovery, or treatments — "Wellness-Services".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 8, max 10).' } },
      required: [],
    },
  },
  {
    name: 'get_provider_profile',
    description: [
      'Get one service/provider listing by id or spoken name (doctor, coach,',
      'wellness provider, etc). CALL WHEN the user asks about a specific',
      'provider or practitioner by name.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        provider_id: { type: 'string', description: 'Exact service/provider UUID when known.' },
        query: { type: 'string', description: 'Spoken provider or service name (fuzzy matched).' },
      },
      required: [],
    },
  },
  {
    name: 'browse_doctors_coaches',
    description: [
      'Browse doctors and coaches listed in the marketplace. CALL WHEN the user',
      'asks to find a doctor, coach, practitioner, or specialist — "Ärzte &',
      'Coaches".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 8, max 10).' } },
      required: [],
    },
  },
  {
    name: 'get_coach_compatibility',
    description:
      'NOT CURRENTLY AVAILABLE via voice — always returns an error, since no ' +
      'compatibility-scoring system exists yet. Do not fabricate a score; relay ' +
      'the unavailability honestly if asked.',
    parameters: {
      type: 'object',
      properties: { provider_id: { type: 'string', description: 'Coach/provider UUID.' } },
      required: [],
    },
  },
  {
    name: 'browse_deals_offers',
    description: [
      'Browse marketplace products currently on sale (discounted vs. their',
      'reference price). CALL WHEN the user asks about deals, discounts,',
      'offers, promotions, or "what is on sale" — "Angebote & Deals".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 8, max 10).' } },
      required: [],
    },
  },
  {
    name: 'apply_discount_code',
    description:
      'NOT CURRENTLY AVAILABLE via voice — always returns an error, since the ' +
      'discount-code system has no gateway-side backing yet. Do not call unless ' +
      'the user explicitly asks to apply a promo code, then relay the ' +
      'unavailability honestly.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The discount/promo code.' } },
      required: [],
    },
  },
  {
    name: 'get_ai_product_picks',
    description: [
      'Have the Vitana shopping agent propose marketplace products for a goal',
      'or need, filtered against the user\'s health/dietary/budget profile, and',
      'add them to the cart for review (NEVER charges anything).',
      'CALL WHEN the user says: "find me something for ...", "what should I take',
      'for ...", "shop for ... for me", "kauf mir etwas gegen ...".',
      'After the tool runs, read the picks + rationale aloud and tell the user',
      'to confirm payment on screen — never say payment completed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the user wants help finding/shopping for.' },
        max_items: { type: 'number', description: 'Max picks to propose (default 4, max 6).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_my_orders',
    description: [
      'List the user\'s recent marketplace orders with status and amount.',
      'CALL WHEN the user asks: "what have I ordered", "show my orders",',
      '"zeig mir meine Bestellungen".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max orders to return (default 10, max 20).' } },
      required: [],
    },
  },
  {
    name: 'get_order_status',
    description: [
      'Check the status of one order by id, or the most recent order if no id',
      'is given. CALL WHEN the user asks: "where is my order", "track my order",',
      '"wo ist meine Bestellung".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string', description: 'Exact order UUID when known.' } },
      required: [],
    },
  },
  {
    name: 'reorder_last_order',
    description: [
      'Add the user\'s most recent (still-available) purchase back to the cart.',
      'ALWAYS call once WITHOUT confirm first — the tool returns a confirmation',
      'question; after the user says yes, call again with confirm:true. NEVER',
      'charges anything — only stages the cart.',
      'CALL WHEN the user says: "reorder my last order", "get me the same thing',
      'again", "bestelle das Gleiche nochmal".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the reorder.' } },
      required: [],
    },
  },
];

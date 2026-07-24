/**
 * A20–A29 Marketplace Voice Assistant — unified discovery, guided
 * recommendation, concise explanation, comparison & shortlist, suitability
 * checks, budget review, and confirmed cart actions (expansion v3, Wave MVA-1).
 *
 * Real backings (same verification discipline as marketplace-discovery-tools.ts):
 *   - Product search → `public.products` (VTID-02000) with the discover-search
 *     column set; dietary/certification filters use the real `dietary_tags` /
 *     `certifications` array columns (`.contains`), never guessed data.
 *   - Service search → `public.services_catalog` (VTID-01092).
 *   - Picks → shopping-agent runPropose() with a COLLECT-ONLY insertPick
 *     (propose, don't stage); deterministic search fallback when the LLM is
 *     unreachable. Pick rationales are persisted in the guide state
 *     (marketplace-va-shared.ts) so "why this one?" answers cite the real
 *     recorded reason.
 *   - Shortlist → `public.shop_saved_products` (VTID-03237 — the existing
 *     saved-products/wishlist table the Video Shop drawer writes; video_id
 *     stays NULL for voice saves). Products only: services have no saved-list
 *     backing yet and are said so honestly.
 *   - Cart reads/writes → `universal_carts`/`universal_cart_items` via the
 *     shared stageProductInCart() (emitCartEvent audit; source_surface
 *     'voice'). Payment policy: staging + /cart screen handoff ONLY.
 *   - Budget → `user_limitations.budget_monthly_cap_cents` (the same column
 *     set_shopping_budget writes) + getMonthlySpend().
 *
 * Health boundary: nothing here diagnoses or promises outcomes; suitability
 * checks are limited to DECLARED product data and say what they could not
 * check rather than guessing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { getUserHealthContext } from '../user-health-context';
import { getMonthlySpend } from '../budget/spend-service';
import { runPropose, type AnnotatedPick, type InsertPickFn } from '../shopping-agent/agent-core';
import {
  authGate,
  resolveTenantId,
  navDirective,
  clampInt,
  fmtPrice,
  toList,
  UUID_RE,
  DEFAULT_CURRENCY,
  type ProductRow,
  PRODUCT_COLS,
  speakProduct,
  resolveProduct,
  type ServiceRow,
  SERVICE_COLS,
  loadMarketplacePrefs,
  applyPrefExclusions,
  type MarketplacePrefs,
  type GuidePick,
  emptyGuideState,
  loadGuideState,
  saveGuideState,
  stageProductInCart,
  HEALTH_BOUNDARY_NOTE,
} from './marketplace-va-shared';
import { classifyIntent } from './marketplace-guide-tools';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Shared query helpers
// ---------------------------------------------------------------------------

async function productNeedSearch(
  sb: SupabaseClient,
  need: string,
  prefs: MarketplacePrefs,
  opts: { budgetMaxCents?: number | null; dietary?: string[]; certifications?: string[]; excludeId?: string; category?: string | null; limit: number },
): Promise<{ items: ProductRow[]; dropped: Array<{ title: string; reason: string }>; error?: string }> {
  const run = async (useWebsearch: boolean): Promise<{ rows: ProductRow[]; error?: string }> => {
    let query = sb.from('products').select(PRODUCT_COLS).eq('is_active', true);
    const sanitized = need.replace(/[&|!<>()]/g, ' ').trim();
    if (sanitized) {
      if (useWebsearch) {
        query = query.textSearch('search_text', sanitized, { config: 'simple', type: 'websearch' });
      } else {
        const token = sanitized.split(/\s+/).sort((a, b) => b.length - a.length)[0];
        if (token && token.length >= 3) query = query.ilike('search_text', `%${token}%`);
      }
    }
    if (opts.budgetMaxCents != null) query = query.lte('price_cents', opts.budgetMaxCents);
    if (opts.dietary?.length) query = query.contains('dietary_tags', opts.dietary);
    if (opts.certifications?.length) query = query.contains('certifications', opts.certifications);
    if (opts.category) query = query.eq('category', opts.category);
    if (opts.excludeId) query = query.neq('id', opts.excludeId);
    const { data, error } = await query
      .order('rating', { ascending: false, nullsFirst: false })
      .limit(Math.max(opts.limit * 3, 12));
    if (error) return { rows: [], error: error.message };
    return { rows: (data as unknown as ProductRow[]) ?? [] };
  };

  let res = await run(true);
  if (res.error) return { items: [], dropped: [], error: res.error };
  if (res.rows.length === 0 && need.trim()) {
    res = await run(false);
    if (res.error) return { items: [], dropped: [], error: res.error };
  }
  const { kept, dropped } = applyPrefExclusions(res.rows, prefs);
  return { items: kept.slice(0, opts.limit), dropped };
}

async function serviceNeedSearch(
  sb: SupabaseClient,
  tenantId: string,
  need: string,
  limit: number,
  serviceTypes?: string[],
): Promise<ServiceRow[]> {
  const tokens = need
    .replace(/[%,()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  let query = sb.from('services_catalog').select(SERVICE_COLS).eq('tenant_id', tenantId);
  if (serviceTypes?.length) query = query.in('service_type', serviceTypes);
  if (tokens.length) {
    query = query.or(tokens.map((t) => `name.ilike.%${t}%,provider_name.ilike.%${t}%`).join(','));
  }
  const { data, error } = await query.limit(limit);
  if (error) return [];
  return (data as ServiceRow[]) ?? [];
}

interface CartItemRow {
  id: string;
  product_id: string | null;
  item_type: string;
  quantity: number;
  status: string;
  unit_price_cents_snapshot: number | null;
  currency_snapshot: string | null;
  metadata: Record<string, unknown> | null;
}

async function loadActiveCartItems(
  sb: SupabaseClient,
  userId: string,
): Promise<{ ok: true; cartId: string | null; items: CartItemRow[] } | { ok: false; error: string }> {
  const cart = await sb.from('universal_carts').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle();
  if (cart.error && (cart.error as { code?: string }).code !== 'PGRST116') return { ok: false, error: cart.error.message };
  const cartId = (cart.data?.id as string | undefined) ?? null;
  if (!cartId) return { ok: true, cartId: null, items: [] };
  const { data, error } = await sb
    .from('universal_cart_items')
    .select('id, product_id, item_type, quantity, status, unit_price_cents_snapshot, currency_snapshot, metadata')
    .eq('cart_id', cartId)
    .eq('status', 'active');
  if (error) return { ok: false, error: error.message };
  return { ok: true, cartId, items: (data as CartItemRow[]) ?? [] };
}

async function productTitles(sb: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return map;
  const { data } = await sb.from('products').select('id, title').in('id', unique);
  for (const p of (data as Array<{ id: string; title: string }>) ?? []) map.set(p.id, p.title);
  return map;
}

/** Resolve a product referenced by id, guide-pick position/title, or spoken name. */
async function resolveReferencedProduct(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  args: OrbToolArgs,
): Promise<{ ok: true; product: ProductRow | null; rationale: string | null } | { ok: false; error: string }> {
  const existing = await loadGuideState(sb, tenantId, userId);
  const picks = existing?.state.picks ?? [];
  let pick: GuidePick | null = null;
  const refId = String(args.product_id ?? '').trim();
  const idx = Number(args.position ?? args.index);
  const title = String(args.title ?? args.query ?? '').trim().toLowerCase();
  if (refId && UUID_RE.test(refId)) pick = picks.find((p) => p.id === refId) ?? null;
  if (!pick && Number.isFinite(idx) && idx >= 1 && idx <= picks.length) pick = picks[Math.floor(idx) - 1];
  if (!pick && title) pick = picks.find((p) => p.title.toLowerCase().includes(title)) ?? null;
  if (!pick && !refId && !title && existing?.state.selected) pick = existing.state.selected;

  const res = await resolveProduct(sb, pick?.id ?? refId, pick ? '' : String(args.title ?? args.query ?? '').trim());
  if (!res.ok) return res;
  return { ok: true, product: res.product, rationale: pick?.rationale ?? null };
}

function conciseSummary(p: ProductRow): string {
  const firstSentence = (p.description ?? '').split(/(?<=[.!?])\s/)[0]?.slice(0, 180) ?? '';
  const bits = [
    `${speakProduct(p)}`,
    firstSentence ? `Purpose: ${firstSentence}` : '',
    p.dosage || p.serving_size ? `Use: ${[p.dosage, p.serving_size].filter(Boolean).join(', ')}` : '',
    p.availability !== 'in_stock' ? `Availability: ${p.availability}` : '',
    p.safety_notes ? `Limitation: ${p.safety_notes}` : '',
  ].filter(Boolean);
  return bits.join('. ');
}

// ---------------------------------------------------------------------------
// A20.1 discover_marketplace_options
// ---------------------------------------------------------------------------

export async function tool_discover_marketplace_options(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('discover_marketplace_options', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'discover_marketplace_options requires a known tenant context.' };
  const need = String(args.need ?? args.q ?? args.query ?? '').trim();
  if (!need) return { ok: false, error: 'discover_marketplace_options requires the stated need.' };
  const limit = clampInt(args.limit, 1, 6, 4);

  try {
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const budgetMax = args.budget_max_amount != null ? Math.round(Number(args.budget_max_amount) * 100) : prefs.budget_monthly_cents;
    const [productRes, services] = await Promise.all([
      productNeedSearch(sb, need, prefs, { budgetMaxCents: budgetMax ?? null, limit }),
      serviceNeedSearch(sb, tenantId, need, 2),
    ]);
    if (productRes.error) return { ok: false, error: productRes.error };

    const options = [
      ...productRes.items.map((p) => ({ kind: 'product', id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, rating: p.rating })),
      ...services.map((s) => ({ kind: 'service', id: s.id, title: s.name, service_type: s.service_type, provider_name: s.provider_name })),
    ];
    if (options.length === 0) {
      return {
        ok: true,
        result: { options: [] },
        text: `Nothing in the marketplace matches "${need}" right now. Say so honestly and offer to widen the search.`,
      };
    }
    const spokenProducts = productRes.items.map(speakProduct).join('; ');
    const spokenServices = services.map((s) => `"${s.name}" (${s.service_type} service)`).join('; ');
    return {
      ok: true,
      result: { options },
      text:
        `For "${need}" I found${spokenProducts ? ` products: ${spokenProducts}` : ''}${spokenProducts && spokenServices ? ' — and' : ''}${
          spokenServices ? ` services: ${spokenServices}` : ''
        }. Mention at most 3 options, one sentence each.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'discover_marketplace_options failed' };
  }
}

// ---------------------------------------------------------------------------
// A20.2 search_products_by_need
// ---------------------------------------------------------------------------

export async function tool_search_products_by_need(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('search_products_by_need', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'search_products_by_need requires a known tenant context.' };
  const need = String(args.need ?? args.q ?? args.query ?? '').trim();
  if (!need) return { ok: false, error: 'search_products_by_need requires the purpose/need to search for.' };
  const limit = clampInt(args.limit, 1, 8, 5);

  try {
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const budgetMax = args.budget_max_amount != null ? Math.round(Number(args.budget_max_amount) * 100) : prefs.budget_monthly_cents;
    const { items, dropped, error } = await productNeedSearch(sb, need, prefs, { budgetMaxCents: budgetMax ?? null, limit });
    if (error) return { ok: false, error };
    const route = `/discover/marketplace?q=${encodeURIComponent(need)}`;
    if (items.length === 0) {
      return {
        ok: true,
        result: { items: [], dropped },
        text:
          `No products match "${need}"${dropped.length ? ` after filtering ${dropped.length} against saved preferences` : ''}. ` +
          'Offer to widen the search or adjust a preference.',
      };
    }
    return {
      ok: true,
      result: {
        items: items.map((p) => ({ product_id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, rating: p.rating })),
        dropped,
        decision: 'list_only',
        directive: navDirective('DISCOVER.MARKETPLACE', route, 'Marketplace', 'search_products_by_need results'),
      },
      text: `For "${need}": ${items.map(speakProduct).join('; ')}.${dropped.length ? ` (${dropped.length} filtered out by saved preferences.)` : ''}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'search_products_by_need failed' };
  }
}

// ---------------------------------------------------------------------------
// A20.3 search_services_by_need
// ---------------------------------------------------------------------------

export async function tool_search_services_by_need(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('search_services_by_need', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'search_services_by_need requires a known tenant context.' };
  const need = String(args.need ?? args.q ?? args.query ?? '').trim();
  if (!need) return { ok: false, error: 'search_services_by_need requires the desired outcome to search for.' };
  const limit = clampInt(args.limit, 1, 8, 5);

  try {
    const requestedTypes = toList(args.service_types);
    const services = await serviceNeedSearch(sb, tenantId, need, limit, requestedTypes.length ? requestedTypes : undefined);
    const route = '/discover/wellness-services';
    if (services.length === 0) {
      return {
        ok: true,
        result: { items: [] },
        text: `No services match "${need}" right now. Say so honestly — do not invent providers.`,
      };
    }
    return {
      ok: true,
      result: {
        items: services.map((s) => ({ service_id: s.id, name: s.name, service_type: s.service_type, provider_name: s.provider_name })),
        decision: 'list_only',
        directive: navDirective('DISCOVER.WELLNESS_SERVICES', route, 'Wellness Services', 'search_services_by_need results'),
      },
      text: `Services for "${need}": ${services.map((s) => `"${s.name}" (${s.service_type}${s.provider_name ? `, ${s.provider_name}` : ''})`).join('; ')}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'search_services_by_need failed' };
  }
}

// ---------------------------------------------------------------------------
// A20.4 search_marketplace_by_values
// ---------------------------------------------------------------------------

export async function tool_search_marketplace_by_values(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('search_marketplace_by_values', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'search_marketplace_by_values requires a known tenant context.' };
  const need = String(args.need ?? args.q ?? args.query ?? '').trim();
  const dietary = toList(args.dietary_tags ?? args.dietary);
  const certifications = toList(args.certifications);
  if (!dietary.length && !certifications.length) {
    return {
      ok: false,
      error: 'search_marketplace_by_values requires at least one dietary tag (e.g. "vegan") or certification to filter by.',
    };
  }
  const limit = clampInt(args.limit, 1, 8, 5);

  try {
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const { items, error } = await productNeedSearch(sb, need, prefs, { dietary, certifications, limit });
    if (error) return { ok: false, error };
    const label = [...dietary, ...certifications].join(', ');
    if (items.length === 0) {
      return {
        ok: true,
        result: { items: [] },
        text: `No products declare ${label}${need ? ` for "${need}"` : ''}. Only declared product data counts here — offer to search without the filter.`,
      };
    }
    return {
      ok: true,
      result: {
        items: items.map((p) => ({ product_id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, dietary_tags: p.dietary_tags })),
      },
      text: `Matching ${label}: ${items.map(speakProduct).join('; ')}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'search_marketplace_by_values failed' };
  }
}

// ---------------------------------------------------------------------------
// A20.5 search_marketplace_alternatives
// ---------------------------------------------------------------------------

export async function tool_search_marketplace_alternatives(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('search_marketplace_alternatives', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'search_marketplace_alternatives requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) return { ok: false, error: 'Could not resolve which product to find alternatives for — name it.' };
    const base = ref.product;
    const limit = clampInt(args.limit, 1, 6, 3);

    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const avoidBrand = args.different_brand === true && base.brand ? base.brand : null;
    const { items, error } = await productNeedSearch(sb, String(args.reason ?? '').trim() || base.title, prefs, {
      category: base.category,
      excludeId: base.id,
      limit: limit + (avoidBrand ? 3 : 0),
    });
    if (error) return { ok: false, error };
    const alternatives = (avoidBrand ? items.filter((p) => p.brand !== avoidBrand) : items).slice(0, limit);

    if (alternatives.length === 0) {
      return {
        ok: true,
        result: { alternatives: [] },
        text: `No alternatives to "${base.title}" in the same category right now. Say so honestly.`,
      };
    }
    return {
      ok: true,
      result: {
        base: { product_id: base.id, title: base.title },
        alternatives: alternatives.map((p) => ({ product_id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, rating: p.rating })),
      },
      text: `Alternatives to "${base.title}": ${alternatives.map(speakProduct).join('; ')}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'search_marketplace_alternatives failed' };
  }
}

// ---------------------------------------------------------------------------
// A21.1 generate_top_marketplace_picks (propose-only — nothing staged)
// ---------------------------------------------------------------------------

export async function tool_generate_top_marketplace_picks(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('generate_top_marketplace_picks', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'generate_top_marketplace_picks requires a known tenant context.' };
  const prompt = String(args.prompt ?? args.need ?? args.goal ?? '').trim();
  if (!prompt) return { ok: false, error: 'generate_top_marketplace_picks requires what the user is looking for.' };
  const maxItems = clampInt(args.max_items, 1, 3, 3);

  try {
    let picks: GuidePick[] = [];
    let advisory: string[] = [];
    try {
      const collected: AnnotatedPick[] = [];
      const collectOnly: InsertPickFn = async (pick) => {
        collected.push(pick);
        return { ok: true, item_id: `proposal-${collected.length}` };
      };
      const ctx = await getUserHealthContext(id.user_id);
      const monthlySpendCents = await getMonthlySpend(sb, id.user_id, ctx.currency ?? DEFAULT_CURRENCY);
      const res = await runPropose({
        prompt,
        maxItems,
        ctx,
        supabase: sb,
        insertPick: collectOnly,
        runId: randomUUID(),
        monthly_spend_cents: monthlySpendCents,
      });
      if (res.ok) {
        advisory = res.advisory ?? [];
        picks = collected.map((p) => ({
          kind: 'product' as const,
          id: p.product_id,
          title: p.title,
          price_cents: p.unit_price_cents_snapshot,
          currency: p.currency_snapshot,
          rationale: p.rationale,
          safety_flags: p.safety_flags,
        }));
      }
    } catch {
      /* deterministic fallback below */
    }
    if (picks.length === 0) {
      const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
      const { items } = await productNeedSearch(sb, prompt, prefs, { budgetMaxCents: prefs.budget_monthly_cents, limit: maxItems });
      picks = items.map((p) => ({
        kind: 'product' as const,
        id: p.id,
        title: p.title,
        price_cents: p.price_cents,
        currency: p.currency,
        rationale: `matches "${prompt}"${p.rating != null ? `, rated ${p.rating.toFixed(1)}/5` : ''}`,
      }));
    }

    // Persist as the current picks so explain/compare/select can reference them.
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    const state = existing?.state ?? emptyGuideState(prompt);
    if (!state.goal) state.goal = prompt;
    state.picks = picks;
    state.selected = null;
    await saveGuideState(sb, tenantId, id.user_id, state);

    if (picks.length === 0) {
      return {
        ok: true,
        result: { picks: [], advisory },
        text: `I couldn't find suitable options for "${prompt}". Tell the user honestly — never invent products.`,
      };
    }
    return {
      ok: true,
      result: { picks, advisory },
      text:
        `Top picks for "${prompt}" (nothing added to the cart): ${picks
          .map((p, i) => `${i + 1}. "${p.title}" (${fmtPrice(p.price_cents, p.currency)}) — ${p.rationale}`)
          .join('; ')}. Offer to compare, explain, or add one to the basket.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'generate_top_marketplace_picks failed' };
  }
}

// ---------------------------------------------------------------------------
// A21.2 recommend_marketplace_path
// ---------------------------------------------------------------------------

export async function tool_recommend_marketplace_path(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('recommend_marketplace_path', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'recommend_marketplace_path requires a known tenant context.' };

  try {
    let goal = String(args.goal ?? args.need ?? '').trim();
    if (!goal) {
      const existing = await loadGuideState(sb, tenantId, id.user_id);
      goal = existing?.state.goal ?? '';
    }
    if (!goal) return { ok: false, error: 'recommend_marketplace_path requires a goal (or a recorded one).' };

    const { intent } = classifyIntent(goal);
    const wantsUnderstanding = /why|warum|understand|verstehen|cause|ursache|tired|müde|fatigue|energy|energie|sleep|schlaf/i.test(goal);

    let path: string;
    let spoken: string;
    if (intent === 'diagnostic_test' || (wantsUnderstanding && intent === 'product')) {
      path = 'assessment_first';
      spoken =
        `For "${goal}", understanding the situation first is usually more useful than starting with a product — ` +
        'suggest a relevant assessment or lab service (browse_wellness_services), then deciding on products with that information. ' +
        HEALTH_BOUNDARY_NOTE;
    } else if (intent === 'practitioner') {
      path = 'practitioner_first';
      spoken = `For "${goal}", a practitioner is the right starting point — offer browse_doctors_coaches or find_perfect_practitioner.`;
    } else if (intent === 'service') {
      path = 'service_first';
      spoken = `For "${goal}", a service fits better than a product — offer search_services_by_need.`;
    } else if (intent === 'combination') {
      path = 'combination';
      spoken =
        `"${goal}" spans both — suggest starting with the service/assessment part, then products. ${HEALTH_BOUNDARY_NOTE}`;
    } else {
      path = 'product_first';
      spoken = `For "${goal}", a product search is the direct path — offer search_products_by_need or generate_top_marketplace_picks.`;
    }
    return { ok: true, result: { goal, intent, path }, text: spoken };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'recommend_marketplace_path failed' };
  }
}

// ---------------------------------------------------------------------------
// A21.4 recommend_lower_cost_option
// ---------------------------------------------------------------------------

export async function tool_recommend_lower_cost_option(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('recommend_lower_cost_option', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'recommend_lower_cost_option requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) return { ok: false, error: 'Could not resolve which option to find a cheaper alternative for.' };
    const base = ref.product;
    if (base.price_cents == null) {
      return { ok: false, error: `"${base.title}" has no listed price to compare against.` };
    }

    const { data, error } = await sb
      .from('products')
      .select(PRODUCT_COLS)
      .eq('is_active', true)
      .eq('category', base.category ?? '')
      .lt('price_cents', base.price_cents)
      .neq('id', base.id)
      .order('rating', { ascending: false, nullsFirst: false })
      .limit(6);
    if (error) return { ok: false, error: error.message };

    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const { kept } = applyPrefExclusions(((data as unknown as ProductRow[]) ?? []), prefs);
    const cheaper = kept.slice(0, 2);
    if (cheaper.length === 0) {
      return {
        ok: true,
        result: { alternatives: [] },
        text: `There's no cheaper comparable option to "${base.title}" in its category right now — say so honestly.`,
      };
    }
    return {
      ok: true,
      result: {
        base: { product_id: base.id, title: base.title, price_cents: base.price_cents, currency: base.currency },
        alternatives: cheaper.map((p) => ({ product_id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, rating: p.rating })),
      },
      text:
        `Cheaper than "${base.title}" (${fmtPrice(base.price_cents, base.currency)}): ${cheaper
          .map((p) => `${speakProduct(p)} — saves ${fmtPrice(base.price_cents! - (p.price_cents ?? 0), base.currency)}`)
          .join('; ')}. Mention any relevant trade-off (rating, size) briefly.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'recommend_lower_cost_option failed' };
  }
}

// ---------------------------------------------------------------------------
// A22.1 explain_why_recommended
// ---------------------------------------------------------------------------

export async function tool_explain_why_recommended(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('explain_why_recommended', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'explain_why_recommended requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) return { ok: false, error: 'Could not resolve which recommendation to explain — name it.' };
    if (!ref.rationale) {
      // Not one of the recorded picks — check the cart's recorded agent rationale.
      const cart = await loadActiveCartItems(sb, id.user_id);
      const item = cart.ok ? cart.items.find((i) => i.product_id === ref.product!.id) : undefined;
      const rationale = (item?.metadata as { rationale?: string } | null)?.rationale;
      if (!rationale) {
        return {
          ok: true,
          result: { has_recorded_rationale: false, title: ref.product.title },
          text:
            `"${ref.product.title}" wasn't recommended by me in this conversation, so there is no recorded reason. ` +
            'Say so honestly — do not invent a rationale.',
        };
      }
      return {
        ok: true,
        result: { title: ref.product.title, rationale },
        text: `"${ref.product.title}" was proposed because: ${rationale}. Cite this stated reason, in plain language.`,
      };
    }
    return {
      ok: true,
      result: { title: ref.product.title, rationale: ref.rationale },
      text:
        `"${ref.product.title}" was recommended because: ${ref.rationale}. ` +
        'Explain it citing the user\'s stated goal and preferences — never an opaque match score.',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'explain_why_recommended failed' };
  }
}

// ---------------------------------------------------------------------------
// A22.2 summarize_product_for_user + A22.3 get_key_product_facts
// ---------------------------------------------------------------------------

export async function tool_summarize_product_for_user(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('summarize_product_for_user', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'summarize_product_for_user requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) return { ok: false, error: 'Could not resolve which product to summarize — name it.' };
    const p = ref.product;

    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const fitNotes: string[] = [];
    if (prefs.dietary.length && p.dietary_tags?.length) {
      const tags = new Set(p.dietary_tags.map((t) => t.toLowerCase()));
      const matched = prefs.dietary.filter((d) => tags.has(d.toLowerCase()));
      if (matched.length) fitNotes.push(`matches your ${matched.join(', ')} preference`);
    }
    if (ref.rationale) fitNotes.push(ref.rationale);

    return {
      ok: true,
      result: { product_id: p.id, title: p.title, summary: conciseSummary(p), fit_notes: fitNotes },
      text:
        `${conciseSummary(p)}${fitNotes.length ? ` Why it may fit: ${fitNotes.join('; ')}.` : ''} ` +
        'Keep it to 2–3 spoken sentences — what it is, what for, why it fits, one limitation.',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'summarize_product_for_user failed' };
  }
}

export async function tool_get_key_product_facts(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_key_product_facts', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'get_key_product_facts requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) return { ok: false, error: 'Could not resolve which product — name it.' };
    const p = ref.product;
    const facts: Record<string, unknown> = {
      title: p.title,
      brand: p.brand,
      price: fmtPrice(p.price_cents, p.currency),
      category: p.category,
      availability: p.availability,
      rating: p.rating,
      dosage: p.dosage,
      serving_size: p.serving_size,
      servings_per_container: p.servings_per_container,
      dietary_tags: p.dietary_tags,
      contains_allergens: p.contains_allergens,
      safety_notes: p.safety_notes,
    };
    const spoken = [
      speakProduct(p),
      p.dosage ? `dosage ${p.dosage}` : '',
      p.servings_per_container != null ? `${p.servings_per_container} servings` : '',
      p.contains_allergens?.length ? `contains: ${p.contains_allergens.join(', ')}` : '',
      p.safety_notes ? `note: ${p.safety_notes}` : '',
      p.availability !== 'in_stock' ? `availability: ${p.availability}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    return { ok: true, result: { facts }, text: `Key facts — ${spoken}. Read only what the user asked about.` };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_key_product_facts failed' };
  }
}

// ---------------------------------------------------------------------------
// A23.1 compare_marketplace_options
// ---------------------------------------------------------------------------

export async function tool_compare_marketplace_options(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('compare_marketplace_options', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'compare_marketplace_options requires a known tenant context.' };

  try {
    // Resolve up to 3 products: explicit ids/titles, else the current picks.
    const products: ProductRow[] = [];
    const explicitIds = toList(args.product_ids).filter((v) => UUID_RE.test(v));
    const explicitTitles = toList(args.titles);
    for (const pid of explicitIds.slice(0, 3)) {
      const res = await resolveProduct(sb, pid, '');
      if (res.ok && res.product) products.push(res.product);
    }
    for (const t of explicitTitles.slice(0, 3 - products.length)) {
      const res = await resolveProduct(sb, '', t);
      if (res.ok && res.product && !products.some((p) => p.id === res.product!.id)) products.push(res.product);
    }
    let rationaleById = new Map<string, string>();
    if (products.length < 2) {
      const existing = await loadGuideState(sb, tenantId, id.user_id);
      const pickProducts = (existing?.state.picks ?? []).filter((p) => p.kind === 'product').slice(0, 3);
      rationaleById = new Map(pickProducts.map((p) => [p.id, p.rationale]));
      for (const pick of pickProducts) {
        if (products.some((p) => p.id === pick.id)) continue;
        const res = await resolveProduct(sb, pick.id, '');
        if (res.ok && res.product) products.push(res.product);
      }
    }
    if (products.length < 2) {
      return { ok: false, error: 'compare_marketplace_options needs at least two options (current picks or named products).' };
    }
    const compared = products.slice(0, 3);

    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const rows = compared.map((p) => ({
      product_id: p.id,
      title: p.title,
      price_cents: p.price_cents,
      currency: p.currency,
      rating: p.rating,
      availability: p.availability,
      dietary_tags: p.dietary_tags,
      safety_notes: p.safety_notes,
      rationale: rationaleById.get(p.id) ?? null,
    }));

    // Meaningful differences only: price spread, rating spread, availability,
    // dietary fit against saved preferences.
    const diffs: string[] = [];
    const priced = compared.filter((p) => p.price_cents != null);
    if (priced.length >= 2) {
      const cheapest = priced.reduce((a, b) => (a.price_cents! <= b.price_cents! ? a : b));
      const priciest = priced.reduce((a, b) => (a.price_cents! >= b.price_cents! ? a : b));
      if (cheapest.id !== priciest.id) {
        diffs.push(
          `"${cheapest.title}" is ${fmtPrice(priciest.price_cents! - cheapest.price_cents!, cheapest.currency)} cheaper than "${priciest.title}"`,
        );
      }
    }
    const rated = compared.filter((p) => p.rating != null);
    if (rated.length >= 2) {
      const best = rated.reduce((a, b) => (a.rating! >= b.rating! ? a : b));
      const worst = rated.reduce((a, b) => (a.rating! <= b.rating! ? a : b));
      if (best.id !== worst.id && best.rating! - worst.rating! >= 0.3) {
        diffs.push(`"${best.title}" is rated higher (${best.rating!.toFixed(1)} vs ${worst.rating!.toFixed(1)})`);
      }
    }
    const outOfStock = compared.filter((p) => p.availability !== 'in_stock');
    for (const p of outOfStock) diffs.push(`"${p.title}" is ${p.availability}`);
    if (prefs.dietary.length) {
      for (const p of compared) {
        const tags = new Set((p.dietary_tags ?? []).map((t) => t.toLowerCase()));
        const matched = prefs.dietary.filter((d) => tags.has(d.toLowerCase()));
        if (matched.length) diffs.push(`"${p.title}" matches your ${matched.join(', ')} preference`);
      }
    }

    return {
      ok: true,
      result: { options: rows, differences: diffs },
      text:
        `Comparing ${compared.map((p) => `"${p.title}" (${fmtPrice(p.price_cents, p.currency)})`).join(' vs ')}. ` +
        `${diffs.length ? `What actually differs: ${diffs.join('; ')}.` : 'They are very similar on price, rating and availability.'} ` +
        'Speak only the differences that matter to this user, then ask which direction they lean.',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'compare_marketplace_options failed' };
  }
}

// ---------------------------------------------------------------------------
// A23.5–7 shortlist (shop_saved_products)
// ---------------------------------------------------------------------------

export async function tool_shortlist_marketplace_options(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('shortlist_marketplace_options', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'shortlist_marketplace_options requires a known tenant context.' };

  try {
    const targets: ProductRow[] = [];
    if (args.all_picks === true) {
      const existing = await loadGuideState(sb, tenantId, id.user_id);
      for (const pick of (existing?.state.picks ?? []).filter((p) => p.kind === 'product')) {
        const res = await resolveProduct(sb, pick.id, '');
        if (res.ok && res.product) targets.push(res.product);
      }
    } else {
      const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
      if (!ref.ok) return { ok: false, error: ref.error };
      if (ref.product) targets.push(ref.product);
    }
    if (targets.length === 0) {
      return { ok: false, error: 'Could not resolve which product(s) to shortlist — name one or pass all_picks:true.' };
    }

    const savedTitles: string[] = [];
    for (const p of targets) {
      const { data: existingRow } = await sb
        .from('shop_saved_products')
        .select('id')
        .eq('user_id', id.user_id)
        .eq('product_id', p.id)
        .maybeSingle();
      if (!existingRow) {
        const { error } = await sb.from('shop_saved_products').insert({ user_id: id.user_id, product_id: p.id });
        if (error) return { ok: false, error: error.message };
      }
      savedTitles.push(p.title);
    }
    return {
      ok: true,
      result: { shortlisted: savedTitles },
      text: `Shortlisted: ${savedTitles.map((t) => `"${t}"`).join(', ')}. The user can hear it anytime with "show my shortlist".`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'shortlist_marketplace_options failed' };
  }
}

export async function tool_view_marketplace_shortlist(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('view_marketplace_shortlist', id);
  if (gate) return gate;
  const limit = clampInt(args.limit, 1, 20, 10);

  try {
    const { data, error } = await sb
      .from('shop_saved_products')
      .select('product_id, created_at')
      .eq('user_id', id.user_id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return { ok: false, error: error.message };
    const rows = (data as Array<{ product_id: string }>) ?? [];
    if (rows.length === 0) {
      return { ok: true, result: { items: [] }, text: 'The shortlist is empty.' };
    }
    const ids = rows.map((r) => r.product_id);
    const { data: products, error: pErr } = await sb.from('products').select(PRODUCT_COLS).in('id', ids);
    if (pErr) return { ok: false, error: pErr.message };
    const byId = new Map(((products as unknown as ProductRow[]) ?? []).map((p) => [p.id, p]));
    const items = ids
      .map((pid) => byId.get(pid))
      .filter((p): p is ProductRow => !!p);
    return {
      ok: true,
      result: {
        items: items.map((p) => ({ product_id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, availability: p.availability })),
      },
      text: `Shortlist (${items.length}): ${items.map(speakProduct).join('; ')}. Offer to compare them or add one to the basket.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'view_marketplace_shortlist failed' };
  }
}

export async function tool_remove_from_marketplace_shortlist(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('remove_from_marketplace_shortlist', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'remove_from_marketplace_shortlist requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) return { ok: false, error: 'Could not resolve which shortlist item to remove — name it.' };
    const { data, error } = await sb
      .from('shop_saved_products')
      .delete()
      .eq('user_id', id.user_id)
      .eq('product_id', ref.product.id)
      .select('id');
    if (error) return { ok: false, error: error.message };
    const removed = ((data as Array<{ id: string }>) ?? []).length > 0;
    return {
      ok: true,
      result: { removed, title: ref.product.title },
      text: removed ? `Removed "${ref.product.title}" from the shortlist.` : `"${ref.product.title}" wasn't on the shortlist.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'remove_from_marketplace_shortlist failed' };
  }
}

// ---------------------------------------------------------------------------
// A27.1 check_product_suitability
// ---------------------------------------------------------------------------

export async function tool_check_product_suitability(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('check_product_suitability', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'check_product_suitability requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) return { ok: false, error: 'Could not resolve which product to check — name it.' };
    const p = ref.product;
    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);

    const conflicts: string[] = [];
    const matches: string[] = [];
    const unchecked: string[] = [];

    if (p.brand && prefs.excluded_brands.some((b) => b.toLowerCase() === p.brand!.toLowerCase())) {
      conflicts.push(`brand ${p.brand} is on your excluded list`);
    }
    const cat = (p.category ?? '').toLowerCase();
    if (cat && prefs.excluded_categories.some((c) => c.toLowerCase() === cat)) {
      conflicts.push(`category ${p.category} is on your excluded list`);
    }
    const haystack = `${p.title} ${p.category ?? ''} ${p.subcategory ?? ''}`.toLowerCase();
    for (const term of prefs.exclusions) {
      if (term && haystack.includes(term.toLowerCase())) conflicts.push(`matches your exclusion "${term}"`);
    }
    if (prefs.dietary.length) {
      if (p.dietary_tags?.length) {
        const tags = new Set(p.dietary_tags.map((t) => t.toLowerCase()));
        for (const d of prefs.dietary) {
          if (tags.has(d.toLowerCase())) matches.push(`declared ${d}`);
          else unchecked.push(`${d} (not declared by the product)`);
        }
      } else {
        unchecked.push(`dietary needs (${prefs.dietary.join(', ')}) — product declares no dietary tags`);
      }
    }
    if (p.contains_allergens?.length) {
      matches.push(`declared allergens: ${p.contains_allergens.join(', ')} — mention them`);
    }
    if (prefs.budget_monthly_cents != null && p.price_cents != null && p.price_cents > prefs.budget_monthly_cents) {
      conflicts.push(`price ${fmtPrice(p.price_cents, p.currency)} exceeds your ${fmtPrice(prefs.budget_monthly_cents, null)} budget`);
    }

    const verdict = conflicts.length ? 'conflicts_found' : 'no_conflicts_in_declared_data';
    return {
      ok: true,
      result: { product_id: p.id, title: p.title, verdict, conflicts, matches, unchecked },
      text:
        `Suitability of "${p.title}": ${conflicts.length ? `conflicts — ${conflicts.join('; ')}.` : 'no conflicts with your saved preferences in the declared product data.'}` +
        `${matches.length ? ` Positive: ${matches.join('; ')}.` : ''}` +
        `${unchecked.length ? ` Could NOT verify: ${unchecked.join('; ')} — say so instead of guessing.` : ''} ` +
        HEALTH_BOUNDARY_NOTE,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'check_product_suitability failed' };
  }
}

// ---------------------------------------------------------------------------
// A27.3 check_cart_duplication
// ---------------------------------------------------------------------------

export async function tool_check_cart_duplication(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('check_cart_duplication', id);
  if (gate) return gate;
  try {
    const cart = await loadActiveCartItems(sb, id.user_id);
    if (!cart.ok) return { ok: false, error: cart.error };
    if (cart.items.length === 0) return { ok: true, result: { duplicates: [] }, text: 'The basket is empty — nothing to check.' };

    const byProduct = new Map<string, CartItemRow[]>();
    for (const item of cart.items) {
      if (!item.product_id) continue;
      const list = byProduct.get(item.product_id) ?? [];
      list.push(item);
      byProduct.set(item.product_id, list);
    }
    const dupIds = Array.from(byProduct.entries()).filter(([, list]) => list.length > 1 || list.some((i) => i.quantity > 1));
    if (dupIds.length === 0) {
      return { ok: true, result: { duplicates: [] }, text: 'No duplicates in the basket.' };
    }
    const titles = await productTitles(sb, dupIds.map(([pid]) => pid));
    const duplicates = dupIds.map(([pid, list]) => ({
      product_id: pid,
      title: titles.get(pid) ?? 'an item',
      total_quantity: list.reduce((sum, i) => sum + (i.quantity || 1), 0),
      line_count: list.length,
    }));
    return {
      ok: true,
      result: { duplicates },
      text:
        `Possible duplicates: ${duplicates.map((d) => `"${d.title}" appears ${d.line_count > 1 ? `${d.line_count} times` : `with quantity ${d.total_quantity}`}`).join('; ')}. ` +
        'Ask whether to keep both or remove one (update_cart_item / remove_from_cart).',
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'check_cart_duplication failed' };
  }
}

// ---------------------------------------------------------------------------
// A28.3 review_shopping_budget
// ---------------------------------------------------------------------------

export async function tool_review_shopping_budget(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('review_shopping_budget', id);
  if (gate) return gate;
  try {
    let capCents: number | null = null;
    try {
      const { data } = await sb
        .from('user_limitations')
        .select('budget_monthly_cap_cents')
        .eq('user_id', id.user_id)
        .maybeSingle();
      capCents = (data as { budget_monthly_cap_cents?: number | null } | null)?.budget_monthly_cap_cents ?? null;
    } catch {
      /* no limitations row → no cap */
    }
    const spentCents = await getMonthlySpend(sb, id.user_id, DEFAULT_CURRENCY);

    const cart = await loadActiveCartItems(sb, id.user_id);
    const cartTotalCents = cart.ok
      ? cart.items.reduce((sum, i) => sum + (i.unit_price_cents_snapshot ?? 0) * (i.quantity || 1), 0)
      : 0;

    if (capCents == null) {
      return {
        ok: true,
        result: { budget_monthly_cap_cents: null, monthly_spend_cents: spentCents, cart_total_cents: cartTotalCents },
        text:
          `No monthly shopping budget is set. This month's spend: ${fmtPrice(spentCents, null)}; current basket: ${fmtPrice(cartTotalCents, null)}. ` +
          'Offer to set a budget with set_shopping_budget.',
      };
    }
    const remaining = capCents - spentCents;
    const wouldExceed = cartTotalCents > remaining;
    return {
      ok: true,
      result: {
        budget_monthly_cap_cents: capCents,
        monthly_spend_cents: spentCents,
        remaining_cents: remaining,
        cart_total_cents: cartTotalCents,
        cart_would_exceed_budget: wouldExceed,
      },
      text:
        `Budget: ${fmtPrice(capCents, null)}/month, spent ${fmtPrice(spentCents, null)}, remaining ${fmtPrice(Math.max(remaining, 0), null)}. ` +
        `Basket total: ${fmtPrice(cartTotalCents, null)}${wouldExceed ? ' — WARN the user this would exceed the remaining budget and offer cheaper alternatives (recommend_lower_cost_option).' : '.'}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'review_shopping_budget failed' };
  }
}

// ---------------------------------------------------------------------------
// A29.1 confirm_marketplace_selection + A29.2 add_selected_option_to_cart
// ---------------------------------------------------------------------------

export async function tool_confirm_marketplace_selection(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('confirm_marketplace_selection', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'confirm_marketplace_selection requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) return { ok: false, error: 'Could not resolve which option to confirm — name it.' };
    const p = ref.product;

    // Record the selection so add_selected_option_to_cart can act on "yes".
    const existing = await loadGuideState(sb, tenantId, id.user_id);
    const state = existing?.state ?? emptyGuideState('');
    state.selected = {
      kind: 'product',
      id: p.id,
      title: p.title,
      price_cents: p.price_cents,
      currency: p.currency,
      rationale: ref.rationale ?? 'user selection',
    };
    await saveGuideState(sb, tenantId, id.user_id, state);

    return {
      ok: true,
      result: {
        selection: { product_id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency, availability: p.availability },
      },
      text:
        `Read back to the user: "${p.title}"${p.brand ? ` by ${p.brand}` : ''}, ${fmtPrice(p.price_cents, p.currency)}${
          p.availability !== 'in_stock' ? `, availability ${p.availability}` : ''
        }. Ask: "Shall I add it to your basket?" — on yes, call add_selected_option_to_cart with confirm:true. Payment stays on screen.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'confirm_marketplace_selection failed' };
  }
}

export async function tool_add_selected_option_to_cart(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('add_selected_option_to_cart', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'add_selected_option_to_cart requires a known tenant context.' };

  try {
    const ref = await resolveReferencedProduct(sb, tenantId, id.user_id, args);
    if (!ref.ok) return { ok: false, error: ref.error };
    if (!ref.product) {
      return { ok: false, error: 'No confirmed selection found — call confirm_marketplace_selection first (or name the product).' };
    }
    const p = ref.product;

    if (args.confirm !== true) {
      return {
        ok: true,
        result: { needs_confirmation: true, product_id: p.id, title: p.title, price_cents: p.price_cents, currency: p.currency },
        text:
          `Confirm with the user: add "${p.title}" (${fmtPrice(p.price_cents, p.currency)}) to the basket? ` +
          'On yes, call add_selected_option_to_cart again with confirm:true.',
      };
    }

    const staged = await stageProductInCart(sb, id, p, 'voice_confirmed_selection', ref.rationale ?? 'user selection');
    if (!staged.ok) return { ok: false, error: staged.error };
    const route = '/cart';
    return {
      ok: true,
      result: {
        added: true,
        item_id: staged.itemId,
        product_id: p.id,
        title: p.title,
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.CART', route, 'Shopping Cart', 'add_selected_option_to_cart added'),
        redirect: { route },
      },
      text: `Done — "${p.title}" is in the basket. Review and confirm payment on the screen; nothing has been charged.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'add_selected_option_to_cart failed' };
  }
}

// ---------------------------------------------------------------------------
// A29.4 review_cart_suitability + A29.5 explain_cart_item
// ---------------------------------------------------------------------------

export async function tool_review_cart_suitability(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('review_cart_suitability', id);
  if (gate) return gate;
  const tenantId = await resolveTenantId(id, sb);
  if (!tenantId) return { ok: false, error: 'review_cart_suitability requires a known tenant context.' };

  try {
    const cart = await loadActiveCartItems(sb, id.user_id);
    if (!cart.ok) return { ok: false, error: cart.error };
    if (cart.items.length === 0) return { ok: true, result: { findings: [] }, text: 'The basket is empty — nothing to review.' };

    const prefs = await loadMarketplacePrefs(sb, tenantId, id.user_id);
    const ids = cart.items.map((i) => i.product_id).filter((v): v is string => !!v);
    const { data } = await sb.from('products').select(PRODUCT_COLS).in('id', Array.from(new Set(ids)));
    const products = new Map(((data as unknown as ProductRow[]) ?? []).map((p) => [p.id, p]));

    const findings: string[] = [];
    // Duplicates
    const seen = new Map<string, number>();
    for (const item of cart.items) {
      if (!item.product_id) continue;
      seen.set(item.product_id, (seen.get(item.product_id) ?? 0) + 1);
    }
    for (const [pid, count] of seen.entries()) {
      if (count > 1) findings.push(`"${products.get(pid)?.title ?? 'an item'}" appears ${count} times`);
    }
    // Preference conflicts + availability
    for (const item of cart.items) {
      const p = item.product_id ? products.get(item.product_id) : undefined;
      if (!p) continue;
      const { dropped } = applyPrefExclusions([p], prefs);
      if (dropped.length) findings.push(`"${p.title}": ${dropped[0].reason}`);
      if (p.availability !== 'in_stock') findings.push(`"${p.title}" is ${p.availability}`);
      if (p.contains_allergens?.length && prefs.dietary.length) {
        findings.push(`"${p.title}" declares allergens (${p.contains_allergens.join(', ')}) — worth mentioning`);
      }
    }

    return {
      ok: true,
      result: { findings, item_count: cart.items.length },
      text: findings.length
        ? `Before checkout: ${findings.join('; ')}. Ask whether to adjust anything.`
        : `The basket (${cart.items.length} item${cart.items.length === 1 ? '' : 's'}) has no duplicates or conflicts with saved preferences.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'review_cart_suitability failed' };
  }
}

export async function tool_explain_cart_item(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('explain_cart_item', id);
  if (gate) return gate;
  try {
    const cart = await loadActiveCartItems(sb, id.user_id);
    if (!cart.ok) return { ok: false, error: cart.error };
    if (cart.items.length === 0) return { ok: true, result: { found: false }, text: 'The basket is empty.' };

    const titles = await productTitles(sb, cart.items.map((i) => i.product_id).filter((v): v is string => !!v));
    const wanted = String(args.title ?? args.query ?? '').trim().toLowerCase();
    const item =
      cart.items.find((i) => i.product_id && UUID_RE.test(String(args.product_id ?? '')) && i.product_id === args.product_id) ??
      (wanted ? cart.items.find((i) => (titles.get(i.product_id ?? '') ?? '').toLowerCase().includes(wanted)) : undefined) ??
      (cart.items.length === 1 ? cart.items[0] : undefined);
    if (!item) {
      return {
        ok: true,
        result: { found: false, items: cart.items.map((i) => titles.get(i.product_id ?? '') ?? 'an item') },
        text: `Which item? The basket has: ${cart.items.map((i) => `"${titles.get(i.product_id ?? '') ?? 'an item'}"`).join(', ')}.`,
      };
    }
    const meta = (item.metadata ?? {}) as { origin?: string; rationale?: string };
    const title = titles.get(item.product_id ?? '') ?? 'This item';
    const originSpoken =
      meta.origin === 'agent'
        ? 'proposed by the shopping agent'
        : meta.origin === 'reorder'
          ? 'a reorder of a previous purchase'
          : meta.origin === 'discover_assistant' || meta.origin === 'voice_confirmed_selection'
            ? 'added by you via the voice assistant after confirmation'
            : 'added by you';
    return {
      ok: true,
      result: { title, origin: meta.origin ?? 'user', rationale: meta.rationale ?? null, quantity: item.quantity },
      text: `"${title}" (quantity ${item.quantity}) was ${originSpoken}${meta.rationale ? ` — reason recorded: ${meta.rationale}` : ''}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'explain_cart_item failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const MARKETPLACE_JOURNEY_TOOL_HANDLERS: Record<string, Handler> = {
  discover_marketplace_options: tool_discover_marketplace_options,
  search_products_by_need: tool_search_products_by_need,
  search_services_by_need: tool_search_services_by_need,
  search_marketplace_by_values: tool_search_marketplace_by_values,
  search_marketplace_alternatives: tool_search_marketplace_alternatives,
  generate_top_marketplace_picks: tool_generate_top_marketplace_picks,
  recommend_marketplace_path: tool_recommend_marketplace_path,
  recommend_lower_cost_option: tool_recommend_lower_cost_option,
  explain_why_recommended: tool_explain_why_recommended,
  summarize_product_for_user: tool_summarize_product_for_user,
  get_key_product_facts: tool_get_key_product_facts,
  compare_marketplace_options: tool_compare_marketplace_options,
  shortlist_marketplace_options: tool_shortlist_marketplace_options,
  view_marketplace_shortlist: tool_view_marketplace_shortlist,
  remove_from_marketplace_shortlist: tool_remove_from_marketplace_shortlist,
  check_product_suitability: tool_check_product_suitability,
  check_cart_duplication: tool_check_cart_duplication,
  review_shopping_budget: tool_review_shopping_budget,
  confirm_marketplace_selection: tool_confirm_marketplace_selection,
  add_selected_option_to_cart: tool_add_selected_option_to_cart,
  review_cart_suitability: tool_review_cart_suitability,
  explain_cart_item: tool_explain_cart_item,
};

export const MARKETPLACE_JOURNEY_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'discover_marketplace_options',
    description: [
      'Unified marketplace search across products AND services for one stated',
      'need. CALL WHEN the user describes a need without saying whether they',
      'want a product or a service: "something for my back pain", "etwas für',
      'besseren Schlaf". Mention at most 3 options, one sentence each.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'The stated need or desired outcome.' },
        budget_max_amount: { type: 'number', description: 'Budget ceiling in whole currency units.' },
        limit: { type: 'number', description: 'Max options (default 4, max 6).' },
      },
      required: ['need'],
    },
  },
  {
    name: 'search_products_by_need',
    description: [
      'Search products by PURPOSE rather than product name, filtered against',
      'saved preferences (exclusions, budget). CALL WHEN the user describes',
      'what they want to achieve: "something that helps me focus", "etwas',
      'gegen Müdigkeit".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'The purpose/need to search for.' },
        budget_max_amount: { type: 'number', description: 'Budget ceiling in whole currency units.' },
        limit: { type: 'number', description: 'Max results (default 5, max 8).' },
      },
      required: ['need'],
    },
  },
  {
    name: 'search_services_by_need',
    description: [
      'Search marketplace services (wellness, nutrition, therapy, labs) by the',
      'desired outcome. CALL WHEN the user wants help through a service rather',
      'than a product: "a sleep consultation", "eine Ernährungsberatung".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'The desired outcome.' },
        service_types: { type: 'string', description: 'Optional comma-separated types: coach, doctor, lab, wellness, nutrition, fitness, therapy.' },
        limit: { type: 'number', description: 'Max results (default 5, max 8).' },
      },
      required: ['need'],
    },
  },
  {
    name: 'search_marketplace_by_values',
    description: [
      'Filter products by declared dietary tags and certifications (vegan,',
      'gluten-free, organic, …). CALL WHEN values/dietary constraints are the',
      'point of the request: "only vegan options", "nur vegane Produkte".',
      'Only DECLARED product data counts — say so if nothing declares the tag.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        dietary_tags: { type: 'string', description: 'Comma-separated dietary tags (e.g. "vegan, gluten-free").' },
        certifications: { type: 'string', description: 'Comma-separated certifications (e.g. "organic").' },
        need: { type: 'string', description: 'Optional need to combine with the filter.' },
        limit: { type: 'number', description: 'Max results (default 5, max 8).' },
      },
      required: [],
    },
  },
  {
    name: 'search_marketplace_alternatives',
    description: [
      'Find alternatives to a product the user dislikes or cannot use, in the',
      'same category. CALL WHEN the user says "what else is there like this",',
      '"not this brand", "gibt es Alternativen dazu?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'UUID of the product to replace, when known.' },
        title: { type: 'string', description: 'Spoken name of the product to replace.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
        reason: { type: 'string', description: 'Why the user wants an alternative (improves the search).' },
        different_brand: { type: 'boolean', description: 'True if the user wants a different brand.' },
        limit: { type: 'number', description: 'Max alternatives (default 3, max 6).' },
      },
      required: [],
    },
  },
  {
    name: 'generate_top_marketplace_picks',
    description: [
      'Return up to 3 best-fit product picks with short rationales — WITHOUT',
      'adding anything to the cart (unlike get_ai_product_picks, which stages',
      'the cart). CALL WHEN the user wants recommendations to hear first:',
      '"what would you recommend for ...", "was würdest du mir empfehlen?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the user is looking for.' },
        max_items: { type: 'number', description: 'Max picks (default 3).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'recommend_marketplace_path',
    description: [
      'Recommend whether to start with a product, a service/assessment, a',
      'practitioner, or a combination for the stated goal. CALL WHEN the user',
      'is unsure what kind of help they need: "I don\'t know whether I need',
      'supplements or a blood test", "ich weiß nicht, was ich brauche".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { goal: { type: 'string', description: 'The goal (defaults to the recorded one).' } },
      required: [],
    },
  },
  {
    name: 'recommend_lower_cost_option',
    description: [
      'Find a suitable cheaper alternative to a current pick or named product.',
      'CALL WHEN the user says "too expensive", "something cheaper", "zu teuer,',
      'gibt es was Günstigeres?". Mention the saving and any trade-off.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'UUID of the too-expensive product, when known.' },
        title: { type: 'string', description: 'Spoken name of the product.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
      },
      required: [],
    },
  },
  {
    name: 'explain_why_recommended',
    description: [
      'Explain why an option was recommended, from the RECORDED rationale.',
      'CALL WHEN the user asks "why are you recommending this?", "warum',
      'empfiehlst du mir das?". Cite stated preferences and the recorded',
      'reason in plain language — never an algorithm score. If there is no',
      'recorded reason, say so honestly.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'UUID of the recommended product, when known.' },
        title: { type: 'string', description: 'Spoken name.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
      },
      required: [],
    },
  },
  {
    name: 'summarize_product_for_user',
    description: [
      'Personalized SHORT product summary: what it is, what it is for, why it',
      'may fit this user, one relevant limitation. CALL instead of reading a',
      'product description aloud. 2–3 spoken sentences maximum.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID, when known.' },
        title: { type: 'string', description: 'Spoken product name.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
      },
      required: [],
    },
  },
  {
    name: 'get_key_product_facts',
    description: [
      'Only the most important product facts: price, dosage/serving, declared',
      'allergens, safety notes, availability. CALL WHEN the user asks a',
      'factual detail: "how many servings?", "what\'s the dosage?", "welche',
      'Allergene enthält es?". Read only what was asked.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID, when known.' },
        title: { type: 'string', description: 'Spoken product name.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
      },
      required: [],
    },
  },
  {
    name: 'compare_marketplace_options',
    description: [
      'Compare up to 3 options on price, rating, availability, dietary fit —',
      'speaking only the differences that matter to this user. CALL WHEN the',
      'user asks to compare: "compare the first two", "was ist der',
      'Unterschied?". Defaults to the current picks.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_ids: { type: 'string', description: 'Comma-separated product UUIDs, when known.' },
        titles: { type: 'string', description: 'Comma-separated spoken product names.' },
      },
      required: [],
    },
  },
  {
    name: 'shortlist_marketplace_options',
    description: [
      'Save one product (or all current picks) to the user\'s shortlist for',
      'later. CALL WHEN the user says "save that one", "put it on my list",',
      '"merk dir das". Products only — services cannot be shortlisted yet.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID, when known.' },
        title: { type: 'string', description: 'Spoken product name.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
        all_picks: { type: 'boolean', description: 'True to shortlist all current picks.' },
      },
      required: [],
    },
  },
  {
    name: 'view_marketplace_shortlist',
    description: [
      'Read the user\'s saved shortlist. CALL WHEN the user asks "what\'s on my',
      'shortlist?", "zeig mir meine Merkliste".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max items (default 10, max 20).' } },
      required: [],
    },
  },
  {
    name: 'remove_from_marketplace_shortlist',
    description: [
      'Remove one product from the shortlist. CALL WHEN the user says "remove',
      '... from my list", "nimm das von meiner Merkliste".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID, when known.' },
        title: { type: 'string', description: 'Spoken product name.' },
      },
      required: [],
    },
  },
  {
    name: 'check_product_suitability',
    description: [
      'Check one product against the user\'s saved preferences (dietary,',
      'exclusions, brands, budget) using only DECLARED product data. CALL WHEN',
      'the user asks "is this suitable for me?", "ist das für mich geeignet?".',
      'Report what could NOT be verified instead of guessing. Never a medical',
      'judgement.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID, when known.' },
        title: { type: 'string', description: 'Spoken product name.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
      },
      required: [],
    },
  },
  {
    name: 'check_cart_duplication',
    description: [
      'Detect repeated or overlapping products in the basket. CALL before',
      'checkout or WHEN the user asks "is anything doubled in my basket?",',
      '"habe ich etwas doppelt im Warenkorb?".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'review_shopping_budget',
    description: [
      'Read the monthly shopping budget, spend so far, remaining headroom, and',
      'whether the current basket would exceed it. CALL WHEN the user asks',
      'about their budget or before an expensive addition: "how is my shopping',
      'budget?", "wie steht mein Einkaufsbudget?".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'confirm_marketplace_selection',
    description: [
      'Read back the exact selected option (name, price, availability) and ask',
      'for explicit confirmation BEFORE any cart action. CALL WHEN the user',
      'picks an option in conversation. On the user\'s yes, follow with',
      'add_selected_option_to_cart confirm:true. Never skip this read-back.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID, when known.' },
        title: { type: 'string', description: 'Spoken product name.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
      },
      required: [],
    },
  },
  {
    name: 'add_selected_option_to_cart',
    description: [
      'Stage the confirmed selection into the universal basket. NEVER charges —',
      'payment is a screen handoff. ALWAYS run the confirm_marketplace_selection',
      'read-back (or call once without confirm) first; pass confirm:true only',
      'after the user said yes. CALL WHEN the user confirms adding the chosen',
      'item: "yes, add it", "ja, in den Warenkorb".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID, when known.' },
        title: { type: 'string', description: 'Spoken product name.' },
        position: { type: 'number', description: '1-based position among the current picks.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed the read-back.' },
      },
      required: [],
    },
  },
  {
    name: 'review_cart_suitability',
    description: [
      'Check the whole basket for duplicates, conflicts with saved preferences,',
      'declared allergens and availability problems before checkout. CALL WHEN',
      'the user says "check my basket", "is everything in my cart okay?",',
      '"prüf meinen Warenkorb".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'explain_cart_item',
    description: [
      'Explain why a specific basket item is there (added by the user, the',
      'shopping agent, a reorder — with the recorded rationale). CALL WHEN the',
      'user asks "why is this in my basket?", "warum ist das in meinem',
      'Warenkorb?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID, when known.' },
        title: { type: 'string', description: 'Spoken product name.' },
      },
      required: [],
    },
  },
];

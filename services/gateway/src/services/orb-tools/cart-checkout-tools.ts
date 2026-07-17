/**
 * A2 Cart & Checkout voice tools (community role).
 *
 * Real backing: the Universal Cart gateway slice (VTID-03213,
 * routes/universal-cart.ts) — reads/writes ONLY `universal_carts`,
 * `universal_cart_items`, `universal_cart_events`, exactly like that route
 * file's own handlers. Agent-proposed items (review_agent_purchase_proposals)
 * read the same `universal_cart_items` rows the Propose-then-approve shopping
 * agent (VTID-03260, routes/shopping-agent.ts POST /propose + /reorder) writes
 * — those rows are tagged `source_surface='autopilot'` and carry a
 * `metadata.rationale/safety_flags/confidence/proposed_at` blob; there is no
 * separate "proposals" table, the cart items themselves ARE the proposals
 * until the user checks out or removes them.
 *
 * The `sb` passed into every handler here is the gateway's service-role
 * admin client (see routes/orb-tool.ts: `adminClient() || getSupabase()`),
 * NOT an RLS-scoped user client — so every query below explicitly filters by
 * `user_id` / cart ownership itself, the same defensive pattern
 * groups-events-tools.ts uses for global_community_group_members etc.
 *
 * PAYMENT POLICY (see wave1-shared-brief.md): start_checkout must NEVER call
 * checkoutUniversalCart() / debit a wallet / charge a card by voice. It only
 * validates cart preconditions and returns an orb_directive that navigates the
 * user to the cart/checkout screen to confirm payment themselves.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { emitCartEvent } from '../../routes/universal-cart';
import { deriveItemType } from '../shopping-agent/agent-core';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const VTID_CART = 'VTID-03213';
const VTID_SHOPPING_AGENT = 'VTID-03260';

/** Kept in sync with routes/universal-cart.ts DEFAULT_CURRENCY. */
const DEFAULT_CURRENCY = 'EUR';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** ok:false when there is no authenticated user — every one of these tools touches commerce data. */
function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

function navDirective(
  screen_id: string,
  route: string,
  title: string,
  reason: string,
  vtid: string,
): Record<string, unknown> {
  return { type: 'orb_directive', directive: 'navigate', screen_id, route, title, reason, vtid };
}

function fmtMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 'price unavailable';
  return `${(cents / 100).toFixed(2)} ${currency || DEFAULT_CURRENCY}`;
}

function isNoRowsError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'PGRST116';
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

interface CartRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  status: string;
}

interface CartItemRow {
  id: string;
  cart_id: string;
  product_id: string;
  item_type: string;
  quantity: number;
  status: string;
  source_surface: string | null;
  unit_price_cents_snapshot: number | null;
  currency_snapshot: string | null;
  metadata: Record<string, unknown> | null;
}

interface ProductLite {
  id: string;
  title: string;
  category: string | null;
  price_cents: number | null;
  currency: string | null;
  is_active: boolean;
  availability: string;
}

const CART_ITEM_COLS =
  'id, cart_id, product_id, item_type, quantity, status, source_surface, unit_price_cents_snapshot, currency_snapshot, metadata';
const PRODUCT_COLS = 'id, title, category, price_cents, currency, is_active, availability';

/** Find the caller's active cart (no autocreate). Always scoped to id.user_id explicitly (sb is service-role). */
async function findActiveCart(sb: SupabaseClient, userId: string): Promise<{ ok: true; cart: CartRow | null } | { ok: false; error: string }> {
  const { data, error } = await sb
    .from('universal_carts')
    .select('id, user_id, tenant_id, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error && !isNoRowsError(error)) return { ok: false, error: error.message };
  return { ok: true, cart: (data as CartRow | null) ?? null };
}

/** Get-or-create the caller's ONE active cart. Mirrors universal-cart.ts POST /items cart resolution. */
async function resolveOrCreateActiveCart(
  sb: SupabaseClient,
  userId: string,
  tenantId: string | null,
): Promise<{ ok: true; cartId: string; created: boolean } | { ok: false; error: string }> {
  const existing = await findActiveCart(sb, userId);
  if (!existing.ok) return existing;
  if (existing.cart) return { ok: true, cartId: existing.cart.id, created: false };

  const inserted = await sb
    .from('universal_carts')
    .insert({ user_id: userId, tenant_id: tenantId, status: 'active', metadata: {} })
    .select('id')
    .single();

  if (inserted.error && isUniqueViolation(inserted.error)) {
    const raced = await findActiveCart(sb, userId);
    if (raced.ok && raced.cart) return { ok: true, cartId: raced.cart.id, created: false };
    return { ok: false, error: raced.ok ? 'cart_create_failed' : raced.error };
  }
  if (inserted.error || !inserted.data) {
    return { ok: false, error: inserted.error?.message ?? 'cart_create_failed' };
  }
  const cartId = inserted.data.id as string;
  await emitCartEvent({ cart_id: cartId, user_id: userId, event_type: 'cart.created', event_payload: {} });
  return { ok: true, cartId, created: true };
}

/** Active items for a cart + the products they reference, hydrated in one pass. */
async function fetchActiveItemsWithProducts(
  sb: SupabaseClient,
  cartId: string,
): Promise<{ ok: true; items: CartItemRow[]; productsById: Map<string, ProductLite> } | { ok: false; error: string }> {
  const itemsRes = await sb
    .from('universal_cart_items')
    .select(CART_ITEM_COLS)
    .eq('cart_id', cartId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (itemsRes.error) return { ok: false, error: itemsRes.error.message };
  const items = (itemsRes.data as CartItemRow[]) ?? [];
  const productsById = new Map<string, ProductLite>();
  if (items.length > 0) {
    const productIds = [...new Set(items.map((i) => i.product_id))];
    const productsRes = await sb.from('products').select(PRODUCT_COLS).in('id', productIds);
    if (productsRes.error) return { ok: false, error: productsRes.error.message };
    for (const p of (productsRes.data as ProductLite[]) ?? []) productsById.set(p.id, p);
  }
  return { ok: true, items, productsById };
}

type ProductResolution =
  | { kind: 'one'; product: ProductLite }
  | { kind: 'many'; products: ProductLite[] }
  | { kind: 'none'; query: string }
  | { kind: 'error'; message: string };

/** Resolve a product by UUID or fuzzy title against the real marketplace `products` table. */
async function resolveProduct(sb: SupabaseClient, rawId: unknown, rawQuery: unknown): Promise<ProductResolution> {
  const productId = String(rawId ?? '').trim();
  const query = String(rawQuery ?? '').trim();

  if (UUID_RE.test(productId)) {
    const { data, error } = await sb.from('products').select(PRODUCT_COLS).eq('id', productId).maybeSingle();
    if (error) return { kind: 'error', message: error.message };
    if (!data) return { kind: 'none', query: productId };
    return { kind: 'one', product: data as ProductLite };
  }

  if (!query) return { kind: 'none', query: '' };

  const { data, error } = await sb
    .from('products')
    .select(PRODUCT_COLS)
    .eq('is_active', true)
    .ilike('title', `%${query}%`)
    .order('title', { ascending: true })
    .limit(5);
  if (error) return { kind: 'error', message: error.message };
  const products = (data as ProductLite[]) ?? [];
  if (products.length === 0) return { kind: 'none', query };
  if (products.length === 1) return { kind: 'one', product: products[0] };
  const exact = products.find((p) => p.title.toLowerCase() === query.toLowerCase());
  if (exact) return { kind: 'one', product: exact };
  return { kind: 'many', products };
}

/** Match active cart items against an item_id (exact) or a fuzzy product-name query. */
function matchCartItems(
  items: CartItemRow[],
  productsById: Map<string, ProductLite>,
  itemIdArg: string,
  queryArg: string,
): CartItemRow[] {
  if (UUID_RE.test(itemIdArg)) {
    const hit = items.find((i) => i.id === itemIdArg);
    return hit ? [hit] : [];
  }
  if (!queryArg) return items;
  const q = queryArg.toLowerCase();
  return items.filter((i) => {
    const p = productsById.get(i.product_id);
    return !!p && p.title.toLowerCase().includes(q);
  });
}

function speakItem(item: CartItemRow, productsById: Map<string, ProductLite>): string {
  const p = productsById.get(item.product_id);
  const title = p?.title ?? 'an item';
  const unit = item.unit_price_cents_snapshot ?? p?.price_cents ?? null;
  const currency = item.currency_snapshot ?? p?.currency ?? DEFAULT_CURRENCY;
  return `${item.quantity}x ${title} (${fmtMoney(unit, currency)} each)`;
}

/** Subtotal over active items, same formula as universal-cart.ts GET /budget (unit_price_cents_snapshot only). */
function computeSubtotalCents(items: CartItemRow[]): number {
  let total = 0;
  for (const i of items) {
    const unit = Number(i.unit_price_cents_snapshot ?? 0);
    const qty = Number(i.quantity ?? 0);
    if (Number.isFinite(unit) && Number.isFinite(qty)) total += unit * qty;
  }
  return total;
}

function cartCurrency(items: CartItemRow[], productsById: Map<string, ProductLite>): string {
  const currencies = new Set(
    items.map((i) => i.currency_snapshot ?? productsById.get(i.product_id)?.currency ?? DEFAULT_CURRENCY),
  );
  if (currencies.size === 1) return [...currencies][0];
  return DEFAULT_CURRENCY;
}

// ---------------------------------------------------------------------------
// add_to_cart
// ---------------------------------------------------------------------------

export async function tool_add_to_cart(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('add_to_cart', id);
  if (gate) return gate;

  const rawQuantity = Number(args.quantity ?? 1);
  const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1;
  const productQuery = String(args.query ?? args.product_name ?? '').trim();

  try {
    const resolved = await resolveProduct(sb, args.product_id, productQuery);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { added: false },
        text: productQuery
          ? `I couldn't find a product matching "${productQuery}". Want me to search the marketplace for you?`
          : 'Which product would you like to add to your cart?',
      };
    }
    if (resolved.kind === 'many') {
      const names = resolved.products.map((p) => `${p.title} (${fmtMoney(p.price_cents, p.currency)})`).join(', ');
      return {
        ok: true,
        result: { added: false, candidates: resolved.products.map((p) => ({ product_id: p.id, title: p.title })) },
        text: `I found ${resolved.products.length} products matching that: ${names}. Which one do you mean?`,
      };
    }

    const product = resolved.product;
    if (product.is_active !== true || product.availability !== 'in_stock') {
      return {
        ok: true,
        result: { added: false, product_id: product.id, unavailable: true },
        text: `"${product.title}" isn't available to purchase right now.`,
      };
    }

    const cartResolution = await resolveOrCreateActiveCart(sb, id.user_id, id.tenant_id);
    if (!cartResolution.ok) return { ok: false, error: cartResolution.error };
    const cartId = cartResolution.cartId;

    const existingItem = await sb
      .from('universal_cart_items')
      .select('id, quantity, metadata')
      .eq('cart_id', cartId)
      .eq('product_id', product.id)
      .eq('status', 'active')
      .maybeSingle();
    if (existingItem.error && !isNoRowsError(existingItem.error)) {
      return { ok: false, error: existingItem.error.message };
    }

    if (existingItem.data) {
      const before = Number(existingItem.data.quantity ?? 0);
      const after = before + quantity;
      const updated = await sb
        .from('universal_cart_items')
        .update({ quantity: after })
        .eq('id', existingItem.data.id)
        .select('id')
        .single();
      if (updated.error) return { ok: false, error: updated.error.message };
      await emitCartEvent({
        cart_id: cartId,
        user_id: id.user_id,
        event_type: 'item.added',
        event_payload: {
          cart_item_id: existingItem.data.id,
          product_id: product.id,
          quantity_before: before,
          quantity_after: after,
          source_surface: 'voice',
        },
      });
      return {
        ok: true,
        result: { added: true, item_id: existingItem.data.id, product_id: product.id, quantity: after, action: 'quantity_bumped' },
        text: `You already had "${product.title}" in your cart — I bumped it to ${after}.`,
      };
    }

    const inserted = await sb
      .from('universal_cart_items')
      .insert({
        cart_id: cartId,
        item_type: deriveItemType(product.category),
        product_id: product.id,
        quantity,
        status: 'active',
        source_surface: 'voice',
        unit_price_cents_snapshot: product.price_cents,
        currency_snapshot: product.currency,
        metadata: {},
      })
      .select('id')
      .single();
    if (inserted.error || !inserted.data) {
      return { ok: false, error: inserted.error?.message ?? 'item_insert_failed' };
    }
    await emitCartEvent({
      cart_id: cartId,
      user_id: id.user_id,
      event_type: 'item.added',
      event_payload: {
        cart_item_id: inserted.data.id,
        product_id: product.id,
        quantity_before: 0,
        quantity_after: quantity,
        source_surface: 'voice',
      },
    });

    return {
      ok: true,
      result: { added: true, item_id: inserted.data.id, product_id: product.id, quantity, action: 'created' },
      text: `Added ${quantity}x "${product.title}" to your cart (${fmtMoney(product.price_cents, product.currency)} each).`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'add_to_cart failed' };
  }
}

// ---------------------------------------------------------------------------
// view_cart
// ---------------------------------------------------------------------------

export async function tool_view_cart(_args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('view_cart', id);
  if (gate) return gate;
  try {
    const cartRes = await findActiveCart(sb, id.user_id);
    if (!cartRes.ok) return { ok: false, error: cartRes.error };
    if (!cartRes.cart) {
      return { ok: true, result: { items: [], subtotal_cents: 0 }, text: 'Your cart is empty.' };
    }
    const fetched = await fetchActiveItemsWithProducts(sb, cartRes.cart.id);
    if (!fetched.ok) return { ok: false, error: fetched.error };
    const { items, productsById } = fetched;
    if (items.length === 0) {
      return { ok: true, result: { items: [], subtotal_cents: 0 }, text: 'Your cart is empty.' };
    }
    const subtotal = computeSubtotalCents(items);
    const currency = cartCurrency(items, productsById);
    const lines = items.map((i) => speakItem(i, productsById)).join('; ');
    return {
      ok: true,
      result: {
        items: items.map((i) => ({
          item_id: i.id,
          product_id: i.product_id,
          title: productsById.get(i.product_id)?.title ?? null,
          quantity: i.quantity,
          unit_price_cents: i.unit_price_cents_snapshot ?? productsById.get(i.product_id)?.price_cents ?? null,
          source_surface: i.source_surface,
        })),
        subtotal_cents: subtotal,
        currency,
      },
      text: `Your cart has ${items.length} item${items.length === 1 ? '' : 's'}: ${lines}. Total: ${fmtMoney(subtotal, currency)}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'view_cart failed' };
  }
}

// ---------------------------------------------------------------------------
// update_cart_item
// ---------------------------------------------------------------------------

export async function tool_update_cart_item(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('update_cart_item', id);
  if (gate) return gate;
  const rawQuantity = Number(args.quantity);
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
    return { ok: false, error: 'update_cart_item requires a positive "quantity". Use remove_from_cart to remove an item.' };
  }
  const itemIdArg = String(args.item_id ?? '').trim();
  const queryArg = String(args.query ?? args.product_name ?? '').trim();
  try {
    const cartRes = await findActiveCart(sb, id.user_id);
    if (!cartRes.ok) return { ok: false, error: cartRes.error };
    if (!cartRes.cart) {
      return { ok: true, result: { updated: false }, text: 'Your cart is empty — there is nothing to update.' };
    }
    const fetched = await fetchActiveItemsWithProducts(sb, cartRes.cart.id);
    if (!fetched.ok) return { ok: false, error: fetched.error };
    const { items, productsById } = fetched;

    const matches = matchCartItems(items, productsById, itemIdArg, queryArg);
    if (matches.length === 0) {
      return {
        ok: true,
        result: { updated: false },
        text: queryArg
          ? `I couldn't find "${queryArg}" in your cart.`
          : 'Which item in your cart should I update the quantity for?',
      };
    }
    if (matches.length > 1) {
      const lines = matches.map((m) => speakItem(m, productsById)).join('; ');
      return {
        ok: true,
        result: { updated: false, candidates: matches.map((m) => ({ item_id: m.id, product_id: m.product_id })) },
        text: `You have ${matches.length} matching items: ${lines}. Which one should I update?`,
      };
    }

    const target = matches[0];
    const before = Number(target.quantity);
    const updated = await sb
      .from('universal_cart_items')
      .update({ quantity: rawQuantity })
      .eq('id', target.id)
      .eq('status', 'active')
      .select('id')
      .single();
    if (updated.error) return { ok: false, error: updated.error.message };

    if (rawQuantity !== before) {
      await emitCartEvent({
        cart_id: cartRes.cart.id,
        user_id: id.user_id,
        event_type: 'item.quantity_changed',
        event_payload: { cart_item_id: target.id, quantity_before: before, quantity_after: rawQuantity },
      });
    }

    const title = productsById.get(target.product_id)?.title ?? 'that item';
    return {
      ok: true,
      result: { updated: true, item_id: target.id, quantity: rawQuantity },
      text: `Updated "${title}" to ${rawQuantity}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'update_cart_item failed' };
  }
}

// ---------------------------------------------------------------------------
// remove_from_cart
// ---------------------------------------------------------------------------

export async function tool_remove_from_cart(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('remove_from_cart', id);
  if (gate) return gate;
  const itemIdArg = String(args.item_id ?? '').trim();
  const queryArg = String(args.query ?? args.product_name ?? '').trim();
  try {
    const cartRes = await findActiveCart(sb, id.user_id);
    if (!cartRes.ok) return { ok: false, error: cartRes.error };
    if (!cartRes.cart) {
      return { ok: true, result: { removed: false }, text: 'Your cart is already empty.' };
    }
    const fetched = await fetchActiveItemsWithProducts(sb, cartRes.cart.id);
    if (!fetched.ok) return { ok: false, error: fetched.error };
    const { items, productsById } = fetched;

    const matches = matchCartItems(items, productsById, itemIdArg, queryArg);
    if (matches.length === 0) {
      return {
        ok: true,
        result: { removed: false },
        text: queryArg
          ? `I couldn't find "${queryArg}" in your cart.`
          : 'Which item should I remove from your cart?',
      };
    }
    if (matches.length > 1) {
      const lines = matches.map((m) => speakItem(m, productsById)).join('; ');
      return {
        ok: true,
        result: { removed: false, candidates: matches.map((m) => ({ item_id: m.id, product_id: m.product_id })) },
        text: `You have ${matches.length} matching items: ${lines}. Which one should I remove?`,
      };
    }

    const target = matches[0];
    const title = productsById.get(target.product_id)?.title ?? 'that item';
    const updated = await sb
      .from('universal_cart_items')
      .update({ status: 'removed' })
      .eq('id', target.id)
      .eq('status', 'active')
      .select('id')
      .single();
    if (updated.error) return { ok: false, error: updated.error.message };

    await emitCartEvent({
      cart_id: cartRes.cart.id,
      user_id: id.user_id,
      event_type: 'item.removed',
      event_payload: { cart_item_id: target.id, removal_reason: 'voice_remove' },
    });

    return { ok: true, result: { removed: true, item_id: target.id }, text: `Removed "${title}" from your cart.` };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'remove_from_cart failed' };
  }
}

// ---------------------------------------------------------------------------
// clear_cart (⚠️ confirm)
// ---------------------------------------------------------------------------

export async function tool_clear_cart(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('clear_cart', id);
  if (gate) return gate;
  try {
    const cartRes = await findActiveCart(sb, id.user_id);
    if (!cartRes.ok) return { ok: false, error: cartRes.error };
    if (!cartRes.cart) {
      return { ok: true, result: { cleared: false }, text: 'Your cart is already empty.' };
    }
    const fetched = await fetchActiveItemsWithProducts(sb, cartRes.cart.id);
    if (!fetched.ok) return { ok: false, error: fetched.error };
    const { items, productsById } = fetched;
    if (items.length === 0) {
      return { ok: true, result: { cleared: false }, text: 'Your cart is already empty.' };
    }

    if (args.confirm !== true) {
      const lines = items.map((i) => speakItem(i, productsById)).join('; ');
      return {
        ok: true,
        result: { needs_confirmation: true, item_count: items.length },
        text: `Confirm with the user: remove all ${items.length} items from the cart (${lines})? When they say yes, call clear_cart again with confirm:true.`,
      };
    }

    const cleared = await sb
      .from('universal_cart_items')
      .update({ status: 'removed' })
      .eq('cart_id', cartRes.cart.id)
      .eq('status', 'active')
      .select('id');
    if (cleared.error) return { ok: false, error: cleared.error.message };

    const clearedIds = ((cleared.data as Array<{ id: string }>) ?? []).map((r) => r.id);
    await Promise.all(
      clearedIds.map((itemId) =>
        emitCartEvent({
          cart_id: cartRes.cart!.id,
          user_id: id.user_id,
          event_type: 'item.removed',
          event_payload: { cart_item_id: itemId, removal_reason: 'clear_cart' },
        }),
      ),
    );

    return {
      ok: true,
      result: { cleared: true, item_count: clearedIds.length },
      text: `Done — I cleared your cart (${clearedIds.length} item${clearedIds.length === 1 ? '' : 's'} removed).`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'clear_cart failed' };
  }
}

// ---------------------------------------------------------------------------
// set_shopping_budget
// ---------------------------------------------------------------------------

/** tenant backfill from app_users when the voice session carries a null tenant (needed: user_limitations.tenant_id is NOT NULL). */
async function resolveTenantId(id: OrbToolIdentity, sb: SupabaseClient): Promise<string | null> {
  if (id.tenant_id) return id.tenant_id;
  try {
    const { data } = await sb.from('app_users').select('tenant_id').eq('user_id', id.user_id).maybeSingle();
    return (data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
  } catch {
    return null;
  }
}

export async function tool_set_shopping_budget(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('set_shopping_budget', id);
  if (gate) return gate;
  const clear = args.clear === true;

  try {
    const { data: userRow } = await sb
      .from('app_users')
      .select('currency_preference')
      .eq('user_id', id.user_id)
      .maybeSingle();
    const currency = (userRow as { currency_preference?: string | null } | null)?.currency_preference || DEFAULT_CURRENCY;

    if (clear) {
      const { data: existing } = await sb
        .from('user_limitations')
        .select('user_id')
        .eq('user_id', id.user_id)
        .maybeSingle();
      if (!existing) {
        return { ok: true, result: { cleared: false }, text: "You don't have a monthly shopping budget set." };
      }
      const { error } = await sb
        .from('user_limitations')
        .update({ budget_monthly_cap_cents: null })
        .eq('user_id', id.user_id);
      if (error) return { ok: false, error: error.message };
      return { ok: true, result: { cleared: true }, text: 'Done — I removed your monthly shopping budget cap.' };
    }

    let capCents: number | null = null;
    if (args.monthly_cap_cents !== undefined) {
      const n = Number(args.monthly_cap_cents);
      if (Number.isFinite(n) && n >= 0) capCents = Math.round(n);
    } else if (args.monthly_cap_amount !== undefined || args.amount !== undefined) {
      const n = Number(args.monthly_cap_amount ?? args.amount);
      if (Number.isFinite(n) && n >= 0) capCents = Math.round(n * 100);
    }
    if (capCents === null) {
      return { ok: false, error: 'set_shopping_budget requires a monthly_cap_amount (e.g. 200 for 200 EUR) or clear:true.' };
    }

    const tenantId = await resolveTenantId(id, sb);
    if (!tenantId) {
      return { ok: false, error: 'set_shopping_budget requires a resolvable tenant for this user; none found.' };
    }

    const { error } = await sb
      .from('user_limitations')
      .upsert(
        { user_id: id.user_id, tenant_id: tenantId, budget_monthly_cap_cents: capCents },
        { onConflict: 'user_id' },
      );
    if (error) return { ok: false, error: error.message };

    return {
      ok: true,
      result: { saved: true, monthly_cap_cents: capCents, currency },
      text: `Got it — I've set your monthly shopping budget to ${fmtMoney(capCents, currency)}. I'll flag it if your cart plus this month's spending gets close.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'set_shopping_budget failed' };
  }
}

// ---------------------------------------------------------------------------
// review_agent_purchase_proposals
// ---------------------------------------------------------------------------

export async function tool_review_agent_purchase_proposals(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('review_agent_purchase_proposals', id);
  if (gate) return gate;
  try {
    const cartRes = await findActiveCart(sb, id.user_id);
    if (!cartRes.ok) return { ok: false, error: cartRes.error };
    if (!cartRes.cart) {
      return { ok: true, result: { proposals: [] }, text: 'There are no pending shopping-agent proposals right now.' };
    }
    const fetched = await fetchActiveItemsWithProducts(sb, cartRes.cart.id);
    if (!fetched.ok) return { ok: false, error: fetched.error };
    const { items, productsById } = fetched;

    // Agent-proposed items are the active cart items the propose/reorder
    // endpoints wrote — tagged source_surface='autopilot' (see agent-core.ts
    // insertPick / shopping-agent.ts POST /propose + /reorder). They sit in
    // the cart, unreviewed, until the user checks out or removes them.
    const proposals = items.filter((i) => i.source_surface === 'autopilot');
    if (proposals.length === 0) {
      return { ok: true, result: { proposals: [] }, text: 'There are no pending shopping-agent proposals right now.' };
    }

    const spoken = proposals
      .map((i) => {
        const p = productsById.get(i.product_id);
        const meta = (i.metadata ?? {}) as { rationale?: string; origin?: string };
        const title = p?.title ?? 'an item';
        const price = fmtMoney(i.unit_price_cents_snapshot ?? p?.price_cents ?? null, i.currency_snapshot ?? p?.currency ?? null);
        return `${title} (${price})${meta.rationale ? ` — ${meta.rationale}` : ''}`;
      })
      .join('; ');

    return {
      ok: true,
      result: {
        proposals: proposals.map((i) => {
          const meta = (i.metadata ?? {}) as {
            rationale?: string;
            safety_flags?: string[];
            confidence?: number;
            origin?: string;
            proposed_at?: string;
          };
          return {
            item_id: i.id,
            product_id: i.product_id,
            title: productsById.get(i.product_id)?.title ?? null,
            quantity: i.quantity,
            rationale: meta.rationale ?? null,
            safety_flags: meta.safety_flags ?? [],
            confidence: meta.confidence ?? null,
            origin: meta.origin ?? null,
            proposed_at: meta.proposed_at ?? null,
          };
        }),
      },
      text: `The shopping agent proposed ${proposals.length} item${proposals.length === 1 ? '' : 's'} for your cart: ${spoken}. Want me to remove any, or shall I take you to checkout?`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'review_agent_purchase_proposals failed' };
  }
}

// ---------------------------------------------------------------------------
// start_checkout (⚠️ confirm, PAYMENT POLICY APPLIES)
// ---------------------------------------------------------------------------

export async function tool_start_checkout(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('start_checkout', id);
  if (gate) return gate;
  try {
    const cartRes = await findActiveCart(sb, id.user_id);
    if (!cartRes.ok) return { ok: false, error: cartRes.error };
    if (!cartRes.cart) {
      return { ok: true, result: { started: false, reason: 'cart_empty' }, text: 'Your cart is empty — add something first.' };
    }
    const fetched = await fetchActiveItemsWithProducts(sb, cartRes.cart.id);
    if (!fetched.ok) return { ok: false, error: fetched.error };
    const { items, productsById } = fetched;
    if (items.length === 0) {
      return { ok: true, result: { started: false, reason: 'cart_empty' }, text: 'Your cart is empty — add something first.' };
    }

    const subtotal = computeSubtotalCents(items);
    const currency = cartCurrency(items, productsById);

    if (args.confirm !== true) {
      return {
        ok: true,
        result: { needs_confirmation: true, item_count: items.length, subtotal_cents: subtotal, currency },
        text: `Confirm with the user: your cart has ${items.length} item${items.length === 1 ? '' : 's'} totaling ${fmtMoney(subtotal, currency)} — ready to go to checkout? When they say yes, call start_checkout again with confirm:true. I will NOT charge anything by voice — the user always confirms payment on their screen.`,
      };
    }

    // PAYMENT POLICY: never call checkoutUniversalCart() / debit a wallet here.
    // Only validate preconditions (done above) and hand off to the screen
    // where the user taps the existing Approve & Pay control.
    const route = '/cart';
    return {
      ok: true,
      result: {
        started: true,
        item_count: items.length,
        subtotal_cents: subtotal,
        currency,
        decision: 'auto_nav',
        directive: navDirective('DISCOVER.CART', route, 'Shopping Cart', 'start_checkout handoff', VTID_CART),
        redirect: { route },
      },
      text: `Your cart is ready — ${items.length} item${items.length === 1 ? '' : 's'}, ${fmtMoney(subtotal, currency)} total. Go ahead and confirm payment on your screen.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'start_checkout failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const CART_CHECKOUT_TOOL_HANDLERS: Record<string, Handler> = {
  add_to_cart: tool_add_to_cart,
  view_cart: tool_view_cart,
  update_cart_item: tool_update_cart_item,
  remove_from_cart: tool_remove_from_cart,
  clear_cart: tool_clear_cart,
  set_shopping_budget: tool_set_shopping_budget,
  review_agent_purchase_proposals: tool_review_agent_purchase_proposals,
  start_checkout: tool_start_checkout,
};

export const CART_CHECKOUT_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'add_to_cart',
    description: [
      'Add a marketplace product to the user\'s cart, by product_id or fuzzy',
      'product name. Bumps quantity if the product is already in the cart.',
      'CALL WHEN the user says: "add ... to my cart", "I want to buy ...",',
      '"lege ... in den Warenkorb", "ich möchte ... kaufen".',
      'If several products match, read the candidates and ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Exact product UUID when already known from a previous tool result.' },
        query: { type: 'string', description: 'Spoken product name (fuzzy matched against the marketplace catalog).' },
        quantity: { type: 'number', description: 'How many to add. Defaults to 1.' },
      },
      required: [],
    },
  },
  {
    name: 'view_cart',
    description: [
      'Read the contents of the user\'s cart: items, quantities, prices, and',
      'the total. CALL WHEN the user asks: "what\'s in my cart?", "show my',
      'cart", "was ist in meinem Warenkorb?", "zeig mir meinen Warenkorb".',
      'Read the items and total aloud.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_cart_item',
    description: [
      'Change the quantity of an item already in the cart, by item_id or',
      'fuzzy product name. CALL WHEN the user says: "make it 2 of those",',
      '"change the quantity to ...", "ändere die Menge auf ...".',
      'If several items match, read the candidates and ask which one. Use',
      'remove_from_cart instead if the user wants to remove the item entirely.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Exact cart item UUID when known from a previous tool result.' },
        query: { type: 'string', description: 'Spoken product name to find the cart line (fuzzy matched).' },
        quantity: { type: 'number', description: 'The new quantity (must be positive).' },
      },
      required: ['quantity'],
    },
  },
  {
    name: 'remove_from_cart',
    description: [
      'Remove a single item from the cart, by item_id or fuzzy product name.',
      'CALL WHEN the user says: "remove ... from my cart", "take that out of',
      'my cart", "entferne ... aus dem Warenkorb".',
      'If several items match, read the candidates and ask which one.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Exact cart item UUID when known.' },
        query: { type: 'string', description: 'Spoken product name to find the cart line (fuzzy matched).' },
      },
      required: [],
    },
  },
  {
    name: 'clear_cart',
    description: [
      'Remove ALL items from the cart. ALWAYS call once WITHOUT confirm',
      'first — the tool returns a confirmation question listing what will be',
      'removed; after the user says yes, call again with confirm:true.',
      'CALL WHEN the user says: "clear my cart", "empty my cart", "remove',
      'everything", "leere meinen Warenkorb".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed clearing the cart.' },
      },
      required: [],
    },
  },
  {
    name: 'set_shopping_budget',
    description: [
      'Set or clear the user\'s monthly shopping budget cap, used as an',
      'advisory warning (never blocks purchases) when the cart plus this',
      'month\'s spending gets close to or exceeds it.',
      'CALL WHEN the user says: "set my monthly budget to ...", "limit my',
      'shopping to ... a month", "remove my budget", "setze mein monatliches',
      'Budget auf ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        monthly_cap_amount: { type: 'number', description: 'Monthly cap in the user\'s major currency unit (e.g. 200 for 200 EUR).' },
        clear: { type: 'boolean', description: 'Pass true to remove the existing budget cap instead of setting one.' },
      },
      required: [],
    },
  },
  {
    name: 'review_agent_purchase_proposals',
    description: [
      'List the items the shopping agent (autopilot) has proposed and placed',
      'into the user\'s cart for review — each with its rationale, safety',
      'flags, and confidence. These are NOT yet purchased; the user can',
      'remove any with remove_from_cart or proceed with start_checkout.',
      'CALL WHEN the user asks: "what did the shopping agent pick for me?",',
      '"show my pending proposals", "was hat der Einkaufsassistent',
      'vorgeschlagen?".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'start_checkout',
    description: [
      'Begin checkout for the user\'s cart. ALWAYS call once WITHOUT confirm',
      'first — the tool returns the cart total and asks for confirmation;',
      'after the user says yes, call again with confirm:true. This tool',
      'NEVER charges a card or completes payment by voice — it only',
      'validates the cart and navigates the user to the cart/checkout screen',
      'where THEY confirm payment themselves.',
      'CALL WHEN the user says: "check out", "let\'s pay for this", "go to',
      'checkout", "zur Kasse gehen", "ich möchte bezahlen".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed proceeding to checkout.' },
      },
      required: [],
    },
  },
];

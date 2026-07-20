/**
 * VTID-03237 (V1.2) — Universal Cart checkout bridge.
 *
 * The keystone that turns the four standalone rails (video shop feed → cart →
 * wallet → orders) into one purchase path. It reads the caller's active cart,
 * routes each line by PRODUCT SOURCE (the hybrid model), and settles it:
 *
 *   • first-party SKUs  (products.source_network ∈ FIRST_PARTY_SOURCE_NETWORKS)
 *       → debit the user's Vitana wallet (debit_wallet_for_spend RPC) and create
 *         CONVERTED product_orders rows. Vitana fulfils.
 *   • affiliate SKUs    (externally-synced: cj / amazon / shopify / awin / …)
 *       → NO wallet debit. Return the merchant affiliate_url redirect targets and
 *         create PENDING product_orders rows (conversion lands later via the
 *         affiliate postback rail). Commission attributes through product_clicks.
 *
 * Money-safety design (no live single-transaction RPC yet — that's a follow-up):
 *   1. INTENT — insert product_orders for every line in state='pending' first,
 *      keyed by external_order_id = `${checkout_id}:${cart_item_id}` so retries
 *      reuse rows instead of duplicating.
 *   2. DEBIT  — one idempotent debit_wallet_for_spend per checkout (reference_id =
 *      checkout_id). The RPC owns SELECT-FOR-UPDATE + ledger idempotency, so the
 *      money can never be taken twice and is never taken before an order row
 *      exists.
 *   3. SETTLE — on debit success flip the wallet orders to 'converted' and mark
 *      the cart items 'completed'. On debit failure nothing is completed and the
 *      pending orders are reapable — there is never money-without-record.
 *
 * All amounts are integer minor units (cents); never float. Reads/writes use the
 * service-role client but every query is explicitly scoped to the authenticated
 * userId (the route authorises the caller first) — no tenant crossing.
 */

import { randomUUID } from 'crypto';
import { getSupabase } from '../../lib/supabase';
import { debitWalletForSpend } from '../wallet/spend-earning-service';
import { creditRecommenderForOrder } from '../recommendation-commissions/credit-recommender';
import type { WalletCurrency } from '../../types/wallet';

export const VTID = 'VTID-03237';

/**
 * Product source networks treated as FIRST-PARTY (wallet checkout). Everything
 * else in products.source_network is an externally-synced affiliate catalog and
 * routes to click-out. Kept in sync with the source_network values seeded by the
 * marketplace sync (cj/amazon/shopify/awin/rakuten/direct_scrape vs manual/partner).
 */
export const FIRST_PARTY_SOURCE_NETWORKS = new Set<string>(['manual', 'partner']);

/** Wallet-settleable currencies — must match wallet_accounts.currency CHECK. */
const WALLET_CURRENCIES = new Set<string>(['EUR', 'USD']);

export type CheckoutErrorCode =
  | 'GATEWAY_MISCONFIGURED'
  | 'TENANT_REQUIRED'
  | 'CART_READ_FAILED'
  | 'CART_EMPTY'
  | 'PRODUCT_UNAVAILABLE'
  | 'PRICE_UNAVAILABLE'
  | 'MIXED_CURRENCY'
  | 'UNSUPPORTED_WALLET_CURRENCY'
  | 'WALLET_READ_FAILED'
  | 'WALLET_ACCOUNT_MISSING'
  | 'WALLET_ACCOUNT_INACTIVE'
  | 'INSUFFICIENT_BALANCE'
  | 'WALLET_DEBIT_FAILED'
  | 'ORDER_WRITE_FAILED';

/** Maps each domain error to the HTTP status the route should return. */
export const CHECKOUT_ERROR_STATUS: Record<CheckoutErrorCode, number> = {
  GATEWAY_MISCONFIGURED: 500,
  TENANT_REQUIRED: 409,
  CART_READ_FAILED: 500,
  CART_EMPTY: 400,
  PRODUCT_UNAVAILABLE: 409,
  PRICE_UNAVAILABLE: 409,
  MIXED_CURRENCY: 409,
  UNSUPPORTED_WALLET_CURRENCY: 409,
  WALLET_READ_FAILED: 500,
  WALLET_ACCOUNT_MISSING: 409,
  WALLET_ACCOUNT_INACTIVE: 409,
  INSUFFICIENT_BALANCE: 402,
  WALLET_DEBIT_FAILED: 502,
  ORDER_WRITE_FAILED: 500,
};

export interface CheckoutCartInput {
  userId: string;
  tenantId: string | null;
  /** Optional client-supplied idempotency key (UUID). Doubles as the checkout_id. */
  idempotencyKey?: string | null;
  /** Optional video-shop session id for funnel events. */
  sessionId?: string | null;
}

export interface WalletOrderSummary {
  currency: WalletCurrency;
  amount_minor: number;
  balance_minor: number;
  /** true when the debit was an idempotent replay (retry of the same checkout). */
  duplicate: boolean;
  order_ids: string[];
}

export interface AffiliateRedirect {
  item_id: string;
  product_id: string;
  affiliate_url: string;
  order_id: string | null;
}

export type CheckoutResult =
  | {
      ok: true;
      checkout_id: string;
      wallet_order: WalletOrderSummary | null;
      affiliate_redirects: AffiliateRedirect[];
      completed_item_ids: string[];
    }
  | {
      ok: false;
      error: CheckoutErrorCode;
      message?: string;
      /** PRODUCT_UNAVAILABLE: the offending lines. */
      unavailable?: { item_id: string; product_id: string; reason: string }[];
      /** INSUFFICIENT_BALANCE: surfaced from the wallet RPC. */
      balance_minor?: number;
      required_minor?: number;
      currency?: string;
    };

interface CartItemRow {
  id: string;
  product_id: string;
  quantity: number | string;
  unit_price_cents_snapshot: number | null;
  currency_snapshot: string | null;
  source_surface: string | null;
  source_video_id: string | null;
  source_creator_id: string | null;
  item_type: string;
}

interface ProductRow {
  id: string;
  source_network: string;
  price_cents: number | null;
  currency: string | null;
  is_active: boolean;
  availability: string;
  merchant_id: string | null;
  affiliate_url: string | null;
}

interface Line {
  item: CartItemRow;
  product: ProductRow;
  fulfillment: 'first_party' | 'affiliate';
  unitPriceCents: number;
  quantity: number;
  lineMinor: number;
  currency: string | null;
  externalOrderId: string;
  orderId: string | null;
}

/**
 * Execute checkout for the caller's active universal cart. The route MUST have
 * already authenticated the caller and confirmed the community role before
 * calling this; `userId` is trusted here.
 */
export async function checkoutUniversalCart(input: CheckoutCartInput): Promise<CheckoutResult> {
  const supa = getSupabase();
  if (!supa) return { ok: false, error: 'GATEWAY_MISCONFIGURED', message: 'Supabase not configured' };
  if (!input.tenantId) return { ok: false, error: 'TENANT_REQUIRED' };

  const { userId, tenantId } = input;
  const checkoutId = isUuid(input.idempotencyKey) ? (input.idempotencyKey as string) : randomUUID();
  const sessionId = input.sessionId || checkoutId;

  // 1. Active cart (scoped to the authenticated user).
  const cartRes = await supa
    .from('universal_carts')
    .select('id, user_id, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (cartRes.error) return { ok: false, error: 'CART_READ_FAILED', message: cartRes.error.message };
  if (!cartRes.data) return { ok: false, error: 'CART_EMPTY' };
  const cartId = cartRes.data.id as string;

  // 2. Active items.
  const itemsRes = await supa
    .from('universal_cart_items')
    .select(
      'id, product_id, quantity, unit_price_cents_snapshot, currency_snapshot, source_surface, source_video_id, source_creator_id, item_type'
    )
    .eq('cart_id', cartId)
    .eq('status', 'active');
  if (itemsRes.error) return { ok: false, error: 'CART_READ_FAILED', message: itemsRes.error.message };
  const items = (itemsRes.data ?? []) as CartItemRow[];
  if (items.length === 0) return { ok: false, error: 'CART_EMPTY' };

  // 3. Hydrate the live product rows.
  const productIds = [...new Set(items.map((i) => i.product_id))];
  const productsRes = await supa
    .from('products')
    .select('id, source_network, price_cents, currency, is_active, availability, merchant_id, affiliate_url')
    .in('id', productIds);
  if (productsRes.error) return { ok: false, error: 'CART_READ_FAILED', message: productsRes.error.message };
  const productById = new Map<string, ProductRow>();
  for (const p of (productsRes.data ?? []) as ProductRow[]) productById.set(p.id, p);

  // 4. Validate every line is purchasable (fail loudly; do NOT debit a stale cart).
  const unavailable: { item_id: string; product_id: string; reason: string }[] = [];
  for (const item of items) {
    const p = productById.get(item.product_id);
    if (!p) unavailable.push({ item_id: item.id, product_id: item.product_id, reason: 'product_not_found' });
    else if (p.is_active !== true) unavailable.push({ item_id: item.id, product_id: item.product_id, reason: 'inactive' });
    else if (p.availability !== 'in_stock')
      unavailable.push({ item_id: item.id, product_id: item.product_id, reason: 'out_of_stock' });
  }
  if (unavailable.length > 0) return { ok: false, error: 'PRODUCT_UNAVAILABLE', unavailable };

  // 5. Build priced lines + route by source.
  const lines: Line[] = [];
  for (const item of items) {
    const p = productById.get(item.product_id)!;
    const unit = item.unit_price_cents_snapshot ?? p.price_cents;
    const qty = Number(item.quantity);
    if (unit == null || !Number.isFinite(unit) || unit < 0 || !Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: 'PRICE_UNAVAILABLE', message: `line ${item.id} has no usable price/quantity` };
    }
    const lineMinor = Math.round(unit * qty);
    if (!Number.isSafeInteger(lineMinor) || lineMinor <= 0) {
      return { ok: false, error: 'PRICE_UNAVAILABLE', message: `line ${item.id} computed an invalid amount` };
    }
    const fulfillment = FIRST_PARTY_SOURCE_NETWORKS.has(p.source_network) ? 'first_party' : 'affiliate';
    lines.push({
      item,
      product: p,
      fulfillment,
      unitPriceCents: unit,
      quantity: qty,
      lineMinor,
      currency: item.currency_snapshot ?? p.currency,
      externalOrderId: `${checkoutId}:${item.id}`,
      orderId: null,
    });
  }

  const walletLines = lines.filter((l) => l.fulfillment === 'first_party');
  const affiliateLines = lines.filter((l) => l.fulfillment === 'affiliate');

  // 6. Wallet lines must share a single supported currency (one debit per checkout).
  let walletCurrency: WalletCurrency | null = null;
  let walletTotalMinor = 0;
  let walletAccountId: string | null = null;
  if (walletLines.length > 0) {
    const currencies = [...new Set(walletLines.map((l) => l.currency))];
    if (currencies.length !== 1 || currencies[0] == null) {
      return { ok: false, error: 'MIXED_CURRENCY', message: 'first-party items span multiple currencies' };
    }
    const cur = currencies[0];
    if (!WALLET_CURRENCIES.has(cur)) {
      return { ok: false, error: 'UNSUPPORTED_WALLET_CURRENCY', currency: cur };
    }
    walletCurrency = cur as WalletCurrency;
    walletTotalMinor = walletLines.reduce((sum, l) => sum + l.lineMinor, 0);

    const acctRes = await supa
      .from('wallet_accounts')
      .select('id, status, currency, balance_minor')
      .eq('user_id', userId)
      .eq('currency', walletCurrency)
      .maybeSingle();
    if (acctRes.error) return { ok: false, error: 'WALLET_READ_FAILED', message: acctRes.error.message };
    if (!acctRes.data) return { ok: false, error: 'WALLET_ACCOUNT_MISSING', currency: walletCurrency };
    if (acctRes.data.status !== 'active') return { ok: false, error: 'WALLET_ACCOUNT_INACTIVE' };
    walletAccountId = acctRes.data.id as string;
  }

  // 7. INTENT — ensure a pending product_orders row exists for every line
  //    (idempotent: reuse rows already created for this checkout_id on a retry).
  const existingRes = await supa
    .from('product_orders')
    .select('id, external_order_id')
    .eq('user_id', userId)
    .like('external_order_id', `${checkoutId}:%`);
  if (existingRes.error) return { ok: false, error: 'ORDER_WRITE_FAILED', message: existingRes.error.message };
  const orderIdByExt = new Map<string, string>();
  for (const row of (existingRes.data ?? []) as { id: string; external_order_id: string }[]) {
    orderIdByExt.set(row.external_order_id, row.id);
  }

  const rowsToInsert = lines
    .filter((l) => !orderIdByExt.has(l.externalOrderId))
    .map((l) => ({
      user_id: userId,
      tenant_id: tenantId,
      product_id: l.product.id,
      merchant_id: l.product.merchant_id,
      checkout_mode: l.fulfillment === 'first_party' ? 'embedded' : 'affiliate_link',
      state: 'pending',
      amount_cents: l.lineMinor,
      currency: l.currency,
      attribution_surface: l.item.source_surface,
      source_video_id: l.item.source_video_id,
      source_creator_id: l.item.source_creator_id,
      external_order_id: l.externalOrderId,
      raw: {
        checkout_id: checkoutId,
        cart_id: cartId,
        cart_item_id: l.item.id,
        quantity: l.quantity,
        unit_price_cents: l.unitPriceCents,
        fulfillment: l.fulfillment,
        item_type: l.item.item_type,
      },
    }));

  if (rowsToInsert.length > 0) {
    const insRes = await supa.from('product_orders').insert(rowsToInsert).select('id, external_order_id');
    if (insRes.error) return { ok: false, error: 'ORDER_WRITE_FAILED', message: insRes.error.message };
    for (const row of (insRes.data ?? []) as { id: string; external_order_id: string }[]) {
      orderIdByExt.set(row.external_order_id, row.id);
    }
  }
  for (const l of lines) l.orderId = orderIdByExt.get(l.externalOrderId) ?? null;

  // 8. DEBIT — single idempotent wallet debit for the first-party total.
  let walletOrder: WalletOrderSummary | null = null;
  if (walletLines.length > 0 && walletAccountId && walletCurrency) {
    const debit = await debitWalletForSpend({
      account_id: walletAccountId,
      amount_minor: walletTotalMinor,
      currency: walletCurrency,
      reference_type: 'cart_checkout',
      reference_id: checkoutId,
      description: `Universal cart checkout ${checkoutId}`,
      metadata: { cart_id: cartId, tenant_id: tenantId, item_count: walletLines.length },
    });

    if (!debit.ok) {
      // No money moved. Pending orders remain (reapable). Cart untouched.
      if (debit.error === 'INSUFFICIENT_BALANCE') {
        return {
          ok: false,
          error: 'INSUFFICIENT_BALANCE',
          balance_minor: debit.balance_minor,
          required_minor: debit.required_minor ?? walletTotalMinor,
          currency: walletCurrency,
        };
      }
      return { ok: false, error: 'WALLET_DEBIT_FAILED', message: debit.message ?? debit.error };
    }

    // 9a. SETTLE — flip the first-party orders to converted (best-effort; money
    //     already recorded against checkout_id, so a failure here is reconcilable).
    const walletExts = walletLines.map((l) => l.externalOrderId);
    const updRes = await supa
      .from('product_orders')
      .update({ state: 'converted', purchased_at: new Date().toISOString() })
      .eq('user_id', userId)
      .in('external_order_id', walletExts);
    if (updRes.error) {
      console.error(`[${VTID}] order convert failed for checkout ${checkoutId}:`, updRes.error.message);
    }

    // 9a-ii. Recommendation-commission crediting — a no-op today for first-party
    // orders (they don't carry commission_cents yet), but future-proofs the
    // hook point if a margin-based commission is ever added for these SKUs.
    for (const line of walletLines) {
      if (!line.orderId) continue;
      creditRecommenderForOrder(line.orderId).catch((e) =>
        console.error(`[${VTID}] creditRecommenderForOrder failed (non-fatal):`, e)
      );
    }

    walletOrder = {
      currency: walletCurrency,
      amount_minor: walletTotalMinor,
      balance_minor: debit.balance_minor,
      duplicate: debit.duplicate,
      order_ids: walletLines.map((l) => l.orderId).filter((x): x is string => !!x),
    };
  }

  // 9b. Complete the cart items that settled: all affiliate lines (the click-out
  //     IS the action) + first-party lines iff the debit succeeded.
  const completedItemIds: string[] = [
    ...affiliateLines.map((l) => l.item.id),
    ...(walletOrder ? walletLines.map((l) => l.item.id) : []),
  ];
  if (completedItemIds.length > 0) {
    const compRes = await supa
      .from('universal_cart_items')
      .update({ status: 'completed' })
      .eq('cart_id', cartId)
      .in('id', completedItemIds);
    if (compRes.error) {
      console.error(`[${VTID}] cart item completion failed for checkout ${checkoutId}:`, compRes.error.message);
    }
  }

  // 9c. Funnel events for video-shop-sourced lines (best-effort, never to oasis_events).
  await emitPurchaseEvents(supa, {
    userId,
    sessionId,
    walletLines: walletOrder ? walletLines : [],
    affiliateLines,
  });

  return {
    ok: true,
    checkout_id: checkoutId,
    wallet_order: walletOrder,
    affiliate_redirects: affiliateLines.map((l) => ({
      item_id: l.item.id,
      product_id: l.product.id,
      affiliate_url: l.product.affiliate_url ?? '',
      order_id: l.orderId,
    })),
    completed_item_ids: completedItemIds,
  };
}

/** Best-effort shop_video_events emission (purchase for settled wallet lines, checkout_start for affiliate). */
async function emitPurchaseEvents(
  supa: ReturnType<typeof getSupabase>,
  args: { userId: string; sessionId: string; walletLines: Line[]; affiliateLines: Line[] }
): Promise<void> {
  if (!supa) return;
  const rows: Record<string, unknown>[] = [];
  for (const l of args.walletLines) {
    if (!l.item.source_video_id) continue;
    rows.push({
      video_id: l.item.source_video_id,
      user_id: args.userId,
      session_id: args.sessionId,
      event_type: 'purchase',
      product_id: l.product.id,
      metadata: { fulfillment: 'first_party' },
    });
  }
  for (const l of args.affiliateLines) {
    if (!l.item.source_video_id) continue;
    rows.push({
      video_id: l.item.source_video_id,
      user_id: args.userId,
      session_id: args.sessionId,
      event_type: 'checkout_start',
      product_id: l.product.id,
      metadata: { fulfillment: 'affiliate' },
    });
  }
  if (rows.length === 0) return;
  const { error } = await supa.from('shop_video_events').insert(rows);
  if (error) console.error(`[${VTID}] shop_video_events purchase insert failed:`, error.message);
}

function isUuid(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

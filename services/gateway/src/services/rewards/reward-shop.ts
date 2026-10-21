/**
 * VTID-04982 — Rewards shop: members spend earned VTNA on items.
 *
 * Amounts never come from the client: the price is read and debited inside
 * redeem_reward_item() / settle_reward_order_shipping() under a row lock.
 *
 *  - event / digital items: one call debits VTNA and creates the paid order.
 *  - ship items: one unit is reserved and the member pays the shipping fee in
 *    Stripe Checkout (vitana_kind 'reward_shipping'); the billing webhook then
 *    settles (VTNA debited) or, if the VTNA or the stock is gone by then,
 *    refunds the Stripe charge. Unpaid holds expire after 30 minutes: released
 *    by checkout.session.expired and by the 5-minute reservation sweep.
 */
import Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from '../oasis-event-service';
import { VTNA_EUR_VALUE } from './reward-overview-service';
import * as repo from './reward-shop-repository';

export const SHOP_VTID = 'VTID-04982';
const LOG = '[reward-shop]';
export const RESERVATION_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Stripe needs at least 30 minutes; the DB hold is 30 minutes too. */
const CHECKOUT_EXPIRY_SECONDS = 31 * 60;

export type ShopCurrency = 'EUR' | 'USD';
export const isShopCurrency = (c: unknown): c is ShopCurrency => c === 'EUR' || c === 'USD';

let _stripe: Stripe | null = null;
function stripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
    _stripe = new Stripe(key);
  }
  return _stripe;
}
/** Test seam. */
export function __setStripeForTests(s: Stripe | null): void {
  _stripe = s;
}

interface ItemRow {
  id: string; slug: string; titles: Record<string, string>; descriptions: Record<string, string>;
  images: string[]; vtna_price: number; fulfilment: 'ship' | 'event' | 'digital';
  age_restricted: boolean; min_age: number | null; ships_to_countries: string[];
  stock: number | null; reserved: number; is_active: boolean; sort_order: number;
}

export async function getShop(sb: SupabaseClient, userId: string) {
  const [items, fees, wallet] = await Promise.all([
    repo.fetchActiveItems(sb), repo.fetchShippingFees(sb), repo.fetchEarnedBalance(sb, userId),
  ]);
  if (items.error) return { ok: false as const, error: 'SHOP_READ_FAILED' };
  const earned = Number((wallet.data as { earned_balance?: number } | null)?.earned_balance ?? 0);
  return {
    ok: true as const,
    eur_per_vtna: VTNA_EUR_VALUE,
    earned_balance: earned,
    items: ((items.data ?? []) as ItemRow[]).map((i) => ({
      id: i.id,
      slug: i.slug,
      titles: i.titles,
      descriptions: i.descriptions,
      images: i.images,
      vtna_price: i.vtna_price,
      eur_value: Math.round(i.vtna_price * VTNA_EUR_VALUE * 100) / 100,
      fulfilment: i.fulfilment,
      age_restricted: i.age_restricted,
      min_age: i.min_age,
      ships_to_countries: i.ships_to_countries,
      available: i.stock === null || i.stock - i.reserved > 0,
      affordable: earned >= i.vtna_price,
    })),
    shipping_fees: (fees.data ?? []) as Array<{ country: string; currency: ShopCurrency; fee_cents: number }>,
  };
}

export interface RedeemInput {
  userId: string;
  tenantId: string;
  email?: string | null;
  itemId: string;
  idempotencyKey: string;
  currency: ShopCurrency;
  country?: string | null;
  address?: Record<string, string> | null;
  birthDate?: string | null;
  ageConfirmed?: boolean;
  locale?: string | null;
  frontendUrl: string;
}

export type RedeemResult =
  | { ok: true; order_id: string; status: 'paid' | 'awaiting_shipping_payment'; vtna_amount: number; checkout_url?: string; duplicate?: boolean }
  | { ok: false; error: string; status_code: number; detail?: Record<string, unknown> };

const ERROR_STATUS: Record<string, number> = {
  ARGS_REQUIRED: 400, INVALID_CURRENCY: 400, ADDRESS_REQUIRED: 400, AGE_CONFIRMATION_REQUIRED: 400,
  UNDER_MIN_AGE: 403, NOT_ELIGIBLE: 403, ITEM_NOT_AVAILABLE: 404, SHIPPING_NOT_AVAILABLE: 409,
  OUT_OF_STOCK: 409, INSUFFICIENT_BALANCE: 409,
};

export async function redeem(sb: SupabaseClient, input: RedeemInput): Promise<RedeemResult> {
  const { data, error } = await repo.rpcRedeem(sb, {
    p_tenant_id: input.tenantId,
    p_user_id: input.userId,
    p_item_id: input.itemId,
    p_idempotency_key: input.idempotencyKey,
    p_currency: input.currency,
    p_country: input.country ?? null,
    p_address: input.address ?? null,
    p_birth_date: input.birthDate ?? null,
    p_age_confirmed: input.ageConfirmed === true,
  });
  if (error) {
    console.error(`${LOG} redeem_reward_item failed: ${error.message}`);
    return { ok: false, error: 'REDEEM_FAILED', status_code: 500 };
  }
  const r = (data ?? {}) as Record<string, any>;
  if (!r.ok) {
    const code = String(r.error ?? 'REDEEM_FAILED');
    const { ok: _ok, error: _e, ...detail } = r;
    return { ok: false, error: code, status_code: ERROR_STATUS[code] ?? 500, detail };
  }

  const orderId = String(r.order_id);
  if (r.status === 'paid') {
    if (!r.duplicate) {
      await emit('rewards.shop.redeemed', 'success', `Rewards shop: order ${orderId} paid with ${r.vtna_amount} VTNA`, {
        order_id: orderId, user_id: input.userId, item_id: input.itemId, vtna_amount: r.vtna_amount, fulfilment: 'event_or_digital',
      });
    }
    return { ok: true, order_id: orderId, status: 'paid', vtna_amount: Number(r.vtna_amount), duplicate: !!r.duplicate };
  }

  if (r.status !== 'awaiting_shipping_payment') {
    // A replay of an order that has moved on (paid, cancelled, refunded).
    return { ok: true, order_id: orderId, status: r.status, vtna_amount: Number(r.vtna_amount), duplicate: true } as RedeemResult;
  }

  // Ship item: the member pays shipping in Stripe Checkout.
  try {
    if (r.duplicate) {
      // Replay: hand back the session already opened for this order.
      const existing = await repo.fetchOrder(sb, orderId);
      const sid = (existing.data as { stripe_session_id?: string | null } | null)?.stripe_session_id;
      if (sid) {
        const s = await stripe().checkout.sessions.retrieve(sid);
        return { ok: true, order_id: orderId, status: 'awaiting_shipping_payment', vtna_amount: Number(r.vtna_amount), checkout_url: s.url ?? undefined, duplicate: true };
      }
    }
    const items = await repo.fetchActiveItems(sb);
    const item = ((items.data ?? []) as ItemRow[]).find((i) => i.id === input.itemId);
    const lc = (input.locale ?? '').toLowerCase().slice(0, 2);
    const title = (item?.titles?.[lc] || item?.titles?.de || item?.slug) ?? orderId;
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      client_reference_id: input.userId,
      ...(input.email ? { customer_email: input.email } : {}),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: String(r.shipping_currency ?? input.currency).toLowerCase(),
          unit_amount: Number(r.shipping_fee_cents),
          product_data: { name: title },
        },
      }],
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRY_SECONDS,
      success_url: `${input.frontendUrl}/wallet/rewards?tab=shop&order=${orderId}&shipping=paid`,
      cancel_url: `${input.frontendUrl}/wallet/rewards?tab=shop&order=${orderId}&shipping=cancelled`,
      metadata: {
        vitana_kind: 'reward_shipping',
        vitana_order_id: orderId,
        vitana_user_id: input.userId,
        vitana_tenant_id: input.tenantId,
      },
    });
    await repo.attachStripeSession(sb, orderId, session.id);
    return { ok: true, order_id: orderId, status: 'awaiting_shipping_payment', vtna_amount: Number(r.vtna_amount), checkout_url: session.url ?? undefined, duplicate: !!r.duplicate };
  } catch (err: any) {
    console.error(`${LOG} shipping checkout failed for order ${orderId}: ${err?.message ?? err}`);
    await repo.rpcReleaseReservation(sb, orderId, 'checkout_failed');
    return { ok: false, error: 'CHECKOUT_FAILED', status_code: 502 };
  }
}

/** Billing webhook: checkout.session.completed with vitana_kind 'reward_shipping'. */
export async function settleShipping(sb: SupabaseClient, session: Stripe.Checkout.Session): Promise<void> {
  const orderId = session.metadata?.vitana_order_id;
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  if (!orderId) {
    console.warn(`${LOG} reward_shipping session without order id: ${session.id}`);
    return;
  }
  const { data, error } = await repo.rpcSettleShipping(sb, { p_order_id: orderId, p_session_id: session.id, p_payment_intent: paymentIntent });
  if (error) throw new Error(`settle_reward_order_shipping failed: ${error.message}`); // webhook retries
  const r = (data ?? {}) as Record<string, any>;
  if (r.refund) {
    if (paymentIntent) {
      await stripe().refunds.create({ payment_intent: paymentIntent }, { idempotencyKey: `reward_refund:${orderId}` });
    }
    await emit('rewards.shop.refunded', 'warning', `Rewards shop: order ${orderId} refunded (${r.error})`, {
      order_id: orderId, reason: r.error, stripe_session_id: session.id, refunded: !!paymentIntent,
    });
    return;
  }
  if (r.ok && !r.duplicate) {
    await emit('rewards.shop.shipping_paid', 'success', `Rewards shop: order ${orderId} shipping paid, VTNA debited`, {
      order_id: orderId, stripe_session_id: session.id,
    });
  }
}

/** Billing webhook: checkout.session.expired with vitana_kind 'reward_shipping'. */
export async function releaseOnExpiry(sb: SupabaseClient, session: Stripe.Checkout.Session): Promise<void> {
  const orderId = session.metadata?.vitana_order_id;
  if (!orderId) return;
  const { data, error } = await repo.rpcReleaseReservation(sb, orderId, 'stripe_expired');
  if (error) throw new Error(`release_reward_reservation failed: ${error.message}`);
  if ((data as Record<string, any> | null)?.released) {
    await emit('rewards.shop.reservation_expired', 'info', `Rewards shop: order ${orderId} hold released (checkout expired)`, {
      order_id: orderId, trigger: 'stripe',
    });
  }
}

export async function releaseExpiredReservations(sb: SupabaseClient): Promise<number> {
  const { data, error } = await repo.rpcReleaseExpired(sb);
  if (error) {
    console.warn(`${LOG} reservation sweep failed: ${error.message}`);
    return 0;
  }
  const n = Number(data ?? 0);
  if (n > 0) {
    await emit('rewards.shop.reservation_expired', 'info', `Rewards shop: ${n} unpaid hold(s) released`, { released: n, trigger: 'sweep' });
  }
  return n;
}

/** The sweep runs in the ECS gateway only (staging shares the database; one runner is enough, both are safe). */
export function reservationSweepAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITANA_ENV !== 'staging' && !!(env.ECS_CONTAINER_METADATA_URI_V4 || env.ECS_CONTAINER_METADATA_URI);
}

export function startRewardReservationSweep(getClient: () => SupabaseClient | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!reservationSweepAllowed(env)) return false;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sb = getClient();
      if (sb) await releaseExpiredReservations(sb);
    } catch (err: any) {
      console.error(`${LOG} reservation sweep tick failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  };
  setInterval(() => { void tick(); }, RESERVATION_SWEEP_INTERVAL_MS).unref?.();
  return true;
}

export async function setOrderStatus(sb: SupabaseClient, orderId: string, status: string, reason: string | null, adminId: string) {
  const { data, error } = await repo.rpcSetStatus(sb, orderId, status, reason);
  if (error) return { ok: false as const, error: 'STATUS_UPDATE_FAILED', status_code: 500 };
  const r = (data ?? {}) as Record<string, any>;
  if (!r.ok) return { ok: false as const, error: String(r.error), status_code: r.error === 'ORDER_NOT_FOUND' ? 404 : 409, detail: r };
  await emit('rewards.shop.order_status_changed', 'info', `Rewards shop: order ${orderId} ${r.from} -> ${r.to}`, {
    order_id: orderId, from: r.from, to: r.to, by: adminId,
  });
  return { ok: true as const, order_id: orderId, from: r.from, to: r.to };
}

async function emit(type: string, status: 'success' | 'warning' | 'info', message: string, payload: Record<string, unknown>) {
  await emitOasisEvent({ vtid: SHOP_VTID, type: type as any, source: 'reward-shop', status, message, payload })
    .catch((e: any) => console.warn(`${LOG} OASIS emit failed: ${e?.message ?? e}`));
}

/**
 * VTID-03107 · Billing v1 — Customer-side Stripe routes + redemption
 *
 * Mounted at /api/v1/billing
 *
 *   GET  /me                            current plan + usage + credits + earnings
 *   POST /checkout/subscription         Stripe Checkout (subscription mode)
 *   POST /checkout/credits              Stripe Checkout (payment mode for credit pack)
 *   POST /portal                        Stripe Customer Portal (manage / cancel)
 *   POST /credits/spend                 idempotent credit burn for a feature
 *   POST /redeem                        redemption code → grants Premium (no Stripe)
 *   POST /webhooks/stripe               customer-side webhook (separate secret from Connect)
 *
 * Admin endpoints (require exafy_admin):
 *   POST /admin/redemption-codes/generate    bulk-generate unique codes for a campaign
 *   GET  /admin/redemption-codes             list codes + usage per campaign
 *   PATCH /admin/redemption-codes/:code      deactivate/reactivate a code
 *
 * Separation from Stripe Connect
 *   This file handles the CUSTOMER side (users paying Vitana for plans +
 *   credit packs). Stripe Connect (creators receiving payouts from Live
 *   Rooms) lives in routes/creators.ts + routes/stripe-connect-webhook.ts
 *   and is untouched by PR-2.
 *
 * Webhook signing
 *   The customer-side webhook uses STRIPE_BILLING_WEBHOOK_SECRET, a
 *   DIFFERENT env var from the Connect webhook's STRIPE_CONNECT_WEBHOOK_SECRET.
 *   This lets the two webhooks be rotated independently.
 */

import { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';

import { getSupabase } from '../lib/supabase';
import {
  requireAuth,
  requireExafyAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  checkEntitlement,
  recordUsage,
  consumeCredits,
  getUserPlan,
  recordPaywallEvent,
  type WalletBucket,
} from '../services/entitlement-service';

const VTID = 'VTID-03107';
const LOG_PREFIX = '[billing]';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://community-app.vitanaland.com';
const STRIPE_BILLING_WEBHOOK_SECRET = process.env.STRIPE_BILLING_WEBHOOK_SECRET || '';

const router = Router();

// =============================================================================
// Lazy Stripe init (mirrors routes/creators.ts pattern)
// =============================================================================

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    _stripe = new Stripe(key);
  }
  return _stripe;
}

function sb() {
  const client = getSupabase();
  if (!client) {
    throw new Error('Supabase service client unavailable');
  }
  return client;
}

// =============================================================================
// Helpers
// =============================================================================

interface PriceRow {
  price_key: string;
  plan_key: string;
  billing_interval: 'month' | 'year';
  price_cents: number;
  currency: string;
  stripe_price_id: string | null;
}

interface PackRow {
  pack_key: string;
  display_name: string;
  credits: number;
  bonus_credits: number;
  price_cents: number;
  currency: string;
  stripe_price_id: string | null;
}

interface UserSubscriptionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  plan_key: string;
  price_key: string | null;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_end: string | null;
  last_payment_error: string | null;
  metadata: Record<string, unknown>;
}

async function readPriceByKey(priceKey: string): Promise<PriceRow | null> {
  const { data, error } = await sb()
    .from('subscription_plan_prices')
    .select('price_key, plan_key, billing_interval, price_cents, currency, stripe_price_id')
    .eq('price_key', priceKey)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    console.error(`${LOG_PREFIX} readPriceByKey error: ${error.message}`);
    return null;
  }
  return (data as PriceRow) || null;
}

async function readPackByKey(packKey: string): Promise<PackRow | null> {
  const { data, error } = await sb()
    .from('credit_packs')
    .select('pack_key, display_name, credits, bonus_credits, price_cents, currency, stripe_price_id')
    .eq('pack_key', packKey)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    console.error(`${LOG_PREFIX} readPackByKey error: ${error.message}`);
    return null;
  }
  return (data as PackRow) || null;
}

async function readUserSubscription(
  tenantId: string,
  userId: string
): Promise<UserSubscriptionRow | null> {
  const { data, error } = await sb()
    .from('user_subscriptions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error(`${LOG_PREFIX} readUserSubscription error: ${error.message}`);
    return null;
  }
  return (data as UserSubscriptionRow) || null;
}

async function ensureStripeCustomer(
  tenantId: string,
  userId: string,
  email: string | null
): Promise<string> {
  const sub = await readUserSubscription(tenantId, userId);
  if (sub?.stripe_customer_id) {
    return sub.stripe_customer_id;
  }
  // Create a new Stripe Customer with our user_id + tenant_id in metadata
  const customer = await getStripe().customers.create({
    email: email ?? undefined,
    metadata: {
      vitana_user_id: userId,
      vitana_tenant_id: tenantId,
      vtid: VTID,
    },
  });

  // Upsert user_subscriptions to remember the customer_id even before they
  // actually subscribe to anything. plan_key='free' / status='free' as default.
  await sb()
    .from('user_subscriptions')
    .upsert(
      {
        tenant_id: tenantId,
        user_id: userId,
        plan_key: sub?.plan_key ?? 'free',
        status: sub?.status ?? 'free',
        stripe_customer_id: customer.id,
        metadata: { ...(sub?.metadata ?? {}), source: sub?.metadata?.source ?? 'free_default' },
      },
      { onConflict: 'tenant_id,user_id' }
    );
  return customer.id;
}

// =============================================================================
// GET /me  — single endpoint that powers the Subscriptions screen
// =============================================================================

router.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity;
  if (!identity?.user_id || !identity?.tenant_id) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
  try {
    const [plan, sub] = await Promise.all([
      getUserPlan(identity.user_id, identity.tenant_id),
      readUserSubscription(identity.tenant_id, identity.user_id),
    ]);

    // Wallet snapshot (post-§M three-bucket schema)
    const { data: wallet } = await sb()
      .from('wallet_balances')
      .select('purchased_credits, reward_credits, cash_balance, balance')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .maybeSingle();

    // Usage rollup for the 6 metered features (only for current plan)
    const { data: entitlementRows } = await sb()
      .from('feature_entitlements')
      .select('feature_key, quota, window_seconds, unit, behavior_on_exceed')
      .eq('plan_key', plan.plan_key);

    const usage: Record<string, { used: number; quota: number; reset_at: string | null; unit: string; behavior: string }> = {};
    if (entitlementRows) {
      for (const row of entitlementRows as Array<{ feature_key: string; quota: number; window_seconds: number; unit: string; behavior_on_exceed: string }>) {
        const { data: u } = await sb().rpc('fn_get_feature_usage', {
          p_tenant_id: identity.tenant_id,
          p_user_id: identity.user_id,
          p_feature_key: row.feature_key,
          p_window_seconds: row.window_seconds,
        });
        const used = (u as { used?: number })?.used ?? 0;
        const resetAt = (u as { window_end?: string })?.window_end ?? null;
        usage[row.feature_key] = {
          used,
          quota: row.quota,
          reset_at: resetAt,
          unit: row.unit,
          behavior: row.behavior_on_exceed,
        };
      }
    }

    // Earnings rollup (read-only; no commission attribution code in PR-2)
    const yearStart = new Date();
    yearStart.setUTCMonth(0, 1);
    yearStart.setUTCHours(0, 0, 0, 0);
    const { data: earnTx } = await sb()
      .from('wallet_transactions')
      .select('amount, created_at')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .eq('type', 'earning')
      .gte('created_at', yearStart.toISOString());
    const yearEarnedCents = ((earnTx as Array<{ amount: number }>) ?? []).reduce(
      (sum, t) => sum + (t.amount > 0 ? t.amount : 0),
      0
    );

    return res.json({
      ok: true,
      vtid: VTID,
      plan: {
        plan_key: plan.plan_key,
        status: plan.status,
        current_period_end: plan.current_period_end,
        cancel_at_period_end: plan.cancel_at_period_end,
        trial_end: plan.trial_end,
        price_key: sub?.price_key ?? null,
        source: (plan.metadata?.source as string | undefined) ?? null,
      },
      wallet: {
        purchased_credits: wallet?.purchased_credits ?? 0,
        reward_credits: wallet?.reward_credits ?? 0,
        cash_balance: wallet?.cash_balance ?? 0,
        balance_total: wallet?.balance ?? 0,
      },
      usage,
      earnings: {
        year_in_cents: yearEarnedCents,
      },
      stripe: {
        has_customer: !!sub?.stripe_customer_id,
        has_paid_subscription: !!sub?.stripe_subscription_id,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} /me crash: ${message}`);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', vtid: VTID });
  }
});

// =============================================================================
// POST /checkout/subscription  — start a Stripe Checkout session for a plan
// =============================================================================

router.post('/checkout/subscription', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity;
  if (!identity?.user_id || !identity?.tenant_id) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const priceKey: string | undefined = req.body?.price_key;
  if (!priceKey || typeof priceKey !== 'string') {
    return res.status(400).json({ ok: false, error: 'MISSING_PRICE_KEY' });
  }

  const price = await readPriceByKey(priceKey);
  if (!price) {
    return res.status(400).json({ ok: false, error: 'PRICE_NOT_FOUND', price_key: priceKey });
  }
  if (!price.stripe_price_id) {
    return res.status(503).json({
      ok: false,
      error: 'STRIPE_PRICE_NOT_CONFIGURED',
      message: 'Ops has not yet populated stripe_price_id for this plan. Contact admin.',
      price_key: priceKey,
    });
  }

  // Block if user already has an active Stripe sub on this customer
  const existingSub = await readUserSubscription(identity.tenant_id, identity.user_id);
  if (existingSub?.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(existingSub.status)) {
    return res.status(409).json({
      ok: false,
      error: 'ALREADY_SUBSCRIBED',
      current_plan: existingSub.plan_key,
      message: 'Manage your subscription via the customer portal.',
    });
  }

  try {
    const customerId = await ensureStripeCustomer(identity.tenant_id, identity.user_id, identity.email);

    // Look up trial_days from the plan
    const { data: planRow } = await sb()
      .from('subscription_plans')
      .select('trial_days')
      .eq('plan_key', price.plan_key)
      .maybeSingle();
    const trialDays = (planRow as { trial_days?: number })?.trial_days ?? 0;

    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: identity.user_id,
      line_items: [
        {
          price: price.stripe_price_id,
          quantity: 1,
        },
      ],
      subscription_data:
        trialDays > 0
          ? {
              trial_period_days: trialDays,
              metadata: {
                vitana_user_id: identity.user_id,
                vitana_tenant_id: identity.tenant_id,
                vitana_plan_key: price.plan_key,
                vitana_price_key: price.price_key,
              },
            }
          : {
              metadata: {
                vitana_user_id: identity.user_id,
                vitana_tenant_id: identity.tenant_id,
                vitana_plan_key: price.plan_key,
                vitana_price_key: price.price_key,
              },
            },
      success_url: `${FRONTEND_URL}/wallet/subscriptions?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/wallet/subscriptions?checkout=cancelled`,
      metadata: {
        vitana_user_id: identity.user_id,
        vitana_tenant_id: identity.tenant_id,
        vitana_kind: 'subscription',
        vitana_plan_key: price.plan_key,
        vitana_price_key: price.price_key,
      },
    });

    return res.json({ ok: true, url: session.url, session_id: session.id, vtid: VTID });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} /checkout/subscription crash: ${message}`);
    return res.status(500).json({ ok: false, error: 'STRIPE_CHECKOUT_FAILED', message, vtid: VTID });
  }
});

// =============================================================================
// POST /checkout/credits  — Stripe Checkout for a credit pack (one-shot)
// =============================================================================

router.post('/checkout/credits', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity;
  if (!identity?.user_id || !identity?.tenant_id) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const packKey: string | undefined = req.body?.pack_key;
  if (!packKey || typeof packKey !== 'string') {
    return res.status(400).json({ ok: false, error: 'MISSING_PACK_KEY' });
  }

  const pack = await readPackByKey(packKey);
  if (!pack) {
    return res.status(400).json({ ok: false, error: 'PACK_NOT_FOUND', pack_key: packKey });
  }
  if (!pack.stripe_price_id) {
    return res.status(503).json({
      ok: false,
      error: 'STRIPE_PRICE_NOT_CONFIGURED',
      message: 'Ops has not yet populated stripe_price_id for this credit pack.',
      pack_key: packKey,
    });
  }

  try {
    const customerId = await ensureStripeCustomer(identity.tenant_id, identity.user_id, identity.email);
    const totalCredits = pack.credits + (pack.bonus_credits || 0);
    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      client_reference_id: identity.user_id,
      line_items: [{ price: pack.stripe_price_id, quantity: 1 }],
      success_url: `${FRONTEND_URL}/wallet?credits_purchased=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/wallet/subscriptions?checkout=cancelled`,
      metadata: {
        vitana_user_id: identity.user_id,
        vitana_tenant_id: identity.tenant_id,
        vitana_kind: 'credit_pack',
        vitana_pack_key: pack.pack_key,
        vitana_credits: String(totalCredits),
      },
    });
    return res.json({ ok: true, url: session.url, session_id: session.id, vtid: VTID });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} /checkout/credits crash: ${message}`);
    return res.status(500).json({ ok: false, error: 'STRIPE_CHECKOUT_FAILED', message, vtid: VTID });
  }
});

// =============================================================================
// POST /portal  — Stripe Customer Portal redirect
// =============================================================================

router.post('/portal', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity;
  if (!identity?.user_id || !identity?.tenant_id) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
  const sub = await readUserSubscription(identity.tenant_id, identity.user_id);
  if (!sub?.stripe_customer_id) {
    return res.status(400).json({ ok: false, error: 'NO_STRIPE_CUSTOMER', message: 'Subscribe first before using the portal.' });
  }
  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${FRONTEND_URL}/wallet/subscriptions`,
    });
    return res.json({ ok: true, url: session.url, vtid: VTID });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} /portal crash: ${message}`);
    return res.status(500).json({ ok: false, error: 'STRIPE_PORTAL_FAILED', message, vtid: VTID });
  }
});

// =============================================================================
// POST /credits/spend  — idempotent credit burn for a feature
// =============================================================================

router.post('/credits/spend', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity;
  if (!identity?.user_id || !identity?.tenant_id) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const feature: string | undefined = req.body?.feature;
  const unitsRaw = req.body?.units;
  const units = typeof unitsRaw === 'number' && unitsRaw > 0 ? Math.floor(unitsRaw) : 1;
  const preferredBucket: WalletBucket | undefined =
    req.body?.bucket && typeof req.body.bucket === 'string' ? req.body.bucket : undefined;

  if (!feature || typeof feature !== 'string') {
    return res.status(400).json({ ok: false, error: 'MISSING_FEATURE' });
  }

  const idempotencyKey =
    (req.headers['idempotency-key'] as string | undefined) ||
    (req.body?.idempotency_key as string | undefined) ||
    `pawall-credit:${identity.user_id}:${feature}:${randomUUID()}`;

  const result = await consumeCredits(
    identity.user_id,
    identity.tenant_id,
    feature,
    units,
    idempotencyKey,
    preferredBucket
  );

  if (!result.ok) {
    return res.status(400).json({ ...result, ok: false, error: result.error, vtid: VTID });
  }

  // Advance the feature usage meter so the entitlement engine sees the spend
  // as "consumed" — the PAYG credits paid for the units.
  const { data: cfg } = await sb()
    .from('feature_entitlements')
    .select('window_seconds')
    .eq('plan_key', (await getUserPlan(identity.user_id, identity.tenant_id)).plan_key)
    .eq('feature_key', feature)
    .maybeSingle();
  const windowSeconds = (cfg as { window_seconds?: number })?.window_seconds ?? 2592000;
  await recordUsage(identity.user_id, identity.tenant_id, feature, units, windowSeconds);

  return res.json({ ...result, ok: true, units_purchased: units, vtid: VTID });
});

// =============================================================================
// POST /redeem  — code redemption (calls fn_redeem_code RPC)
// =============================================================================

router.post('/redeem', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity;
  if (!identity?.user_id || !identity?.tenant_id) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
  const code: string | undefined = req.body?.code;
  if (!code || typeof code !== 'string' || code.trim().length < 3) {
    return res.status(400).json({ ok: false, error: 'INVALID_CODE' });
  }

  try {
    const { data, error } = await sb().rpc('fn_redeem_code', {
      p_tenant_id: identity.tenant_id,
      p_user_id: identity.user_id,
      p_code: code.trim(),
    });
    if (error) {
      console.error(`${LOG_PREFIX} fn_redeem_code error: ${error.message}`);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: error.message });
    }
    const result = data as Record<string, unknown>;
    if ((result.ok as boolean) === true) {
      return res.json({ ok: true, ...result, vtid: VTID });
    }
    // Map the RPC error to HTTP status
    const errCode = (result.error as string) || 'UNKNOWN';
    const status =
      errCode === 'INVALID_CODE' ? 404 :
      errCode === 'EXPIRED' || errCode === 'EXPIRED_OR_INACTIVE' ? 410 :
      errCode === 'MAX_USES_REACHED' ? 410 :
      errCode === 'ALREADY_REDEEMED' ? 409 :
      errCode === 'STRIPE_SUB_ACTIVE' ? 409 :
      errCode === 'BUDGET_EXHAUSTED' ? 503 :
      400;
    return res.status(status).json({ ...result, ok: false, vtid: VTID });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} /redeem crash: ${message}`);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message, vtid: VTID });
  }
});

// =============================================================================
// GET /founding-status  — public Founding-campaign progress for the launch banner
// =============================================================================
//
// Returns the active Founding campaign's uses_count + max_uses + code so the
// frontend marketing banner can render real-time scarcity ("X of N spots
// remaining"). Public — no auth required. Returns the code ONLY when the
// campaign is still public (is_active=true AND has_spots).
//
// When the campaign is exhausted or deactivated, we still return shape but
// `code` is null so the frontend banner can hide cleanly.
// =============================================================================

router.get('/founding-status', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await sb()
      .from('redemption_codes')
      .select('code, max_uses, uses_count, is_active, expires_at, campaign, metadata')
      .eq('campaign', 'founding_500')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn(`${LOG_PREFIX} /founding-status query error: ${error.message}`);
      return res.json({ ok: true, active: false, vtid: VTID });
    }
    if (!data) {
      return res.json({ ok: true, active: false, vtid: VTID });
    }

    const row = data as {
      code: string;
      max_uses: number;
      uses_count: number;
      is_active: boolean;
      expires_at: string | null;
      campaign: string;
      metadata: Record<string, unknown> | null;
    };
    const expired = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
    const hasSpots = row.uses_count < row.max_uses;
    const active = row.is_active && hasSpots && !expired;

    return res.json({
      ok: true,
      active,
      uses_count: row.uses_count,
      max_uses: row.max_uses,
      remaining: Math.max(0, row.max_uses - row.uses_count),
      code: active ? row.code : null,
      campaign: row.campaign,
      vtid: VTID,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} /founding-status crash: ${message}`);
    return res.json({ ok: true, active: false, vtid: VTID });
  }
});

// =============================================================================
// POST /webhooks/stripe  — customer-side webhook
// =============================================================================
//
// IMPORTANT: index.ts must register express.raw({type:'application/json'})
// for this path BEFORE express.json() global parser. Pattern mirrors
// '/api/v1/stripe/webhook' for Connect.
// =============================================================================

router.post('/webhooks/stripe', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ error: 'Missing signature' });
  }
  if (!STRIPE_BILLING_WEBHOOK_SECRET) {
    console.error(`${LOG_PREFIX} STRIPE_BILLING_WEBHOOK_SECRET not configured`);
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body as Buffer,
      sig,
      STRIPE_BILLING_WEBHOOK_SECRET
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Webhook signature verification failed: ${message}`);
    return res.status(400).json({ error: `Webhook Error: ${message}` });
  }

  // Idempotency: insert event.id into processed_stripe_events; PK conflict = already handled
  const { error: idemErr } = await sb()
    .from('processed_stripe_events')
    .insert({ event_id: event.id, event_type: event.type });
  if (idemErr) {
    // PK collision: this event was already processed. Acknowledge and skip.
    if (idemErr.code === '23505' || /duplicate key/i.test(idemErr.message)) {
      console.log(`${LOG_PREFIX} Webhook ${event.id} already processed — idempotent skip`);
      return res.json({ received: true, duplicate: true });
    }
    console.error(`${LOG_PREFIX} processed_stripe_events insert error: ${idemErr.message}`);
    return res.status(500).json({ error: 'Idempotency log failed' });
  }

  console.log(`${LOG_PREFIX} Webhook event: ${event.type} (id=${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpserted(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await handleInvoiceFailed(event.data.object as Stripe.Invoice);
        break;
      default:
        console.log(`${LOG_PREFIX} Unhandled event type: ${event.type}`);
    }
    return res.json({ received: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Webhook processing crash: ${message}`);
    // We've already inserted the event_id; Stripe will retry on 5xx. Allowing
    // retry is safer than leaving processed_stripe_events stale.
    await sb().from('processed_stripe_events').delete().eq('event_id', event.id);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// -----------------------------------------------------------------------------
// Webhook handlers
// -----------------------------------------------------------------------------

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const kind = session.metadata?.vitana_kind;
  const userId = session.metadata?.vitana_user_id || session.client_reference_id || undefined;
  const tenantId = session.metadata?.vitana_tenant_id;
  if (!userId || !tenantId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed missing user/tenant metadata; session=${session.id}`);
    return;
  }

  if (kind === 'subscription') {
    // For subscription mode, the subscription object will fire its own
    // customer.subscription.created event. We just record the paywall event.
    await recordPaywallEvent(userId, tenantId, 'subscription', 'upgraded', {
      stripe_session_id: session.id,
      stripe_subscription_id: session.subscription as string | null,
      plan_key: session.metadata?.vitana_plan_key,
      price_key: session.metadata?.vitana_price_key,
    });
    return;
  }

  if (kind === 'credit_pack') {
    const packKey = session.metadata?.vitana_pack_key;
    const creditsStr = session.metadata?.vitana_credits;
    const credits = creditsStr ? parseInt(creditsStr, 10) : 0;
    if (!packKey || credits <= 0) {
      console.warn(`${LOG_PREFIX} credit_pack checkout missing metadata; session=${session.id}`);
      return;
    }

    // Idempotent credit via the existing credit_wallet RPC. source_event_id =
    // session.id so re-delivery never double-credits.
    const { error } = await sb().rpc('credit_wallet', {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_amount: credits,
      p_type: 'purchase',
      p_source: `credit_pack:${packKey}`,
      p_source_event_id: session.id,
      p_description: `Stripe credit pack purchase: ${packKey} (${credits} credits)`,
    });
    if (error) {
      console.error(`${LOG_PREFIX} credit_wallet RPC failed: ${error.message}`);
      throw new Error(`credit_wallet failed: ${error.message}`);
    }
    await recordPaywallEvent(userId, tenantId, 'credit_pack', 'credit_paid', {
      stripe_session_id: session.id,
      pack_key: packKey,
      credits,
    });
    return;
  }

  console.log(`${LOG_PREFIX} checkout.session.completed unknown kind: ${kind}`);
}

async function handleSubscriptionUpserted(stripeSub: Stripe.Subscription): Promise<void> {
  const userId = stripeSub.metadata?.vitana_user_id;
  const tenantId = stripeSub.metadata?.vitana_tenant_id;
  if (!userId || !tenantId) {
    console.warn(`${LOG_PREFIX} subscription.${stripeSub.status} missing user/tenant metadata; sub=${stripeSub.id}`);
    return;
  }

  // Resolve plan_key from the Stripe Price ID
  const stripePriceId = stripeSub.items.data[0]?.price.id;
  let planKey = stripeSub.metadata?.vitana_plan_key ?? 'free';
  let priceKey = stripeSub.metadata?.vitana_price_key ?? null;
  if (stripePriceId) {
    const { data } = await sb()
      .from('subscription_plan_prices')
      .select('plan_key, price_key')
      .eq('stripe_price_id', stripePriceId)
      .maybeSingle();
    if (data) {
      planKey = (data.plan_key as string) || planKey;
      priceKey = (data.price_key as string) || priceKey;
    }
  }

  // Stripe SDK v18+ moved current_period_start / current_period_end onto the
  // SubscriptionItem (subscription.items.data[N]). Fall back to the legacy
  // top-level fields if present, for older API versions.
  const item = stripeSub.items.data[0] as
    | (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number })
    | undefined;
  const legacySub = stripeSub as Stripe.Subscription & {
    current_period_start?: number;
    current_period_end?: number;
  };
  const periodStartUnix = item?.current_period_start ?? legacySub.current_period_start ?? null;
  const periodEndUnix = item?.current_period_end ?? legacySub.current_period_end ?? null;
  const periodStart = periodStartUnix ? new Date(periodStartUnix * 1000).toISOString() : null;
  const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;
  const trialEnd = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null;

  await sb()
    .from('user_subscriptions')
    .upsert(
      {
        tenant_id: tenantId,
        user_id: userId,
        plan_key: planKey,
        price_key: priceKey,
        status: stripeSub.status,
        stripe_customer_id: stripeSub.customer as string,
        stripe_subscription_id: stripeSub.id,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: stripeSub.cancel_at_period_end,
        trial_end: trialEnd,
        last_payment_error: null,
        metadata: { source: 'stripe' },
      },
      { onConflict: 'tenant_id,user_id' }
    );
}

async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription): Promise<void> {
  const userId = stripeSub.metadata?.vitana_user_id;
  const tenantId = stripeSub.metadata?.vitana_tenant_id;
  if (!userId || !tenantId) return;
  await sb()
    .from('user_subscriptions')
    .update({
      status: 'canceled',
      plan_key: 'free',
      price_key: null,
      cancel_at_period_end: false,
      metadata: { source: 'stripe', last_event: 'subscription.deleted' },
    })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
}

// Helper: pull (user_id, tenant_id) out of an invoice. Stripe SDK v18 changed
// the surface but invoice.lines.data[0].metadata still carries
// subscription_data.metadata propagated from the Checkout session. As a
// belt-and-braces fallback, retrieve the subscription explicitly.
async function resolveInvoiceIdentity(
  invoice: Stripe.Invoice
): Promise<{ userId: string | null; tenantId: string | null }> {
  const lineMetadata = invoice.lines.data[0]?.metadata as Record<string, string> | undefined;
  let userId = lineMetadata?.vitana_user_id ?? null;
  let tenantId = lineMetadata?.vitana_tenant_id ?? null;

  // Cast for SDK-version-tolerant access to legacy subscription_details
  const inv = invoice as Stripe.Invoice & {
    subscription_details?: { metadata?: Record<string, string> };
    subscription?: string | Stripe.Subscription | null;
  };
  if (!userId || !tenantId) {
    userId = userId ?? inv.subscription_details?.metadata?.vitana_user_id ?? null;
    tenantId = tenantId ?? inv.subscription_details?.metadata?.vitana_tenant_id ?? null;
  }

  if ((!userId || !tenantId) && inv.subscription) {
    try {
      const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription.id;
      const sub = await getStripe().subscriptions.retrieve(subId);
      userId = userId ?? (sub.metadata?.vitana_user_id as string | undefined) ?? null;
      tenantId = tenantId ?? (sub.metadata?.vitana_tenant_id as string | undefined) ?? null;
    } catch (err) {
      console.warn(`${LOG_PREFIX} resolveInvoiceIdentity: subscription retrieve failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { userId, tenantId };
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const { userId, tenantId } = await resolveInvoiceIdentity(invoice);
  if (!userId || !tenantId) return;
  await sb()
    .from('user_subscriptions')
    .update({ status: 'active', last_payment_error: null })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
}

async function handleInvoiceFailed(invoice: Stripe.Invoice): Promise<void> {
  const { userId, tenantId } = await resolveInvoiceIdentity(invoice);
  if (!userId || !tenantId) return;
  const inv = invoice as Stripe.Invoice & { last_finalization_error?: { message?: string } };
  const lastError = inv.last_finalization_error?.message ?? 'Payment failed';
  await sb()
    .from('user_subscriptions')
    .update({ status: 'past_due', last_payment_error: lastError })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
}

// =============================================================================
// Admin: redemption codes management
// =============================================================================

/**
 * POST /admin/redemption-codes/generate
 *   Body: { campaign: string, count: number, grant_duration_days?: number,
 *           grants_plan?: string, prefix?: string, expires_at?: string }
 *
 *   Generates `count` unique codes of pattern PREFIX-CAMPAIGN-XXXX-XXXX
 *   (base32-ish alphabet, no ambiguous chars). Default grant_duration_days=365
 *   (test-cohort default), grants_plan='premium'.
 *
 *   Returns the generated codes; admin downloads CSV and hand-delivers.
 */
router.post(
  '/admin/redemption-codes/generate',
  requireAuth,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    const identity = req.identity!;
    const body = req.body || {};
    const campaign: string | undefined = body.campaign;
    const count = Math.min(1000, Math.max(1, parseInt(String(body.count ?? '0'), 10) || 0));
    const grantDurationDays = Math.min(730, Math.max(1, parseInt(String(body.grant_duration_days ?? '365'), 10) || 365));
    const grantsPlan: string = typeof body.grants_plan === 'string' ? body.grants_plan : 'premium';
    const prefix: string = typeof body.prefix === 'string' ? body.prefix.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12) || 'VITANA' : 'VITANA';
    const expiresAt: string | null = typeof body.expires_at === 'string' ? body.expires_at : null;

    if (!campaign || typeof campaign !== 'string' || campaign.length < 2) {
      return res.status(400).json({ ok: false, error: 'MISSING_CAMPAIGN' });
    }
    if (count < 1) {
      return res.status(400).json({ ok: false, error: 'INVALID_COUNT' });
    }

    // Validate plan exists
    const { data: planRow } = await sb()
      .from('subscription_plans')
      .select('plan_key')
      .eq('plan_key', grantsPlan)
      .maybeSingle();
    if (!planRow) {
      return res.status(400).json({ ok: false, error: 'PLAN_NOT_FOUND', plan_key: grantsPlan });
    }

    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish base32 (no 0/O/1/I)
    function gen4(): string {
      let out = '';
      const buf = require('crypto').randomBytes(4);
      for (let i = 0; i < 4; i++) {
        out += ALPHABET[buf[i] % ALPHABET.length];
      }
      return out;
    }

    const campaignToken = campaign.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    const generated: Array<{ code: string }> = [];
    const inserts: Array<Record<string, unknown>> = [];
    for (let i = 0; i < count; i++) {
      const code = `${prefix}-${campaignToken}-${gen4()}-${gen4()}`;
      generated.push({ code });
      inserts.push({
        code,
        campaign,
        grants_plan: grantsPlan,
        grant_duration_days: grantDurationDays,
        max_uses: 1,
        uses_count: 0,
        expires_at: expiresAt,
        created_by: identity.user_id,
        is_active: true,
        metadata: { issued_by_admin: identity.user_id, prefix },
      });
    }

    const { error } = await sb().from('redemption_codes').insert(inserts);
    if (error) {
      console.error(`${LOG_PREFIX} admin generate codes failed: ${error.message}`);
      return res.status(500).json({ ok: false, error: 'INSERT_FAILED', message: error.message });
    }

    return res.json({
      ok: true,
      generated: generated.length,
      campaign,
      grants_plan: grantsPlan,
      grant_duration_days: grantDurationDays,
      codes: generated,
      vtid: VTID,
    });
  }
);

/**
 * GET /admin/redemption-codes
 *   Query: ?campaign=...&limit=...&offset=...&include_codes=false
 *
 *   Lists codes per campaign with usage stats. By default `include_codes=false`
 *   so unredeemed codes are not exposed beyond the admin who generated them
 *   (screenshot-leak protection). Set ?include_codes=true to see full code values.
 */
router.get(
  '/admin/redemption-codes',
  requireAuth,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    const campaign = (req.query.campaign as string | undefined) || null;
    const limit = Math.min(500, Math.max(1, parseInt((req.query.limit as string) || '100', 10) || 100));
    const offset = Math.max(0, parseInt((req.query.offset as string) || '0', 10) || 0);
    const includeCodes = String(req.query.include_codes ?? 'false') === 'true';

    let query = sb()
      .from('redemption_codes')
      .select('code, campaign, grants_plan, grant_duration_days, max_uses, uses_count, expires_at, is_active, created_at, created_by, metadata')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (campaign) {
      query = query.eq('campaign', campaign);
    }
    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ ok: false, error: 'QUERY_FAILED', message: error.message });
    }

    const rows = (data || []).map((row) => {
      if (!includeCodes) {
        // Redact the code; show only a hash-prefix so the admin can match to CSV
        const r = row as Record<string, unknown>;
        const codeStr = String(r.code || '');
        const masked = codeStr.length > 8 ? `${codeStr.slice(0, 7)}…${codeStr.slice(-2)}` : codeStr;
        return { ...row, code: masked };
      }
      return row;
    });

    return res.json({ ok: true, count: rows.length, codes: rows, vtid: VTID });
  }
);

/**
 * PATCH /admin/redemption-codes/:code
 *   Body: { is_active: boolean }
 *
 *   Activate or deactivate a single code (e.g., on leak detection).
 */
router.patch(
  '/admin/redemption-codes/:code',
  requireAuth,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    const codeParam = req.params.code;
    const isActive = typeof req.body?.is_active === 'boolean' ? req.body.is_active : null;
    if (isActive === null) {
      return res.status(400).json({ ok: false, error: 'MISSING_IS_ACTIVE' });
    }
    const { data, error } = await sb()
      .from('redemption_codes')
      .update({ is_active: isActive })
      .eq('code', codeParam)
      .select('code, is_active')
      .maybeSingle();
    if (error) {
      return res.status(500).json({ ok: false, error: 'UPDATE_FAILED', message: error.message });
    }
    if (!data) {
      return res.status(404).json({ ok: false, error: 'CODE_NOT_FOUND', code: codeParam });
    }
    return res.json({ ok: true, code: (data as { code: string }).code, is_active: (data as { is_active: boolean }).is_active, vtid: VTID });
  }
);

// =============================================================================
// VTID marker for grep
// =============================================================================
export const _VTID = VTID;
export default router;

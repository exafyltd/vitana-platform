/**
 * Wallet Stripe webhook handler — VTID-03201
 *
 * Strict signature verification (mirrors stripe-connect-webhook.ts, NOT the
 * soft-verify in payments-stripe-webhook.ts). Subscribed to:
 *
 *   checkout.session.completed         → credit wallet (primary path)
 *   checkout.session.expired           → mark deposit expired
 *   checkout.session.async_payment_failed → mark deposit failed
 *   payment_intent.succeeded           → reconciliation path (idempotent)
 *   payment_intent.payment_failed      → mark deposit failed
 *
 * Idempotency:
 *   1. stripe_webhook_events.stripe_event_id unique — first gate against
 *      Stripe redelivery.
 *   2. credit_deposit RPC's UNIQUE(reference, entry_type) — structural
 *      guard against double-credit if a different event for the same
 *      deposit slips past gate 1.
 *
 * Mount: /api/v1/stripe (raw-body middleware is already applied to
 *        /api/v1/stripe/webhook in index.ts).
 */

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getSupabase } from '../lib/supabase';
import { getWalletStripe, getWalletWebhookSecret } from '../services/wallet/stripe-client';
import { decodeCheckoutMetadata } from '../services/wallet/checkout-metadata';
import { finalizeDeposit, markDepositTerminal } from '../services/wallet/deposit-service';

const router = Router();

const HANDLED_EVENT_TYPES = new Set<string>([
  'checkout.session.completed',
  'checkout.session.expired',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
]);

/**
 * POST /api/v1/stripe/webhook/wallet
 */
router.post('/webhook/wallet', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  const secret = getWalletWebhookSecret();

  if (!sig) {
    console.error('[wallet-webhook] missing stripe-signature header');
    return res.status(400).json({ error: 'Missing signature' });
  }
  if (!secret) {
    console.error('[wallet-webhook] STRIPE_WALLET_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event: Stripe.Event;
  try {
    event = getWalletStripe().webhooks.constructEvent(req.body, sig, secret);
  } catch (err: any) {
    console.error('[wallet-webhook] signature verification failed:', err?.message ?? err);
    return res.status(400).json({ error: `Webhook Error: ${err?.message ?? 'invalid signature'}` });
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.error('[wallet-webhook] supabase unavailable; cannot persist event');
    return res.status(500).json({ error: 'Gateway misconfigured' });
  }

  // Idempotency gate 1: insert into stripe_webhook_events. unique(stripe_event_id)
  // makes a redelivery fail with code 23505 — we return 200 immediately so Stripe
  // stops retrying. The event was already processed.
  const { error: insertErr } = await supabase
    .from('stripe_webhook_events')
    .insert({
      stripe_event_id: event.id,
      event_type: event.type,
      source: 'wallet',
      payload: event as unknown as Record<string, unknown>,
    });

  if (insertErr) {
    const code = (insertErr as { code?: string }).code;
    if (code === '23505') {
      // Already processed on a prior delivery.
      console.log(`[wallet-webhook] duplicate event ${event.id} (${event.type}) — ack 200`);
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.error('[wallet-webhook] failed to insert event row:', insertErr.message);
    return res.status(500).json({ error: 'Event persistence failed' });
  }

  // Skip event types we don't care about, but still mark processed.
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    console.log(`[wallet-webhook] ignoring event type ${event.type}`);
    await markEventProcessed(event.id, null);
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    await handleWalletEvent(event);
    await markEventProcessed(event.id, null);
    return res.status(200).json({ received: true });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(`[wallet-webhook] processing failed for ${event.id} (${event.type}):`, message);
    await markEventProcessed(event.id, message);
    // 500 → Stripe will retry. Idempotency guards make retries safe.
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function handleWalletEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = decodeCheckoutMetadata(session.metadata as Record<string, string> | null);
      if (!metadata) {
        console.warn(
          `[wallet-webhook] checkout.session.completed ${session.id} has no wallet metadata; skipping`
        );
        return;
      }
      // Stripe sends 'complete' with payment_status='paid' on successful card
      // charges. async payment methods may complete later via payment_intent.*
      if (session.payment_status !== 'paid') {
        console.log(
          `[wallet-webhook] session ${session.id} completed but payment_status=${session.payment_status}; waiting for payment_intent`
        );
        return;
      }
      const piId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id ?? null;
      const result = await finalizeDeposit(metadata.deposit_id, event.id, piId);
      console.log(
        `[wallet-webhook] credited deposit ${metadata.deposit_id} (duplicate=${result.duplicate ?? false}, balance_minor=${result.balance_minor})`
      );
      return;
    }

    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = decodeCheckoutMetadata(session.metadata as Record<string, string> | null);
      if (metadata) {
        await markDepositTerminal(metadata.deposit_id, 'expired', 'checkout_session_expired');
      }
      return;
    }

    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = decodeCheckoutMetadata(session.metadata as Record<string, string> | null);
      if (metadata) {
        await markDepositTerminal(
          metadata.deposit_id,
          'failed',
          'checkout_async_payment_failed'
        );
      }
      return;
    }

    case 'payment_intent.succeeded': {
      // Reconciliation path. checkout.session.completed is the primary fulfillment
      // event; this path catches async payment methods that confirm post-redirect.
      const pi = event.data.object as Stripe.PaymentIntent;
      const supabase = getSupabase();
      if (!supabase) return;
      const { data: deposit } = await supabase
        .from('wallet_deposits')
        .select('id')
        .eq('stripe_payment_intent_id', pi.id)
        .maybeSingle();
      if (!deposit) {
        console.log(`[wallet-webhook] payment_intent.succeeded ${pi.id} has no matching deposit; skipping`);
        return;
      }
      const result = await finalizeDeposit((deposit as { id: string }).id, event.id, pi.id);
      console.log(
        `[wallet-webhook] PI-path credited deposit ${(deposit as { id: string }).id} (duplicate=${result.duplicate ?? false})`
      );
      return;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const supabase = getSupabase();
      if (!supabase) return;
      const { data: deposit } = await supabase
        .from('wallet_deposits')
        .select('id')
        .eq('stripe_payment_intent_id', pi.id)
        .maybeSingle();
      if (deposit) {
        const reason = pi.last_payment_error?.code || pi.last_payment_error?.type || 'payment_intent_failed';
        await markDepositTerminal((deposit as { id: string }).id, 'failed', reason);
      }
      return;
    }
  }
}

async function markEventProcessed(stripeEventId: string, error: string | null): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase
    .from('stripe_webhook_events')
    .update({
      processed_at: new Date().toISOString(),
      processing_error: error,
    })
    .eq('stripe_event_id', stripeEventId);
}

export default router;

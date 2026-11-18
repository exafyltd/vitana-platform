/**
 * VTID-DANCE-D6: Stripe Connect webhook scaffold.
 *
 * Receives Stripe webhook events (payment_intent.succeeded, charge.refunded,
 * transfer.paid, etc.) and updates the corresponding service_payments row's
 * state.
 *
 * VTID-05730 (plan gateway-critical-route-auth, lane stripe-dance-signature):
 * every event must carry a valid Stripe signature. index.ts mounts
 * express.raw() for /webhooks/stripe-dance (before express.json()), and the
 * handler verifies the exact bytes with Stripe.webhooks.constructEvent and
 * STRIPE_WEBHOOK_SECRET, as routes/stripe-connect-webhook.ts does.
 * Secret unset → 500 WEBHOOK_NOT_CONFIGURED; header missing → 400
 * MISSING_SIGNATURE; verification failure → 400 BAD_SIGNATURE. Nothing is
 * read or written before verification succeeds, and the state logic uses
 * the verified event only. Unsigned payloads are no longer accepted.
 */

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import * as repo from './payments-stripe-webhook-repository';

const router = Router();

interface StripeEvent {
  id: string;
  type: string;
  data: { object: any };
  created: number;
}

// Map Stripe event type → next service_payments.state.
const STATE_BY_EVENT: Record<string, string> = {
  'payment_intent.created':           'pending',
  'payment_intent.requires_action':   'pending',
  'payment_intent.processing':        'pending',
  'payment_intent.succeeded':         'authorized',
  'payment_intent.canceled':          'cancelled',
  'payment_intent.payment_failed':    'cancelled',
  'charge.captured':                  'captured',
  'charge.refunded':                  'refunded',
  'transfer.paid':                    'released',
  'charge.dispute.created':           'disputed',
};

router.post('/webhooks/stripe-dance', async (req: Request, res: Response) => {
  const expectedSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error('[stripe-dance webhook] STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ ok: false, error: 'WEBHOOK_NOT_CONFIGURED' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ ok: false, error: 'MISSING_SIGNATURE' });
  }

  // The signature covers the exact bytes Stripe sent; a parsed/re-serialized
  // body cannot be verified, so anything but the raw body is refused.
  const rawBody: unknown = req.body;
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
    return res.status(400).json({ ok: false, error: 'BAD_SIGNATURE' });
  }

  let event: StripeEvent;
  try {
    // Static helper: signature verification needs only the signing secret,
    // not STRIPE_SECRET_KEY (stripe@20 exposes Stripe.webhooks statically).
    event = Stripe.webhooks.constructEvent(rawBody, sig, expectedSecret) as unknown as StripeEvent;
  } catch (err: any) {
    console.error('[stripe-dance webhook] Signature verification failed:', err?.message);
    return res.status(400).json({ ok: false, error: 'BAD_SIGNATURE' });
  }

  if (!event || typeof event.type !== 'string') {
    return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' });
  }

  const nextState = STATE_BY_EVENT[event.type];
  if (!nextState) {
    // Unknown event — ack so Stripe doesn't retry forever.
    return res.json({ ok: true, ignored: true, type: event.type });
  }

  const piId = (event.data.object?.id as string)
    || (event.data.object?.payment_intent as string)
    || null;

  const supabase = getSupabase();
  if (!supabase || !piId) {
    return res.status(200).json({ ok: true, ack_only: true });
  }

  const { data: payment, error: paymentErr } = await repo.fetchServicePaymentByStripePiId(supabase, piId);

  if (paymentErr) {
    // Distinct from "unknown payment_intent" below: this is a real query
    // failure, not a benign lookup miss — must not be mislabeled as info,
    // or the service_payments row silently never advances and nobody is
    // alerted that anything went wrong.
    await emitOasisEvent({
      vtid: 'VTID-DANCE-D6',
      type: 'voice.message.sent',
      source: 'stripe-webhook',
      status: 'error',
      message: `Stripe webhook lookup failed for payment_intent ${piId}: ${paymentErr.message}`,
      payload: { stripe_event_id: event.id, stripe_event_type: event.type, pi_id: piId, error: paymentErr.message },
      actor_role: 'system',
      surface: 'api',
    });
    return res.status(500).json({ ok: false, error: 'LOOKUP_FAILED' });
  }

  if (!payment) {
    // Could be a new PI we haven't seen yet — log and ack.
    await emitOasisEvent({
      vtid: 'VTID-DANCE-D6',
      type: 'voice.message.sent',
      source: 'stripe-webhook',
      status: 'info',
      message: `Stripe webhook for unknown payment_intent ${piId}: ${event.type}`,
      payload: { stripe_event_id: event.id, stripe_event_type: event.type, pi_id: piId },
      actor_role: 'system',
      surface: 'api',
    });
    return res.json({ ok: true, unknown_pi: true });
  }

  await repo.updateServicePaymentState(supabase, (payment as any).payment_id, nextState);

  await emitOasisEvent({
    vtid: 'VTID-DANCE-D6',
    type: 'voice.message.sent',
    source: 'stripe-webhook',
    status: 'success',
    message: `Stripe ${event.type} → service_payments state ${nextState}`,
    payload: {
      payment_id: (payment as any).payment_id,
      stripe_event_id: event.id,
      stripe_event_type: event.type,
      next_state: nextState,
      payer_vitana_id: (payment as any).payer_vitana_id,
      payee_vitana_id: (payment as any).payee_vitana_id,
    },
    actor_role: 'system',
    surface: 'api',
  });

  return res.json({ ok: true, payment_id: (payment as any).payment_id, state: nextState });
});

export default router;

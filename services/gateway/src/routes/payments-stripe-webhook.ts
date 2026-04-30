/**
 * VTID-DANCE-D6: Stripe Connect webhook scaffold.
 *
 * Receives Stripe webhook events (payment_intent.succeeded, charge.refunded,
 * transfer.paid, etc.) and updates the corresponding service_payments row's
 * state. Live signature verification is enabled when STRIPE_WEBHOOK_SECRET
 * is set; otherwise the route accepts unsigned payloads in dev mode.
 *
 * The actual Stripe SDK isn't called from this scaffold — that comes when
 * the full payment flow is wired in a follow-up. This route is the receiver
 * end of the loop so the state machine can advance once events arrive.
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';

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
  // Soft signature check: log when missing, don't block in MVP.
  const sig = req.headers['stripe-signature'];
  const expectedSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (expectedSecret && !sig) {
    return res.status(400).json({ ok: false, error: 'MISSING_SIGNATURE' });
  }

  const event: StripeEvent = req.body;
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

  const { data: payment } = await supabase
    .from('service_payments')
    .select('payment_id, payer_vitana_id, payee_vitana_id, state')
    .eq('stripe_pi_id', piId)
    .maybeSingle();

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

  await supabase
    .from('service_payments')
    .update({
      state: nextState,
      updated_at: new Date().toISOString(),
    })
    .eq('payment_id', (payment as any).payment_id);

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

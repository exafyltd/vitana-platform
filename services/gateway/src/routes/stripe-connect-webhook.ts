/**
 * Stripe Connect Webhook Handler
 * VTID-01231: Handle Stripe Connect account updates
 *
 * Webhooks from Stripe when:
 * - Account onboarding completes
 * - Account capabilities change
 * - Account status updates
 */

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';

const router = Router();

// Initialize Stripe lazily to prevent crash when STRIPE_SECRET_KEY is absent (e.g. test env)
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

const STRIPE_CONNECT_WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';

/**
 * Helper: Get Supabase credentials
 */
function getSupabaseCredentials(): { url: string; key: string } | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  return { url: supabaseUrl, key: supabaseKey };
}

/**
 * Helper: Get service token (for webhook use without user JWT)
 */
function getServiceToken(): string {
  return process.env.SUPABASE_SERVICE_ROLE || '';
}

/**
 * Helper: Call a Supabase RPC function with service role token
 */
async function callRpc(
  token: string | null,
  functionName: string,
  params: Record<string, unknown>
): Promise<{ ok: boolean; data?: any; error?: string; message?: string }> {
  const creds = getSupabaseCredentials();
  if (!creds) {
    return { ok: false, error: 'Gateway misconfigured' };
  }

  try {
    const response = await fetch(`${creds.url}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': creds.key,
        'Authorization': `Bearer ${token || ''}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Connect Webhook] RPC ${functionName} failed: ${response.status} - ${errorText}`);
      return { ok: false, error: `RPC failed: ${response.status}` };
    }

    const data = await response.json() as Record<string, unknown>;
    return { ok: true, data };
  } catch (err: any) {
    console.error(`[Connect Webhook] RPC ${functionName} error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * POST /api/v1/stripe/webhook/connect
 * Handle Stripe Connect webhooks
 */
router.post('/webhook/connect', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    console.error('[Connect Webhook] Missing signature');
    return res.status(400).json({ error: 'Missing signature' });
  }

  if (!STRIPE_CONNECT_WEBHOOK_SECRET) {
    console.error('[Connect Webhook] Webhook secret not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_CONNECT_WEBHOOK_SECRET
    );
  } catch (err: any) {
    console.error('[Connect Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log('[Connect Webhook] Event received:', event.type);

  try {
    const serviceToken = getServiceToken();

    switch (event.type) {
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;

        console.log('[Connect Webhook] Account updated:', {
          account_id: account.id,
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
        });

        // Update database with account status
        const updateResult = await callRpc(serviceToken, 'update_user_stripe_status', {
          p_stripe_account_id: account.id,
          p_charges_enabled: account.charges_enabled || false,
          p_payouts_enabled: account.payouts_enabled || false,
        });

        if (!updateResult.ok) {
          console.error('[Connect Webhook] Failed to update DB:', updateResult.error);
        } else {
          console.log('[Connect Webhook] Account status updated in DB');
        }
        break;
      }

      case 'account.external_account.created':
      case 'account.external_account.updated': {
        const externalAccount = event.data.object;
        console.log('[Connect Webhook] External account updated:', externalAccount.id);
        // Optionally track payout methods
        break;
      }

      default:
        console.log('[Connect Webhook] Unhandled event type:', event.type);
    }

    return res.json({ received: true });
  } catch (error: any) {
    console.error('[Connect Webhook] Processing error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;

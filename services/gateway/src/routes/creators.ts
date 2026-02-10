/**
 * Creator Onboarding & Payment Routes
 * VTID-01231: Stripe Connect Express Backend
 *
 * Enables creators to:
 * 1. Onboard to Stripe Connect Express
 * 2. Check their payment status
 * 3. Receive 90% of room revenue (10% to Vitana)
 */

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';

const router = Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://vitana-lovable-vers1.lovable.app';

// Rate limiting for onboarding endpoint (prevent abuse)
const onboardRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 attempts per hour per IP
  message: {
    ok: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many onboarding requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Helper: Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

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
 * Helper: Call a Supabase RPC function with user token
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
      console.error(`[Creator API] RPC ${functionName} failed: ${response.status} - ${errorText}`);
      return { ok: false, error: `RPC failed: ${response.status}` };
    }

    const data = await response.json() as Record<string, unknown>;
    return { ok: true, data };
  } catch (err: any) {
    console.error(`[Creator API] RPC ${functionName} error:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * POST /api/v1/creators/onboard
 * Start Stripe Connect Express onboarding for a creator
 */
router.post('/onboard', onboardRateLimit, async (req: Request, res: Response) => {
  try {
    const token = getBearerToken(req);
    const { return_url, refresh_url } = req.body;

    // VTID-01230: Security Hardening - Validate return/refresh URLs
    const allowedOrgin = FRONTEND_URL;
    const validateUrl = (url?: string) => {
      if (!url) return true;
      try {
        const u = new URL(url);
        // Only allow same origin as FRONTEND_URL or window.location.origin (if provided by client)
        return u.origin === new URL(allowedOrgin).origin;
      } catch {
        return false;
      }
    };

    if (!validateUrl(return_url) || !validateUrl(refresh_url)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REDIRECT_URL',
        message: 'Redirect URL must belong to the approved frontend domain'
      });
    }

    console.log('[Creator Onboard] Starting onboarding flow');

    // Check if user already has Stripe account
    const statusResult = await callRpc(token, 'get_user_stripe_status', {});

    if (statusResult.data && statusResult.data.length > 0) {
      const existingAccount = statusResult.data[0].stripe_account_id;

      if (existingAccount) {
        console.log('[Creator Onboard] User already has account:', existingAccount);

        // Generate new onboarding link for existing account
        const accountLink = await stripe.accountLinks.create({
          account: existingAccount,
          refresh_url: refresh_url || `${FRONTEND_URL}/creator/onboard`,
          return_url: return_url || `${FRONTEND_URL}/creator/onboarded`,
          type: 'account_onboarding',
        });

        // VTID-01230: Validate Stripe URL before returning
        if (!accountLink.url.startsWith('https://connect.stripe.com/')) {
          throw new Error('Invalid Stripe URL returned');
        }

        return res.json({
          ok: true,
          onboarding_url: accountLink.url,
          existing_account: true,
        });
      }
    }

    // Create new Stripe Express Connected Account
    const account = await stripe.accounts.create({
      type: 'express',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual', // Most creators are individuals
    });

    console.log('[Creator Onboard] Created account:', account.id);

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: refresh_url || `${FRONTEND_URL}/creator/onboard`,
      return_url: return_url || `${FRONTEND_URL}/creator/onboarded`,
      type: 'account_onboarding',
    });

    // VTID-01230: Validate Stripe URL before returning
    if (!accountLink.url.startsWith('https://connect.stripe.com/')) {
      throw new Error('Invalid Stripe URL returned');
    }

    // Store Stripe account ID in database
    const updateResult = await callRpc(token, 'update_user_stripe_account', {
      p_stripe_account_id: account.id,
    });

    if (!updateResult.ok) {
      console.error('[Creator Onboard] Failed to store account ID:', updateResult.error);
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: 'Failed to save account information',
      });
    }

    return res.json({
      ok: true,
      onboarding_url: accountLink.url,
      account_id: account.id,
    });
  } catch (error: any) {
    console.error('[Creator Onboard] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'ONBOARDING_FAILED',
      message: error.message || 'Failed to start onboarding',
    });
  }
});

/**
 * GET /api/v1/creators/status
 * Get creator's Stripe Connect status
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const token = getBearerToken(req);

    const result = await callRpc(token, 'get_user_stripe_status', {});

    if (!result.ok || !result.data || result.data.length === 0) {
      return res.json({
        ok: true,
        stripe_account_id: null,
        charges_enabled: false,
        payouts_enabled: false,
        onboarded_at: null,
      });
    }

    const status = result.data[0];

    return res.json({
      ok: true,
      stripe_account_id: status.stripe_account_id,
      charges_enabled: status.stripe_charges_enabled,
      payouts_enabled: status.stripe_payouts_enabled,
      onboarded_at: status.stripe_onboarded_at,
    });
  } catch (error: any) {
    console.error('[Creator Status] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'STATUS_FAILED',
      message: error.message || 'Failed to fetch status',
    });
  }
});

/**
 * GET /api/v1/creators/dashboard
 * Get Stripe Express dashboard login link
 */
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const token = getBearerToken(req);

    const statusResult = await callRpc(token, 'get_user_stripe_status', {});

    if (!statusResult.ok || !statusResult.data || statusResult.data.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'NOT_ONBOARDED',
        message: 'Creator has not completed onboarding',
      });
    }

    const stripeAccountId = statusResult.data[0].stripe_account_id;

    if (!stripeAccountId) {
      return res.status(400).json({
        ok: false,
        error: 'NO_ACCOUNT',
        message: 'No Stripe account found',
      });
    }

    // Generate Express dashboard login link
    const loginLink = await stripe.accounts.createLoginLink(stripeAccountId);

    // VTID-01230: Validate Stripe URL before returning
    if (!loginLink.url.startsWith('https://connect.stripe.com/')) {
      throw new Error('Invalid Stripe dashboard URL returned');
    }

    return res.json({
      ok: true,
      dashboard_url: loginLink.url,
    });
  } catch (error: any) {
    console.error('[Creator Dashboard] Error:', error);
    return res.status(500).json({
      ok: false,
      error: 'DASHBOARD_FAILED',
      message: error.message || 'Failed to generate dashboard link',
    });
  }
});

export default router;

/**
 * VTID-03107 · Billing v1 — Paywall middleware
 *
 * Express middleware factory used by every gated route to short-circuit
 * with HTTP 402 when the user has no remaining entitlement.
 *
 * Usage in a route file:
 *
 *   import { requireEntitlement } from '../middleware/paywall';
 *
 *   router.post('/intents',
 *     requireAuth,
 *     requireEntitlement('match_posts'),
 *     async (req, res) => {
 *       // handler runs only if req.entitlement.paywall_action ∈ {allow, soft_counter, deferred, degrade}
 *       const handlerResult = await createIntent(...);
 *       // for the 'allow' / 'soft_counter' / 'degrade' / 'deferred' paths,
 *       // call recordUsage AFTER the handler succeeds:
 *       if (req.entitlement.paywall_action !== 'deferred') {
 *         await recordUsage(...);
 *       }
 *       res.json({ ok: true, ... });
 *     }
 *   );
 *
 * Response shape on 402 (paywall / hard_block):
 *
 *   {
 *     "error": "payment_required",
 *     "paywall": {
 *       "feature": "voice_live_minutes",
 *       "tier": "free",
 *       "quota": 15,
 *       "used": 15,
 *       "remaining": 0,
 *       "reset_at": "2026-06-25T00:00:00Z",
 *       "credit_cost_per_unit": 5,
 *       "user_credit_balance": 250,
 *       "allowed_burn_buckets": ["purchased_credits"],
 *       "credit_option": {
 *         "cost_per_unit": 5,
 *         "balance": 250,
 *         "balance_sufficient_for_one_unit": true,
 *         "endpoint": "/api/v1/billing/credits/spend"
 *       } | null,
 *       "upgrade_url": "/api/v1/billing/checkout/subscription",
 *       "deferred_for_vulnerability": false
 *     }
 *   }
 *
 * D36-aware: when checkEntitlement returns paywall_action='deferred', this
 * middleware silently sets `req.entitlement` and calls next(). The handler
 * MUST treat deferred as "allowed but do not increment usage and do not show
 * a paywall to the user."
 */

import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth-supabase-jwt';
import {
  checkEntitlement,
  type CheckResult,
  type WalletBucket,
} from '../services/entitlement-service';

// Augment AuthenticatedRequest with the entitlement result. Handlers can read
// req.entitlement.quota / .used / .remaining / .paywall_action to render the
// progress indicator + decide whether to degrade.

declare module 'express' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Request {
    entitlement?: CheckResult;
  }
}

const VTID = 'VTID-03107';
const LOG_PREFIX = '[paywall-middleware]';

const SUBSCRIPTION_UPGRADE_URL = '/api/v1/billing/checkout/subscription';
const CREDIT_SPEND_URL          = '/api/v1/billing/credits/spend';

export interface RequireEntitlementOpts {
  /**
   * Requested amount (default 1). For `unit='minutes'` features the caller
   * may pass a non-1 value (e.g. start-of-session reserves 1 minute up front).
   */
  amount?: number;

  /**
   * Skip D36 deferral hook — for admin/system flows that should NEVER be
   * deferred. Default false.
   */
  skipD36?: boolean;

  /**
   * Custom session_id for D36 history tracking. If absent, the middleware
   * uses req.sessionId (which various existing routes set) or undefined.
   */
  sessionIdGetter?: (req: AuthenticatedRequest) => string | undefined;
}

export function requireEntitlement(
  feature: string,
  opts: RequireEntitlementOpts = {}
) {
  return async function paywallGate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const identity = req.identity;
    if (!identity?.user_id || !identity?.tenant_id) {
      // Auth middleware should have already enforced this; defense in depth.
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', feature, vtid: VTID });
      return;
    }

    // Extract bearer token for D36 (it needs the user JWT to read their
    // personal monetization signals under RLS).
    const authHeader = req.headers.authorization || '';
    const authToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;

    const sessionId =
      opts.sessionIdGetter?.(req) ??
      (req as any).sessionId ??
      (req.headers['x-session-id'] as string | undefined);

    let result: CheckResult;
    try {
      result = await checkEntitlement(identity.user_id, identity.tenant_id, feature, {
        amount: opts.amount,
        sessionId,
        authToken,
        skipD36: opts.skipD36,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} checkEntitlement crash for user=${identity.user_id} feature=${feature}: ${message}`);
      // Fail open to a soft path — return 200 with a degraded entitlement
      // marker. We never block the request on infrastructure failure (users
      // get a worse experience than 402-paywall when we have a bug).
      req.entitlement = {
        allowed: true,
        paywall_action: 'allow',
        feature,
        tier: 'unknown',
        quota: -1,
        used: 0,
        remaining: -1,
        reset_at: null,
        windows: [],
        binding_window: 'monthly',
        credit_cost_per_unit: 0,
        user_credit_balance: 0,
        allowed_burn_buckets: ['purchased_credits'] as WalletBucket[],
        deferred_for_vulnerability: false,
      };
      next();
      return;
    }

    // Attach result to req so handlers can read quota/used/remaining + branch
    // on paywall_action='degrade' to switch behavior.
    req.entitlement = result;

    // allow / soft_counter / degrade / deferred → handler runs
    if (
      result.paywall_action === 'allow' ||
      result.paywall_action === 'soft_counter' ||
      result.paywall_action === 'degrade' ||
      result.paywall_action === 'deferred'
    ) {
      next();
      return;
    }

    // paywall / hard_block → 402 with structured body
    const isHardBlock = result.paywall_action === 'hard_block';
    const canPayWithCredits =
      !isHardBlock &&
      result.credit_cost_per_unit > 0 &&
      result.allowed_burn_buckets.length > 0;
    const creditOption = canPayWithCredits
      ? {
          cost_per_unit: result.credit_cost_per_unit,
          balance: result.user_credit_balance,
          balance_sufficient_for_one_unit:
            result.user_credit_balance >= result.credit_cost_per_unit,
          endpoint: CREDIT_SPEND_URL,
        }
      : null;

    res.status(402).json({
      ok: false,
      error: 'payment_required',
      paywall: {
        feature: result.feature,
        tier: result.tier,
        quota: result.quota,
        used: result.used,
        remaining: result.remaining,
        reset_at: result.reset_at,
        credit_cost_per_unit: result.credit_cost_per_unit,
        user_credit_balance: result.user_credit_balance,
        allowed_burn_buckets: result.allowed_burn_buckets,
        credit_option: creditOption,
        upgrade_url: SUBSCRIPTION_UPGRADE_URL,
        deferred_for_vulnerability: false, // never true here (deferred bypasses 402)
        paywall_action: result.paywall_action,
      },
      vtid: VTID,
    });
  };
}

export const _VTID = VTID;

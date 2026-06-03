/**
 * Wallet user-facing routes — VTID-03201
 *
 *   POST /api/v1/wallet/deposits/create
 *   GET  /api/v1/wallet/deposits/:id
 *   GET  /api/v1/wallet/balance
 *   GET  /api/v1/wallet/transactions
 *
 * All routes require an authenticated Supabase JWT (requireAuth middleware).
 * Wallet writes happen ONLY in the webhook handler and service modules;
 * never trust the client to mark a payment successful.
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  createDeposit,
  getDepositForUser,
  DepositServiceError,
} from '../services/wallet/deposit-service';
import {
  getAccountsForUser,
  getTransactionsForUser,
} from '../services/wallet/balance-service';
import { isWalletCurrency } from '../types/wallet';

const router = Router();

// Path-scoped auth (mirrors admin-embeddings-backfill.ts pattern, VTID-02032 lesson).
router.use('/wallet', requireAuth);

/**
 * POST /api/v1/wallet/deposits/create
 * Body: { amount_minor: number, currency: 'EUR' | 'USD' }
 */
router.post('/wallet/deposits/create', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.identity?.user_id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }

    const body = (req.body ?? {}) as { amount_minor?: unknown; currency?: unknown };

    if (typeof body.amount_minor !== 'number' || !Number.isInteger(body.amount_minor)) {
      return res
        .status(400)
        .json({ ok: false, error: 'INVALID_AMOUNT', message: 'amount_minor must be an integer' });
    }
    if (!isWalletCurrency(body.currency)) {
      return res
        .status(400)
        .json({ ok: false, error: 'INVALID_CURRENCY', message: "currency must be 'EUR' or 'USD'" });
    }

    const result = await createDeposit({
      user_id: userId,
      amount_minor: body.amount_minor,
      currency: body.currency,
      email: req.identity?.email ?? null,
    });

    return res.json({
      ok: true,
      deposit_id: result.deposit_id,
      checkout_url: result.checkout_url,
      expires_at: result.expires_at,
    });
  } catch (err: any) {
    if (err instanceof DepositServiceError) {
      return res.status(err.httpStatus).json({
        ok: false,
        error: err.code,
        message: err.message,
      });
    }
    console.error('[wallet] deposits/create failed:', err?.message ?? err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/v1/wallet/deposits/:id
 * Returns the deposit row (own user only). Frontend polls this after the
 * Stripe success redirect to await webhook-driven 'succeeded'.
 */
router.get('/wallet/deposits/:id', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
  const deposit = await getDepositForUser(req.params.id, userId);
  if (!deposit) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  }
  return res.json({
    ok: true,
    deposit: {
      id: deposit.id,
      amount_minor: deposit.amount_minor,
      currency: deposit.currency,
      status: deposit.status,
      failure_reason: deposit.failure_reason,
      created_at: deposit.created_at,
      updated_at: deposit.updated_at,
    },
  });
});

/**
 * GET /api/v1/wallet/balance
 * Returns array of accounts (one per currency).
 */
router.get('/wallet/balance', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
  const accounts = await getAccountsForUser(userId);
  return res.json({
    ok: true,
    accounts: accounts.map((a) => ({
      currency: a.currency,
      balance_minor: a.balance_minor,
      status: a.status,
      updated_at: a.updated_at,
    })),
  });
});

/**
 * GET /api/v1/wallet/transactions?currency=EUR&limit=20&cursor=<iso>
 */
router.get('/wallet/transactions', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const currencyParam = req.query.currency;
  const currency =
    typeof currencyParam === 'string' && isWalletCurrency(currencyParam) ? currencyParam : undefined;

  const limitParam = req.query.limit;
  const limit =
    typeof limitParam === 'string' && /^\d+$/.test(limitParam) ? parseInt(limitParam, 10) : 20;

  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

  const page = await getTransactionsForUser({ user_id: userId, currency, limit, cursor });

  return res.json({
    ok: true,
    entries: page.entries.map((e) => ({
      id: e.id,
      entry_type: e.entry_type,
      direction: e.direction,
      amount_minor: e.amount_minor,
      currency: e.currency,
      description: e.description,
      created_at: e.created_at,
    })),
    next_cursor: page.next_cursor,
  });
});

export default router;

/**
 * Wallet admin routes — VTID-03249
 *
 * Internal money-movement endpoints called by the cart and Vitanaland
 * Marketplace services, and by ops tooling. Behind requireExafyAdmin so
 * only operator / service identities can hit them today; cart/marketplace
 * services running in the same gateway codebase should prefer the in-process
 * import path (services/wallet/spend-earning-service.ts) instead of HTTP.
 *
 * These do NOT replace the user-facing /api/v1/wallet/* routes (balance,
 * transactions, deposits). Those stay user-JWT-only. These admin routes are
 * for "the system spends/credits on behalf of a transaction".
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  debitWalletForSpend,
  creditWalletForEarning,
  type SpendEarningReferenceType,
} from '../services/wallet/spend-earning-service';
import { isWalletCurrency } from '../types/wallet';

const router = Router();

// Path-scoped auth (mirrors admin-embeddings-backfill.ts, VTID-02032 lesson).
router.use('/wallet/admin', requireAuth, requireExafyAdmin);

const ALLOWED_REFERENCE_TYPES: ReadonlySet<string> = new Set<SpendEarningReferenceType>([
  'cart_checkout',
  'marketplace_order',
  'marketplace_earning',
  'live_room_tip',
  'manual',
]);

interface AdminMovementBody {
  account_id?: unknown;
  amount_minor?: unknown;
  currency?: unknown;
  reference_type?: unknown;
  reference_id?: unknown;
  description?: unknown;
  metadata?: unknown;
}

function validateMovementBody(body: AdminMovementBody): { ok: true } | { ok: false; error: string; message?: string } {
  if (typeof body.account_id !== 'string' || body.account_id.length === 0) {
    return { ok: false, error: 'INVALID_ACCOUNT_ID' };
  }
  if (typeof body.amount_minor !== 'number' || !Number.isInteger(body.amount_minor) || body.amount_minor <= 0) {
    return { ok: false, error: 'INVALID_AMOUNT' };
  }
  if (!isWalletCurrency(body.currency)) {
    return { ok: false, error: 'INVALID_CURRENCY' };
  }
  if (typeof body.reference_type !== 'string' || !ALLOWED_REFERENCE_TYPES.has(body.reference_type)) {
    return { ok: false, error: 'INVALID_REFERENCE_TYPE', message: `must be one of: ${Array.from(ALLOWED_REFERENCE_TYPES).join(', ')}` };
  }
  if (typeof body.reference_id !== 'string' || body.reference_id.length === 0) {
    return { ok: false, error: 'INVALID_REFERENCE_ID' };
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return { ok: false, error: 'INVALID_DESCRIPTION' };
  }
  if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) {
    return { ok: false, error: 'INVALID_METADATA' };
  }
  return { ok: true };
}

/**
 * POST /api/v1/wallet/admin/spend
 * Body: { account_id, amount_minor, currency, reference_type, reference_id, description?, metadata? }
 */
router.post('/wallet/admin/spend', async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as AdminMovementBody;
  const validation = validateMovementBody(body);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.error, message: validation.message });
  }

  const result = await debitWalletForSpend({
    account_id: body.account_id as string,
    amount_minor: body.amount_minor as number,
    currency: body.currency as 'EUR' | 'USD',
    reference_type: body.reference_type as SpendEarningReferenceType,
    reference_id: body.reference_id as string,
    description: body.description as string | undefined,
    metadata: body.metadata as Record<string, unknown> | undefined,
  });

  if (!result.ok) {
    const status = httpStatusForMovementError(result.error);
    return res.status(status).json(result);
  }
  return res.json(result);
});

/**
 * POST /api/v1/wallet/admin/credit
 * Body: same shape as /spend (typically reference_type='marketplace_earning')
 */
router.post('/wallet/admin/credit', async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as AdminMovementBody;
  const validation = validateMovementBody(body);
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.error, message: validation.message });
  }

  const result = await creditWalletForEarning({
    account_id: body.account_id as string,
    amount_minor: body.amount_minor as number,
    currency: body.currency as 'EUR' | 'USD',
    reference_type: body.reference_type as SpendEarningReferenceType,
    reference_id: body.reference_id as string,
    description: body.description as string | undefined,
    metadata: body.metadata as Record<string, unknown> | undefined,
  });

  if (!result.ok) {
    const status = httpStatusForMovementError(result.error);
    return res.status(status).json(result);
  }
  return res.json(result);
});

function httpStatusForMovementError(code: string): number {
  switch (code) {
    case 'ACCOUNT_NOT_FOUND':
      return 404;
    case 'INSUFFICIENT_BALANCE':
      return 409;
    case 'ACCOUNT_NOT_ACTIVE':
    case 'CURRENCY_MISMATCH':
      return 409;
    case 'INVALID_AMOUNT':
    case 'INVALID_CURRENCY':
    case 'INVALID_REFERENCE':
      return 400;
    case 'GATEWAY_MISCONFIGURED':
    case 'RPC_FAILED':
    default:
      return 500;
  }
}

export default router;

/**
 * Wallet spend + earning service — VTID-03249
 *
 * The cart and Vitanaland Marketplace services call these functions when
 * money moves through the wallet. Both wrap the same-named DB RPCs, which
 * own the transactional integrity (SELECT FOR UPDATE → ledger insert →
 * balance update) and idempotency.
 *
 * Callers in this codebase: import directly and use service-role supabase.
 * Out-of-process callers: use the gateway routes at /api/v1/wallet/admin/*.
 *
 * Never INSERT into wallet_ledger_entries directly from a feature module.
 * Always go through these helpers (or the RPCs) so the chokepoint stays
 * single-sourced for audit, idempotency, and future invariants.
 */

import { getSupabase } from '../../lib/supabase';
import type { WalletCurrency } from '../../types/wallet';

export type SpendEarningReferenceType =
  | 'cart_checkout'
  | 'marketplace_order'
  | 'marketplace_earning'
  | 'live_room_tip'
  | 'manual';

export interface SpendInput {
  account_id: string;
  amount_minor: number;
  currency: WalletCurrency;
  reference_type: SpendEarningReferenceType;
  reference_id: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface EarningInput {
  account_id: string;
  amount_minor: number;
  currency: WalletCurrency;
  reference_type: SpendEarningReferenceType;
  reference_id: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export type WalletMovementErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_REFERENCE'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_BALANCE'
  | 'GATEWAY_MISCONFIGURED'
  | 'RPC_FAILED';

export interface WalletMovementSuccess {
  ok: true;
  duplicate: boolean;
  balance_minor: number;
  currency: WalletCurrency;
  ledger_entry_id?: string;
}

export interface WalletMovementError {
  ok: false;
  error: WalletMovementErrorCode;
  message?: string;
  // Additional context the RPC may return for specific errors:
  balance_minor?: number;
  required_minor?: number;
  account_currency?: string;
  requested_currency?: string;
  status?: string;
}

export type WalletMovementResult = WalletMovementSuccess | WalletMovementError;

export async function debitWalletForSpend(input: SpendInput): Promise<WalletMovementResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { ok: false, error: 'GATEWAY_MISCONFIGURED', message: 'Supabase not configured' };
  }

  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor <= 0) {
    return { ok: false, error: 'INVALID_AMOUNT' };
  }

  const { data, error } = await supabase.rpc('debit_wallet_for_spend', {
    p_account_id: input.account_id,
    p_amount_minor: input.amount_minor,
    p_currency: input.currency,
    p_reference_type: input.reference_type,
    p_reference_id: input.reference_id,
    p_description: input.description ?? null,
    p_metadata: input.metadata ?? {},
  });

  if (error) {
    console.error('[wallet/spend-earning] debit_wallet_for_spend RPC failed:', error.message);
    return { ok: false, error: 'RPC_FAILED', message: error.message };
  }
  return data as WalletMovementResult;
}

export async function creditWalletForEarning(input: EarningInput): Promise<WalletMovementResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { ok: false, error: 'GATEWAY_MISCONFIGURED', message: 'Supabase not configured' };
  }

  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor <= 0) {
    return { ok: false, error: 'INVALID_AMOUNT' };
  }

  const { data, error } = await supabase.rpc('credit_wallet_for_earning', {
    p_account_id: input.account_id,
    p_amount_minor: input.amount_minor,
    p_currency: input.currency,
    p_reference_type: input.reference_type,
    p_reference_id: input.reference_id,
    p_description: input.description ?? null,
    p_metadata: input.metadata ?? {},
  });

  if (error) {
    console.error('[wallet/spend-earning] credit_wallet_for_earning RPC failed:', error.message);
    return { ok: false, error: 'RPC_FAILED', message: error.message };
  }
  return data as WalletMovementResult;
}

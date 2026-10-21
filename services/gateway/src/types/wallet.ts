/**
 * Wallet types — VTID-03201
 *
 * Money is integer minor units (cents). Never floats.
 */

export type WalletCurrency = 'EUR' | 'USD';

export type WalletAccountStatus = 'active' | 'frozen' | 'closed';

export type DepositStatus =
  | 'created'
  | 'checkout_started'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'expired';

export type LedgerEntryType =
  | 'deposit_completed'
  | 'service_spend'
  | 'manual_adjustment'
  | 'refund_debit';

export type LedgerDirection = 'credit' | 'debit';

export interface WalletAccount {
  id: string;
  user_id: string;
  currency: WalletCurrency;
  balance_minor: number;
  status: WalletAccountStatus;
  created_at: string;
  updated_at: string;
}

export interface WalletDeposit {
  id: string;
  user_id: string;
  account_id: string;
  amount_minor: number;
  currency: WalletCurrency;
  status: DepositStatus;
  idempotency_key: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  failure_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WalletLedgerEntry {
  id: string;
  account_id: string;
  user_id: string;
  entry_type: LedgerEntryType;
  direction: LedgerDirection;
  amount_minor: number;
  currency: WalletCurrency;
  reference_type: string;
  reference_id: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateDepositRequest {
  amount_minor: number;
  currency: WalletCurrency;
}

export interface CreateDepositResponse {
  ok: true;
  deposit_id: string;
  checkout_url: string;
  expires_at: string;
}

export interface WalletErrorResponse {
  ok: false;
  error: string;
  message?: string;
}

export interface CreditDepositRpcResult {
  ok: boolean;
  duplicate?: boolean;
  balance_minor?: number;
  currency?: WalletCurrency;
  error?: string;
  status?: string;
}

export function isWalletCurrency(v: unknown): v is WalletCurrency {
  return v === 'EUR' || v === 'USD';
}

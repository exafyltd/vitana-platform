/**
 * Wallet deposit service — VTID-03201
 *
 * Owns:
 *   - createDeposit: insert pending deposit row + create Stripe Checkout Session
 *   - finalizeDeposit: invoke credit_deposit RPC after webhook confirms payment
 *   - markDepositFailed / markDepositCanceled / markDepositExpired
 *
 * All writes go through the service-role Supabase client. Frontend NEVER
 * writes to wallet_deposits, wallet_ledger_entries, or wallet_accounts.
 */

import { randomUUID } from 'crypto';
import type Stripe from 'stripe';
import { getSupabase } from '../../lib/supabase';
import { getWalletStripe, getAppBaseUrl, getEnvironmentTag } from './stripe-client';
import {
  encodeCheckoutMetadata,
  CHECKOUT_METADATA_SCHEMA_VERSION,
} from './checkout-metadata';
import type {
  WalletCurrency,
  WalletDeposit,
  CreditDepositRpcResult,
} from '../../types/wallet';

const CHECKOUT_EXPIRY_MINUTES = 30;

export interface CreateDepositInput {
  user_id: string;
  amount_minor: number;
  currency: WalletCurrency;
  email: string | null;
}

export interface CreateDepositResult {
  deposit_id: string;
  checkout_url: string;
  expires_at: string;
}

export class DepositServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
    public stripeError?: unknown
  ) {
    super(message);
    this.name = 'DepositServiceError';
  }
}

/**
 * Create a deposit intent and a Stripe Checkout Session.
 *
 * Order matters: insert deposit row FIRST (so we have a stable deposit_id to
 * stamp into Stripe metadata), then create the Checkout Session, then update
 * the deposit row with the Stripe IDs. If Stripe rejects (e.g. amount below
 * its minimum), we mark the deposit failed so it doesn't sit forever in
 * `created`.
 */
export async function createDeposit(input: CreateDepositInput): Promise<CreateDepositResult> {
  const supabase = getSupabase();
  if (!supabase) {
    throw new DepositServiceError('GATEWAY_MISCONFIGURED', 'Supabase not configured', 500);
  }

  if (!Number.isInteger(input.amount_minor) || input.amount_minor <= 0) {
    throw new DepositServiceError(
      'INVALID_AMOUNT',
      'amount_minor must be a positive integer'
    );
  }
  if (!Number.isSafeInteger(input.amount_minor)) {
    throw new DepositServiceError('INVALID_AMOUNT', 'amount_minor exceeds safe integer range');
  }

  // Find the user's account for this currency. Trigger should have provisioned
  // it at signup; if missing, provision lazily (defensive — never block the user).
  const { data: account, error: accountErr } = await supabase
    .from('wallet_accounts')
    .select('id, status')
    .eq('user_id', input.user_id)
    .eq('currency', input.currency)
    .maybeSingle();

  if (accountErr) {
    throw new DepositServiceError('DB_ERROR', `account lookup failed: ${accountErr.message}`, 500);
  }

  let accountId: string;
  if (!account) {
    const { data: created, error: createErr } = await supabase
      .from('wallet_accounts')
      .insert({ user_id: input.user_id, currency: input.currency })
      .select('id')
      .single();
    if (createErr || !created) {
      throw new DepositServiceError(
        'ACCOUNT_PROVISION_FAILED',
        `could not provision wallet account: ${createErr?.message ?? 'unknown'}`,
        500
      );
    }
    accountId = (created as { id: string }).id;
  } else {
    if (account.status !== 'active') {
      throw new DepositServiceError(
        'ACCOUNT_NOT_ACTIVE',
        `wallet account is ${account.status}`,
        409
      );
    }
    accountId = (account as { id: string }).id;
  }

  // Insert deposit row in 'created' state.
  const idempotencyKey = randomUUID();
  const { data: deposit, error: depositErr } = await supabase
    .from('wallet_deposits')
    .insert({
      user_id: input.user_id,
      account_id: accountId,
      amount_minor: input.amount_minor,
      currency: input.currency,
      status: 'created',
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .single();

  if (depositErr || !deposit) {
    throw new DepositServiceError(
      'DEPOSIT_CREATE_FAILED',
      `deposit insert failed: ${depositErr?.message ?? 'unknown'}`,
      500
    );
  }
  const depositId = (deposit as { id: string }).id;

  // Create the Stripe Checkout Session.
  const baseUrl = getAppBaseUrl();
  const expiresAtMs = Date.now() + CHECKOUT_EXPIRY_MINUTES * 60 * 1000;
  const stripeExpiresAt = Math.floor(expiresAtMs / 1000);

  let session: Stripe.Checkout.Session;
  try {
    session = await getWalletStripe().checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amount_minor,
              product_data: { name: 'Vitana wallet top-up' },
            },
          },
        ],
        customer_email: input.email ?? undefined,
        success_url: `${baseUrl}/wallet/deposit/success?deposit_id=${depositId}`,
        cancel_url: `${baseUrl}/wallet/deposit/canceled?deposit_id=${depositId}`,
        expires_at: stripeExpiresAt,
        metadata: encodeCheckoutMetadata({
          schema_version: CHECKOUT_METADATA_SCHEMA_VERSION,
          vitana_user_id: input.user_id,
          account_id: accountId,
          deposit_id: depositId,
          currency: input.currency,
          environment: getEnvironmentTag(),
        }),
      },
      { idempotencyKey }
    );
  } catch (err: any) {
    // Surface Stripe's own minimum-amount / card-rejected error to the caller
    // instead of silently leaving a stuck 'created' row.
    const failureReason = err?.code || err?.type || 'stripe_session_create_failed';
    await supabase
      .from('wallet_deposits')
      .update({
        status: 'failed',
        failure_reason: failureReason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', depositId);
    throw new DepositServiceError(
      'STRIPE_CHECKOUT_FAILED',
      err?.message ?? 'Stripe Checkout Session creation failed',
      400,
      err
    );
  }

  if (!session.url) {
    await supabase
      .from('wallet_deposits')
      .update({
        status: 'failed',
        failure_reason: 'stripe_returned_no_url',
        updated_at: new Date().toISOString(),
      })
      .eq('id', depositId);
    throw new DepositServiceError('STRIPE_NO_URL', 'Stripe did not return a checkout URL', 500);
  }

  // Stamp Stripe IDs onto the deposit, move to checkout_started.
  const { error: updateErr } = await supabase
    .from('wallet_deposits')
    .update({
      status: 'checkout_started',
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id:
        typeof session.payment_intent === 'string' ? session.payment_intent : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', depositId);

  if (updateErr) {
    // The session exists in Stripe but we couldn't record it locally. The
    // webhook will still be received (with deposit_id in metadata) so the
    // deposit can still be finalized; just log loudly.
    console.error(
      `[wallet/deposit] failed to record stripe IDs for deposit ${depositId}:`,
      updateErr.message
    );
  }

  return {
    deposit_id: depositId,
    checkout_url: session.url,
    expires_at: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Finalize a deposit after the webhook confirms successful payment.
 * Idempotent: safe to call multiple times for the same deposit/event.
 */
export async function finalizeDeposit(
  depositId: string,
  stripeEventId: string,
  stripePaymentIntentId: string | null
): Promise<CreditDepositRpcResult> {
  const supabase = getSupabase();
  if (!supabase) {
    throw new DepositServiceError('GATEWAY_MISCONFIGURED', 'Supabase not configured', 500);
  }

  const { data, error } = await supabase.rpc('credit_deposit', {
    p_deposit_id: depositId,
    p_stripe_event_id: stripeEventId,
    p_stripe_pi_id: stripePaymentIntentId,
  });

  if (error) {
    throw new DepositServiceError(
      'CREDIT_DEPOSIT_RPC_FAILED',
      `credit_deposit failed: ${error.message}`,
      500
    );
  }

  return (data ?? { ok: false, error: 'EMPTY_RPC_RESPONSE' }) as CreditDepositRpcResult;
}

export async function markDepositTerminal(
  depositId: string,
  status: 'failed' | 'canceled' | 'expired',
  failureReason: string | null
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  // Don't overwrite a succeeded deposit. The webhook may deliver a late
  // 'expired' for a session that has already paid; succeeded wins.
  await supabase
    .from('wallet_deposits')
    .update({
      status,
      failure_reason: failureReason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', depositId)
    .neq('status', 'succeeded');
}

export async function getDepositForUser(
  depositId: string,
  userId: string
): Promise<WalletDeposit | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from('wallet_deposits')
    .select('*')
    .eq('id', depositId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WalletDeposit | null) ?? null;
}

// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in deposit-service.ts has any test coverage today —
// test/wallet-stripe-webhook.test.ts mocks this module wholesale
// (jest.mock('.../wallet/deposit-service', ...)).
//
// Money-critical file: wallet deposits + Stripe checkout. Every function
// below is a byte-for-byte lift of the original inline call — same table,
// same columns, same filters, same order of operations. No amount/status
// logic lives here; this file only relocates the query builders.
/**
 * services/wallet/deposit-service.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in deposit-service.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchWalletAccountForCurrency(sb: SupabaseClient, userId: string, currency: string) {
  return sb.from('wallet_accounts').select('id, status').eq('user_id', userId).eq('currency', currency).maybeSingle();
}

export async function insertWalletAccount(sb: SupabaseClient, userId: string, currency: string) {
  return sb.from('wallet_accounts').insert({ user_id: userId, currency }).select('id').single();
}

export async function insertWalletDeposit(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('wallet_deposits').insert(row).select('id').single();
}

/** Reused for both "Stripe session create failed" and "Stripe returned no URL" — identical status='failed' update shape. */
export async function markWalletDepositFailedInline(sb: SupabaseClient, depositId: string, failureReason: string) {
  return sb
    .from('wallet_deposits')
    .update({
      status: 'failed',
      failure_reason: failureReason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', depositId);
}

export async function stampWalletDepositStripeIds(
  sb: SupabaseClient,
  depositId: string,
  patch: { status: string; stripe_checkout_session_id: string; stripe_payment_intent_id: string | null; updated_at: string },
) {
  return sb.from('wallet_deposits').update(patch).eq('id', depositId);
}

export async function creditDepositRpc(
  sb: SupabaseClient,
  depositId: string,
  stripeEventId: string,
  stripePaymentIntentId: string | null,
) {
  return sb.rpc('credit_deposit', {
    p_deposit_id: depositId,
    p_stripe_event_id: stripeEventId,
    p_stripe_pi_id: stripePaymentIntentId,
  });
}

export async function markWalletDepositTerminal(
  sb: SupabaseClient,
  depositId: string,
  patch: { status: string; failure_reason: string | null; updated_at: string },
) {
  return sb.from('wallet_deposits').update(patch).eq('id', depositId).neq('status', 'succeeded');
}

export async function fetchWalletDepositForUser(sb: SupabaseClient, depositId: string, userId: string) {
  return sb.from('wallet_deposits').select('*').eq('id', depositId).eq('user_id', userId).maybeSingle();
}

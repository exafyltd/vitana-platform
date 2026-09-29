/**
 * VTID-02950: Credits a recommender's wallet for a converted product order.
 *
 * Revenue-share model: the recommender earns a percentage of Vitana's OWN
 * earned commission on the sale (never more than Vitana itself made).
 * Self-funding — no separate budget to manage, and naturally excludes
 * merchants Vitana earns nothing from.
 *
 * Call sites:
 *   - services/checkout/checkout-service.ts, when a first-party product_orders
 *     row flips to state='converted' (no-ops today — first-party orders don't
 *     carry commission_cents, so there's nothing to revenue-share yet).
 *   - services/marketplace-sync/awin-order-sync.ts, after a real Awin
 *     conversion upserts a converted product_orders row with commission_cents.
 *
 * Idempotent via recommendation_commissions.product_order_id UNIQUE — safe to
 * call more than once for the same order (e.g. a re-pull of the same Awin
 * transaction).
 */

import { getSupabase } from '../../lib/supabase';
import { creditWalletForEarning } from '../wallet/spend-earning-service';
import { fetchExcludedTestServiceAccountIdsStrict } from '../../lib/excluded-test-service-accounts';
import * as repo from './credit-recommender-repository';
import { validateReferral } from './referral-validation';

export type CreditRecommenderStatus =
  | 'pending'
  | 'credited'
  | 'skipped_ineligible'
  | 'skipped_invalid_referral'
  | 'skipped_no_recommendation'
  | 'already_credited'
  | 'failed';

export interface CreditRecommenderResult {
  ok: boolean;
  status: CreditRecommenderStatus;
  payout_minor?: number;
  message?: string;
}

const DEFAULT_RATE = 0.2;
const DEFAULT_RETURN_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Order states that undo a sale: a commission on them is never paid. */
export const REVERSING_ORDER_STATES: ReadonlySet<string> = new Set(['refunded', 'cancelled', 'chargeback']);

/**
 * VTID-04741: days a conversion the network has NOT approved waits before
 * its commission is confirmed (admin_settings, default 30).
 */
async function loadReturnWindowDays(supabase: NonNullable<ReturnType<typeof getSupabase>>): Promise<number> {
  const { data } = await repo.fetchReturnWindowSetting(supabase);
  const days = (data?.value as { days?: number } | undefined)?.days;
  return typeof days === 'number' && days >= 0 && days <= 365 ? days : DEFAULT_RETURN_WINDOW_DAYS;
}

async function loadDefaultRate(supabase: ReturnType<typeof getSupabase>): Promise<number> {
  if (!supabase) return DEFAULT_RATE;
  const { data } = await repo.fetchDefaultCommissionRateSetting(supabase);
  const rate = (data?.value as { rate?: number } | undefined)?.rate;
  return typeof rate === 'number' && rate > 0 && rate <= 1 ? rate : DEFAULT_RATE;
}

export interface CreditRecommenderOptions {
  /**
   * VTID-04741: the affiliate network has already APPROVED this conversion
   * (e.g. Awin status approved/confirmed/paid), which happens after the
   * retailer's own return window. Such a commission is confirmed and paid at
   * once. Every other conversion is recorded as `pending` and paid by
   * confirmDueRecommendationCommissions() after the return window.
   */
  networkConfirmed?: boolean;
}

/**
 * Records the recommender's commission for one converted product_orders row,
 * if that order carries a referral that counts and the merchant is eligible:
 * `pending` until the return window passes, or paid at once when the network
 * has already approved the sale.
 */
export async function creditRecommenderForOrder(
  orderId: string,
  opts: CreditRecommenderOptions = {},
): Promise<CreditRecommenderResult> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, status: 'failed', message: 'DB_UNAVAILABLE' };

  const { data: order, error: orderErr } = await repo.fetchProductOrderForCommission(supabase, orderId);
  if (orderErr || !order) return { ok: false, status: 'failed', message: 'ORDER_NOT_FOUND' };
  if (order.state !== 'converted') return { ok: true, status: 'skipped_no_recommendation', message: 'order not converted' };
  if (!order.attribution_recommendation_id) return { ok: true, status: 'skipped_no_recommendation' };
  if (!order.commission_cents || order.commission_cents <= 0) {
    return { ok: true, status: 'skipped_no_recommendation', message: 'no commission on this order' };
  }

  // Idempotency check — a re-pull of the same conversion must not double-credit.
  // A Postgres-level failure here resolves normally rather than throwing, so
  // it would otherwise silently bypass this guard and fall through to a
  // real credit attempt — the underlying credit_wallet_for_earning ledger
  // UNIQUE constraint prevents an actual double-payment (see
  // AURORA-B3-RPC-PARITY-INVENTORY.md), but the failure itself was
  // previously invisible.
  const { data: existing, error: existingErr } = await repo.fetchExistingRecommendationCommission(supabase, orderId);
  if (existingErr) {
    console.warn(`[credit-recommender] fetchExistingRecommendationCommission error for order=${orderId}: ${existingErr.message}`);
  }
  if (existing) return { ok: true, status: 'already_credited' };

  const { data: recommendation, error: recommendationErr } = await repo.fetchProductRecommendationForCommission(
    supabase,
    order.attribution_recommendation_id,
  );
  if (recommendationErr) {
    console.error(`[credit-recommender] fetchProductRecommendationForCommission error for order=${orderId}: ${recommendationErr.message}`);
    return { ok: false, status: 'failed', message: 'RECOMMENDATION_LOOKUP_FAILED' };
  }
  if (!recommendation) return { ok: true, status: 'skipped_no_recommendation' };

  const { data: merchant, error: merchantErr } = await repo.fetchMerchantCommissionEligibility(supabase, order.merchant_id);
  if (merchantErr) {
    // A real DB error here must NOT be evaluated as "merchant not eligible" —
    // that branch below permanently writes a skipped_ineligible row keyed on
    // product_order_id, which the idempotency check above treats as final
    // regardless of stored status, blocking any future reprocessing of a
    // transient DB blip. Bail before eligibility is even considered.
    console.error(`[credit-recommender] fetchMerchantCommissionEligibility error for order=${orderId}: ${merchantErr.message}`);
    return { ok: false, status: 'failed', message: 'MERCHANT_LOOKUP_FAILED' };
  }

  const currency = (order.currency ?? 'EUR').toUpperCase();
  const rate = merchant?.recommendation_commission_rate_override ?? (await loadDefaultRate(supabase));
  const payoutMinor = Math.round(order.commission_cents * rate);

  // VTID-04735: the referral must count before anyone is paid for it — the
  // click-time check can be skipped (an order may carry a rec id the click
  // never validated, or one that became invalid since). A referral that does
  // not count is recorded as skipped for good: none of these reasons can
  // change for this order. The test/service-account list fails CLOSED: if it
  // cannot be read, nothing is paid and nothing permanent is written, so the
  // order is re-processed on the next pull.
  const excluded = await fetchExcludedTestServiceAccountIdsStrict(supabase);
  if (!excluded.ok) {
    console.error(`[credit-recommender] excluded-account lookup failed for order=${orderId}: ${excluded.error}`);
    return { ok: false, status: 'failed', message: 'EXCLUSION_LOOKUP_FAILED' };
  }
  const verdict = validateReferral({
    recommendation: {
      id: recommendation.id,
      user_id: recommendation.user_id,
      product_id: recommendation.product_id,
      status: recommendation.status,
    },
    productId: order.product_id,
    buyerUserId: order.user_id ?? null,
    excludedUserIds: excluded.ids,
  });
  if (!verdict.ok) {
    await repo.insertRecommendationCommission(supabase, {
      product_recommendation_id: recommendation.id,
      product_order_id: orderId,
      recommender_user_id: recommendation.user_id,
      vitana_commission_cents: order.commission_cents,
      rate_applied: rate,
      payout_amount_minor: 0,
      currency,
      status: 'skipped_ineligible',
    });
    await repo.insertCommissionSkippedIneligibleEvent(supabase, {
      service: 'discover', source: 'recommendation-commissions',
      type: 'marketplace.recommendation.commission_skipped_invalid_referral',
      topic: 'marketplace.recommendation.commission_skipped_invalid_referral',
      status: 'info', message: `referral does not count: ${verdict.reason}`,
      metadata: { orderId, recommendationId: recommendation.id, recommenderId: recommendation.user_id, reason: verdict.reason },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return { ok: true, status: 'skipped_invalid_referral', message: verdict.reason };
  }

  if (!merchant?.recommendation_commission_eligible) {
    await repo.insertRecommendationCommission(supabase, {
      product_recommendation_id: recommendation.id,
      product_order_id: orderId,
      recommender_user_id: recommendation.user_id,
      vitana_commission_cents: order.commission_cents,
      rate_applied: rate,
      payout_amount_minor: payoutMinor,
      currency,
      status: 'skipped_ineligible',
    });
    await repo.insertCommissionSkippedIneligibleEvent(supabase, {
      service: 'discover', source: 'recommendation-commissions',
      type: 'marketplace.recommendation.commission_skipped_ineligible',
      topic: 'marketplace.recommendation.commission_skipped_ineligible',
      status: 'info', message: 'merchant not eligible for recommendation commissions',
      metadata: { orderId, merchantId: order.merchant_id, recommenderId: recommendation.user_id },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return { ok: true, status: 'skipped_ineligible' };
  }

  if (payoutMinor <= 0 || (currency !== 'EUR' && currency !== 'USD')) {
    return { ok: true, status: 'skipped_no_recommendation', message: 'non-positive payout or unsupported currency' };
  }

  if (!opts.networkConfirmed) {
    // VTID-04741: hold. Nothing reaches the wallet until the return window
    // has passed and the order is still a sale.
    const days = await loadReturnWindowDays(supabase);
    const confirmAfter = new Date(Date.now() + days * DAY_MS).toISOString();
    const { error: pendingErr } = await repo.insertRecommendationCommission(supabase, {
      product_recommendation_id: recommendation.id,
      product_order_id: orderId,
      recommender_user_id: recommendation.user_id,
      vitana_commission_cents: order.commission_cents,
      rate_applied: rate,
      payout_amount_minor: payoutMinor,
      currency,
      status: 'pending',
      confirm_after: confirmAfter,
    });
    if (pendingErr) {
      console.error(`[credit-recommender] pending insert failed for order=${orderId}: ${pendingErr.message}`);
      return { ok: false, status: 'failed', message: 'PENDING_INSERT_FAILED' };
    }
    return { ok: true, status: 'pending', payout_minor: payoutMinor, message: `confirms after ${confirmAfter}` };
  }

  const { data: account, error: accountErr } = await repo.fetchRecommenderWalletAccount(supabase, recommendation.user_id, currency);
  if (accountErr) {
    console.error(`[credit-recommender] fetchRecommenderWalletAccount error for order=${orderId}: ${accountErr.message}`);
    return { ok: false, status: 'failed', message: 'RECOMMENDER_WALLET_LOOKUP_FAILED' };
  }
  if (!account) {
    return { ok: false, status: 'failed', message: 'RECOMMENDER_WALLET_NOT_FOUND' };
  }

  const creditResult = await creditWalletForEarning({
    account_id: account.id,
    amount_minor: payoutMinor,
    currency: currency as 'EUR' | 'USD',
    reference_type: 'recommendation_commission',
    reference_id: orderId,
    description: 'Recommendation commission',
    metadata: { product_recommendation_id: recommendation.id, rate_applied: rate, vitana_commission_cents: order.commission_cents },
  });

  if (!creditResult.ok) {
    await repo.insertRecommendationCommission(supabase, {
      product_recommendation_id: recommendation.id,
      product_order_id: orderId,
      recommender_user_id: recommendation.user_id,
      vitana_commission_cents: order.commission_cents,
      rate_applied: rate,
      payout_amount_minor: payoutMinor,
      currency,
      status: 'failed',
    });
    return { ok: false, status: 'failed', message: creditResult.error };
  }

  const { error: recordErr } = await repo.insertRecommendationCommission(supabase, {
    product_recommendation_id: recommendation.id,
    product_order_id: orderId,
    recommender_user_id: recommendation.user_id,
    vitana_commission_cents: order.commission_cents,
    rate_applied: rate,
    payout_amount_minor: payoutMinor,
    currency,
    wallet_ledger_entry_id: creditResult.ledger_entry_id ?? null,
    status: 'credited',
    confirmed_at: new Date().toISOString(),
  });
  if (recordErr) {
    // The wallet was already credited above (or was a no-op duplicate per
    // the ledger's own UNIQUE constraint) — this insert only records that
    // fact. Its result was previously fully discarded, so a failure here
    // (e.g. this row already exists from a prior successful run, if the
    // idempotency check above ever missed it) was invisible, and the
    // function still reports 'credited' below regardless. Logging only —
    // not changing the returned status, which stays accurate for the
    // wallet-credit outcome that actually matters.
    console.warn(`[credit-recommender] insertRecommendationCommission (credited) error for order=${orderId}: ${recordErr.message}`);
  }

  await repo.incrementProductRecommendationStats(supabase, {
    p_recommendation_id: recommendation.id,
    p_commission_earned_minor: payoutMinor,
  });

  return { ok: true, status: 'credited', payout_minor: payoutMinor };
}

// ==================== VTID-04741: confirm and reverse ====================

export interface ConfirmDueResult {
  ok: boolean;
  examined: number;
  credited: number;
  reversed: number;
  failed: number;
  error?: string;
}

/**
 * Pays every `pending` commission whose return window has passed, provided its
 * order is still a sale; reverses the ones whose order was undone meanwhile.
 * Idempotent: the wallet credit is keyed on the order (ledger UNIQUE), and each
 * row moves out of `pending` with a status-guarded update, so two concurrent
 * runs cannot pay the same commission twice.
 */
export async function confirmDueRecommendationCommissions(limit = 100): Promise<ConfirmDueResult> {
  const supabase = getSupabase();
  const result: ConfirmDueResult = { ok: true, examined: 0, credited: 0, reversed: 0, failed: 0 };
  if (!supabase) return { ...result, ok: false, error: 'DB_UNAVAILABLE' };

  const { data: due, error } = await repo.fetchDuePendingCommissions(supabase, new Date().toISOString(), limit);
  if (error) return { ...result, ok: false, error: error.message };

  for (const row of (due ?? []) as Array<{
    id: string;
    product_order_id: string;
    product_recommendation_id: string;
    recommender_user_id: string;
    payout_amount_minor: number;
    currency: string;
    rate_applied: number;
    vitana_commission_cents: number;
  }>) {
    result.examined++;
    const { data: order, error: orderErr } = await repo.fetchProductOrderForCommission(supabase, row.product_order_id);
    if (orderErr || !order) {
      result.failed++;
      continue;
    }
    if (REVERSING_ORDER_STATES.has(order.state)) {
      const r = await reverseRecommendationCommissionForOrder(row.product_order_id, `order_${order.state}`);
      if (r.status === 'reversed') result.reversed++;
      continue;
    }
    if (order.state !== 'converted') continue; // not final yet; examined again next run

    const currency = String(row.currency).toUpperCase();
    if (currency !== 'EUR' && currency !== 'USD') {
      result.failed++;
      continue;
    }
    const { data: account, error: accountErr } = await repo.fetchRecommenderWalletAccount(supabase, row.recommender_user_id, currency);
    if (accountErr || !account) {
      // Stays pending: retried on the next run once the wallet exists.
      console.error(`[credit-recommender] confirm: no wallet for recommender=${row.recommender_user_id} order=${row.product_order_id}`);
      result.failed++;
      continue;
    }
    const credit = await creditWalletForEarning({
      account_id: account.id,
      amount_minor: row.payout_amount_minor,
      currency: currency as 'EUR' | 'USD',
      reference_type: 'recommendation_commission',
      reference_id: row.product_order_id,
      description: 'Recommendation commission',
      metadata: {
        product_recommendation_id: row.product_recommendation_id,
        rate_applied: row.rate_applied,
        vitana_commission_cents: row.vitana_commission_cents,
      },
    });
    if (!credit.ok) {
      result.failed++;
      continue;
    }
    const { error: updErr } = await repo.updateCommissionIfStatus(supabase, row.id, 'pending', {
      status: 'credited',
      confirmed_at: new Date().toISOString(),
      wallet_ledger_entry_id: credit.ledger_entry_id ?? null,
    });
    if (updErr) console.warn(`[credit-recommender] confirm: status update failed for ${row.id}: ${updErr.message}`);
    await repo.incrementProductRecommendationStats(supabase, {
      p_recommendation_id: row.product_recommendation_id,
      p_commission_earned_minor: row.payout_amount_minor,
    });
    result.credited++;
  }
  return result;
}

export type ReverseCommissionStatus = 'reversed' | 'none' | 'already_final' | 'paid_needs_clawback' | 'failed';

/**
 * Undoes the commission of an order that was refunded, cancelled or charged
 * back. A `pending` commission is reversed (never paid). One that was already
 * paid is NOT clawed back here — that needs the clawback policy (architecture
 * D-11) — it is reported as an exception event so it is never silent.
 */
export async function reverseRecommendationCommissionForOrder(
  orderId: string,
  reason: string,
): Promise<{ ok: boolean; status: ReverseCommissionStatus }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, status: 'failed' };

  const { data: existing, error } = await repo.fetchExistingRecommendationCommission(supabase, orderId);
  if (error) return { ok: false, status: 'failed' };
  if (!existing) return { ok: true, status: 'none' };

  if (existing.status === 'pending') {
    const { data: updated, error: updErr } = await repo.updateCommissionIfStatus(supabase, existing.id, 'pending', {
      status: 'reversed',
      reversed_at: new Date().toISOString(),
      reversal_reason: reason,
    });
    if (updErr) return { ok: false, status: 'failed' };
    if (!updated || (Array.isArray(updated) && updated.length === 0)) return { ok: true, status: 'already_final' };
    await repo.insertCommissionSkippedIneligibleEvent(supabase, {
      service: 'discover', source: 'recommendation-commissions',
      type: 'marketplace.recommendation.commission_reversed',
      topic: 'marketplace.recommendation.commission_reversed',
      status: 'info', message: `recommendation commission reversed before payment: ${reason}`,
      metadata: { orderId, commissionId: existing.id, reason },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return { ok: true, status: 'reversed' };
  }

  if (existing.status === 'credited') {
    await repo.insertCommissionSkippedIneligibleEvent(supabase, {
      service: 'discover', source: 'recommendation-commissions',
      type: 'marketplace.recommendation.commission_reversal_after_payout',
      topic: 'marketplace.recommendation.commission_reversal_after_payout',
      status: 'warning', message: `order undone after the commission was paid: ${reason}`,
      metadata: { orderId, commissionId: existing.id, reason },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return { ok: true, status: 'paid_needs_clawback' };
  }

  return { ok: true, status: 'already_final' };
}

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
import * as repo from './credit-recommender-repository';

export type CreditRecommenderStatus = 'credited' | 'skipped_ineligible' | 'skipped_no_recommendation' | 'already_credited' | 'failed';

export interface CreditRecommenderResult {
  ok: boolean;
  status: CreditRecommenderStatus;
  payout_minor?: number;
  message?: string;
}

const DEFAULT_RATE = 0.2;

async function loadDefaultRate(supabase: ReturnType<typeof getSupabase>): Promise<number> {
  if (!supabase) return DEFAULT_RATE;
  const { data } = await repo.fetchDefaultCommissionRateSetting(supabase);
  const rate = (data?.value as { rate?: number } | undefined)?.rate;
  return typeof rate === 'number' && rate > 0 && rate <= 1 ? rate : DEFAULT_RATE;
}

/**
 * Credits the recommender for one converted product_orders row, if that order
 * carries an attribution_recommendation_id and the merchant is eligible.
 */
export async function creditRecommenderForOrder(orderId: string): Promise<CreditRecommenderResult> {
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

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

import { randomUUID } from 'crypto';
import { getSupabase } from '../../lib/supabase';
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
 * its commission is confirmed (admin_settings, default 30). A missing or
 * invalid setting means the default; a failed lookup is null, so the caller
 * fails closed instead of storing a window nobody configured.
 */
async function loadReturnWindowDays(supabase: NonNullable<ReturnType<typeof getSupabase>>): Promise<number | null> {
  const { data, error } = await repo.fetchReturnWindowSetting(supabase);
  if (error) return null;
  const days = (data?.value as { days?: number } | undefined)?.days;
  return typeof days === 'number' && days >= 0 && days <= 365 ? days : DEFAULT_RETURN_WINDOW_DAYS;
}

/**
 * Pays one held commission through confirm_recommendation_commission(): one
 * DB transaction that locks the commission and the order, re-checks both and
 * credits the wallet. Every payment goes through it, network-approved ones
 * included, so no path pays outside that lock.
 */
async function payThroughConfirm(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  commissionId: string,
  payoutMinor: number | undefined,
): Promise<CreditRecommenderResult> {
  const { data, error } = await repo.confirmRecommendationCommissionRpc(supabase, commissionId);
  const outcome = data as { ok?: boolean; status?: string; error?: string } | null;
  if (error || !outcome) {
    console.error(`[credit-recommender] confirm failed for commission=${commissionId}: ${error?.message ?? 'no result'}`);
    return { ok: false, status: 'failed', message: 'CONFIRM_FAILED' };
  }
  // Refused (e.g. no wallet yet): nothing committed, the row stays pending and
  // the scheduled confirmation retries it.
  if (!outcome.ok) return { ok: false, status: 'failed', message: outcome.error ?? 'CONFIRM_FAILED' };
  if (outcome.status === 'credited') return { ok: true, status: 'credited', payout_minor: payoutMinor };
  if (outcome.status === 'skipped_excluded_account') {
    return { ok: true, status: 'skipped_invalid_referral', message: 'excluded_account' };
  }
  // order_not_converted / not_pending: a concurrent decline or reversal won.
  return { ok: true, status: 'pending', message: outcome.status };
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
  if (existing) {
    // A held commission whose sale the network has now approved is paid now.
    if (opts.networkConfirmed && existing.status === 'pending') return payThroughConfirm(supabase, existing.id, undefined);
    return { ok: true, status: 'already_credited' };
  }

  const { data: recommendation, error: recommendationErr } = await repo.fetchProductRecommendationForCommission(
    supabase,
    order.attribution_recommendation_id,
  );
  if (recommendationErr) {
    console.error(`[credit-recommender] fetchProductRecommendationForCommission error for order=${orderId}: ${recommendationErr.message}`);
    return { ok: false, status: 'failed', message: 'RECOMMENDATION_LOOKUP_FAILED' };
  }
  if (!recommendation) return { ok: true, status: 'skipped_no_recommendation' };

  // VTID-04740: pay the referrer frozen on the click at redirect time, not
  // whoever owns the recommendation when the sale is credited. Orders without
  // a click (e.g. checkout) fall back to the recommendation's owner.
  let payeeUserId: string = recommendation.user_id;
  if (order.click_id) {
    const { data: click, error: clickErr } = await repo.fetchClickReferrer(supabase, order.click_id);
    if (clickErr) {
      console.error(`[credit-recommender] fetchClickReferrer error for order=${orderId}: ${clickErr.message}`);
      return { ok: false, status: 'failed', message: 'CLICK_LOOKUP_FAILED' };
    }
    if (click?.referrer_user_id) payeeUserId = click.referrer_user_id;
  }

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
      user_id: payeeUserId,
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
      recommender_user_id: payeeUserId,
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
      metadata: { orderId, recommendationId: recommendation.id, recommenderId: payeeUserId, reason: verdict.reason },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return { ok: true, status: 'skipped_invalid_referral', message: verdict.reason };
  }

  if (!merchant?.recommendation_commission_eligible) {
    await repo.insertRecommendationCommission(supabase, {
      product_recommendation_id: recommendation.id,
      product_order_id: orderId,
      recommender_user_id: payeeUserId,
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
      metadata: { orderId, merchantId: order.merchant_id, recommenderId: payeeUserId },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return { ok: true, status: 'skipped_ineligible' };
  }

  if (payoutMinor <= 0 || (currency !== 'EUR' && currency !== 'USD')) {
    return { ok: true, status: 'skipped_no_recommendation', message: 'non-positive payout or unsupported currency' };
  }

  // VTID-04741: every commission is recorded `pending` first. A conversion the
  // network has not approved waits for the return window; a network-approved
  // one is due now and is paid at once through the same locking transaction.
  let confirmAfter: string;
  if (opts.networkConfirmed) {
    confirmAfter = new Date().toISOString();
  } else {
    const days = await loadReturnWindowDays(supabase);
    if (days === null) {
      console.error(`[credit-recommender] return-window lookup failed for order=${orderId}`);
      return { ok: false, status: 'failed', message: 'RETURN_WINDOW_LOOKUP_FAILED' };
    }
    confirmAfter = new Date(Date.now() + days * DAY_MS).toISOString();
  }
  const { data: pending, error: pendingErr } = await repo.insertRecommendationCommission(supabase, {
    product_recommendation_id: recommendation.id,
    product_order_id: orderId,
    recommender_user_id: payeeUserId,
    vitana_commission_cents: order.commission_cents,
    rate_applied: rate,
    payout_amount_minor: payoutMinor,
    currency,
    status: 'pending',
    confirm_after: confirmAfter,
  });
  const pendingId = (pending as { id?: string } | null)?.id;
  if (pendingErr || !pendingId) {
    console.error(`[credit-recommender] pending insert failed for order=${orderId}: ${pendingErr?.message ?? 'no id returned'}`);
    return { ok: false, status: 'failed', message: 'PENDING_INSERT_FAILED' };
  }
  if (!opts.networkConfirmed) {
    return { ok: true, status: 'pending', payout_minor: payoutMinor, message: `confirms after ${confirmAfter}` };
  }
  return payThroughConfirm(supabase, pendingId, payoutMinor);
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

type DueCommissionRow = {
  id: string;
  product_order_id: string;
  product_recommendation_id: string;
  recommender_user_id: string;
  payout_amount_minor: number;
  currency: string;
  rate_applied: number;
  vitana_commission_cents: number;
};

/**
 * Pays every `pending` commission whose return window has passed, provided its
 * order is still a sale; reverses the ones whose order was undone meanwhile.
 *
 * Each commission is confirmed by confirm_recommendation_commission(), one DB
 * transaction that locks the row, re-checks the order, credits the wallet and
 * marks the row `credited` together: a crash leaves it `pending` for the next
 * run, never "paid" without money, and a concurrent reversal of the same order
 * waits on the row lock and sees the outcome. The wallet credit is keyed on
 * the order (ledger UNIQUE), so nothing is ever paid twice.
 *
 * Due rows are keyset-paged, so rows that stay pending (no wallet yet) never
 * hide the ones behind them. `maxRows` bounds one run; each run starts at a
 * random id and wraps around (ids above the start, then up to it), so when the
 * cap is hit the next run covers a different stretch instead of the same
 * lowest ids every time.
 */
export async function confirmDueRecommendationCommissions(
  batchSize = 100,
  maxRows = 5000,
  startId: string = randomUUID(),
): Promise<ConfirmDueResult> {
  const supabase = getSupabase();
  const result: ConfirmDueResult = { ok: true, examined: 0, credited: 0, reversed: 0, failed: 0 };
  if (!supabase) return { ...result, ok: false, error: 'DB_UNAVAILABLE' };

  const nowIso = new Date().toISOString();
  // Two passes: (startId, end], then [begin, startId].
  for (const [firstAfter, upTo] of [[startId, null], [null, startId]] as Array<[string | null, string | null]>) {
    let afterId = firstAfter;
    for (;;) {
      if (result.examined >= maxRows) {
        console.warn(`[credit-recommender] confirm: stopped after ${maxRows} rows; the next run starts elsewhere`);
        return result;
      }
      const { data: due, error } = await repo.fetchDuePendingCommissions(supabase, nowIso, batchSize, afterId, upTo);
      if (error) return { ...result, ok: false, error: error.message };
      const rows = (due ?? []) as DueCommissionRow[];
      for (const row of rows) await confirmOne(supabase, row, result);
      if (rows.length < batchSize) break;
      afterId = rows[rows.length - 1].id;
    }
  }
  return result;
}

async function confirmOne(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  row: DueCommissionRow,
  result: ConfirmDueResult,
): Promise<void> {
  result.examined++;
  const { data: order, error: orderErr } = await repo.fetchProductOrderForCommission(supabase, row.product_order_id);
  if (orderErr || !order) {
    result.failed++;
    return;
  }
  if (REVERSING_ORDER_STATES.has(order.state)) {
    const r = await reverseRecommendationCommissionForOrder(row.product_order_id, `order_${order.state}`);
    if (r.status === 'reversed') result.reversed++;
    return;
  }
  if (order.state !== 'converted') return; // not final yet; examined again next run

  const { data, error } = await repo.confirmRecommendationCommissionRpc(supabase, row.id);
  const outcome = data as { ok?: boolean; status?: string; error?: string } | null;
  if (error || !outcome?.ok) {
    // Nothing was committed: the row stays pending and is retried next run
    // (e.g. RECOMMENDER_WALLET_NOT_FOUND until the wallet exists).
    console.error(
      `[credit-recommender] confirm failed for ${row.id} order=${row.product_order_id}: ${error?.message ?? outcome?.error ?? 'unknown'}`,
    );
    result.failed++;
    return;
  }
  if (outcome.status === 'credited') result.credited++;
}

export type ReverseCommissionStatus =
  | 'reversed'
  | 'none'
  | 'already_final'
  | 'paid_needs_clawback'
  | 'order_not_reversing' // the order is a sale again: nothing reversed
  | 'failed';

/**
 * Undoes the commission of an order that was refunded, cancelled or charged
 * back, in one DB transaction (reverse_recommendation_commission). A `pending`
 * commission is reversed (never paid). One that was already paid is NOT clawed
 * back here — that needs the clawback policy (architecture D-11) — it is
 * reported once as `marketplace.recommendation.commission_reversal_after_payout`
 * (warning), the marker and the event committed together, so it is never
 * silent and never repeated on each re-pull of the declined transaction.
 */
export async function reverseRecommendationCommissionForOrder(
  orderId: string,
  reason: string,
): Promise<{ ok: boolean; status: ReverseCommissionStatus }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, status: 'failed' };

  const { data, error } = await repo.reverseRecommendationCommissionRpc(supabase, orderId, reason);
  const outcome = data as { ok?: boolean; status?: ReverseCommissionStatus } | null;
  if (error || !outcome?.ok || !outcome.status) {
    console.error(`[credit-recommender] reverse failed for order=${orderId}: ${error?.message ?? 'unexpected result'}`);
    return { ok: false, status: 'failed' };
  }
  return { ok: true, status: outcome.status };
}

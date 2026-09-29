# VTID-04741 — Recommender commissions held, then confirmed or reversed

This is plan step 4 of `docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md` (§8.5). The owner approved the migration in session on 2026-09-29.

## Change

- **Migration** `supabase/migrations/20260929120100_vtid_04741_recommendation_commission_hold.sql`:
  - statuses `pending` and `reversed`;
  - `confirm_after`, `confirmed_at`, `reversed_at`, `reversal_reason`;
  - partial index `idx_recommendation_commissions_due`;
  - `admin_settings.recommendation_commission_return_window_days` seeded with `{"days":30}`.
- **`creditRecommenderForOrder(orderId, { networkConfirmed })`** has two paths.
  - A conversion the network has not approved is recorded as `pending` with `confirm_after = now + window`. Nothing reaches the wallet. This covers first-party checkout and future direct partners.
  - A network-approved conversion (Awin approved/confirmed/paid) is paid at once, as before, and now records `confirmed_at`. It is not held again because Awin approves only after the retailer's return window.
- **`confirmDueRecommendationCommissions()`** handles every due pending commission:
  - if the order is still `converted`, it pays the commission and moves it to `credited` with a status-guarded update;
  - if the order was refunded, cancelled or charged back, it reverses the commission;
  - a missing wallet leaves it pending for the next run.
- **`reverseRecommendationCommissionForOrder()`** handles undone orders:
  - a `pending` commission becomes `reversed` and emits `marketplace.recommendation.commission_reversed`;
  - an already-paid one is not clawed back, because clawback policy is D-11. It emits `marketplace.recommendation.commission_reversal_after_payout` (warning), so it is never silent.
- **Awin sync**:
  - calls the credit with `networkConfirmed: true`;
  - reverses on a later decline;
  - confirms due held commissions at the end of each run.
- **Daily scheduled sync** (`POST /api/v1/internal/marketplace/sync/all`, run by `MARKETPLACE-SYNC-CRON.yml`) also confirms due held commissions. The Awin order sync is admin-triggered only, and checkout orders have no network to confirm them, so the scheduled run is what pays them.
- **Claim before paying.** The confirmer moves the row `pending → credited` (status-guarded) BEFORE the wallet credit. A concurrent reversal either wins that claim, so nothing is paid, or finds the row `credited` and reports it as paid, so a paid commission is never recorded as reversed. A failed wallet credit releases the claim back to `pending`. Recommendation totals are counted only after a claimed row is paid.
- **Due rows are keyset-paged**, so rows that stay pending (no wallet yet) never hide the due commissions behind them.
- **The after-payout exception is reported once per commission** (marked by `reversal_reason`), even though Awin re-pulls a declined transaction on every sync in its lookback window.

## Acceptance criteria

AC-1: a conversion the network has not approved is held `pending` for the configured window (30 days by default; an invalid setting falls back to 30), and nothing reaches the wallet.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-2: a network-approved conversion is paid at once with `confirmed_at`; all earlier credit tests still pass on this path.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-3: a due pending commission on a still-converted order is paid and moved to `credited`, guarded on its status.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-4: an order refunded, cancelled or charged back during the window is reversed and never paid.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-5: a reversal after payment raises the after-payout warning event instead of being silent; a missing wallet stays pending.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-7: the row is claimed before the wallet is paid; a failed claim pays nothing and the next run pays once; a row a concurrent reversal moved is never paid; a failed wallet credit releases the claim; a pending row already paid to the wallet is reported for clawback, not reversed.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-8: the daily all-networks scheduled sync confirms due held commissions, and a failure there does not fail the catalogue sync.
  TEST: services/gateway/test/routes/internal-marketplace-sync.test.ts
AC-9: due rows are keyset-paged past rows that stay pending, so a recommender without a wallet never blocks later payouts.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-10: the after-payout exception is reported once per commission, not on every re-pull of the declined transaction.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-6: the schema and setting are live (checked read-only after applying, see `outputs/live-schema.txt`).
  TEST: services/gateway/test/services/credit-recommender.test.ts

## Staging

Commissions and wallet credits write money rows into the shared production database, so nothing is exercised on staging. The staging suite runs the tests.

OASIS_PROOF: new event types `marketplace.recommendation.commission_reversed` and `marketplace.recommendation.commission_reversal_after_payout`, both asserted in `test/services/credit-recommender.test.ts`.

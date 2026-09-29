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
- **One transaction per step.** `confirm_recommendation_commission()` locks the commission row, re-checks that the order is still converted, credits the wallet (`credit_wallet_for_earning`), and marks the row `credited` and updates the stats, all in one transaction. A crash leaves the row `pending` for the next run. `reverse_recommendation_commission()` locks the same row, so a confirm and a reversal of one order serialize. A paid commission is never recorded as reversed.
- **The order row is locked too, and the payee is re-checked.** At payment, confirm locks the order, so an Awin decline that commits first prevents payment. It also re-checks that the payee is not a test, service or automation account, because the check made when the commission was held can go stale over up to 30 days. Such a commission is closed as `skipped_ineligible` and never paid.
- **The reversal re-checks the order too.** It locks the order and reverses only while the order is still refunded, cancelled or charged back, so a stale read can't permanently cancel a commission whose order is a sale again.
- **Each payout run starts at a random point and wraps around**, so the per-run row cap never pins it to the same lowest ids.
- **Due rows are keyset-paged**, so rows that stay pending (no wallet yet) never hide the due commissions behind them.
- **The after-payout exception is reported once per commission.** The `reversal_reason` marker and the OASIS event are written in the same transaction, so the warning can't be marked as sent while the event is lost.
- **Commission OASIS events are actually written.** `oasis_events` has no `type` column and requires `role`, so the helper's inserts had been rejected and swallowed. None had ever been recorded. The helper now writes a valid row.

## Acceptance criteria

AC-1: a conversion the network has not approved is held `pending` for the configured window (30 days by default; an invalid setting falls back to 30), and nothing reaches the wallet.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-2: a network-approved conversion is recorded `pending`, due now, and paid at once through `confirm_recommendation_commission`, the same locking transaction as held commissions, so no path pays outside that lock. A held commission whose sale the network later approves is confirmed through it too. A failed return-window lookup fails closed and writes nothing.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-3: a due pending commission on a still-converted order is paid and moved to `credited`, guarded on its status.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-4: an order refunded, cancelled or charged back during the window is reversed and never paid.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-5: a reversal after payment raises the after-payout warning event instead of being silent; a missing wallet stays pending.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-7: a due commission is confirmed by the single-transaction DB function; a refused confirm (no wallet yet) or an RPC error leaves it pending and the next run pays it; a row a concurrent reversal moved is not counted; an order not yet final is left alone.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-8: the daily all-networks scheduled sync confirms due held commissions, and a failure there does not fail the catalogue sync.
  TEST: services/gateway/test/routes/internal-marketplace-sync.test.ts
AC-9: due rows are keyset-paged past rows that stay pending, so a recommender without a wallet never blocks later payouts.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-10: reversal goes through the single-transaction DB function (reversed / none / already_final / paid_needs_clawback passed through; an RPC error is `failed`, never done); the after-payout event is written once, together with its marker.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-12: the DB function closing or skipping a row (excluded payee, order a cancellation locked first) pays and counts nothing.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-13: a reversal whose order is a sale again changes nothing (`order_not_reversing`); each confirmation run starts at a random id and wraps around; the row cap stops a run.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-11: commission OASIS events are written as rows `oasis_events` accepts (no `type`, `role` set).
  TEST: services/gateway/test/services/credit-recommender-repository-events.test.ts
AC-6: the schema, the setting and the two functions are live (functions: SECURITY DEFINER, execute for `service_role` only) (checked read-only after applying, see `outputs/live-schema.txt`).
  TEST: services/gateway/test/services/credit-recommender.test.ts

## Staging

Commissions and wallet credits write money rows into the shared production database, so nothing is exercised on staging. The staging suite runs the tests.

OASIS_PROOF: new event types `marketplace.recommendation.commission_reversed` and `marketplace.recommendation.commission_reversal_after_payout`, both asserted in `test/services/credit-recommender.test.ts`.

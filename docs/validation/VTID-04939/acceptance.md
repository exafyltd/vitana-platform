# VTID-04939 — Reviewer-sandbox safety: pin the supplier go-live gate for allowlisted owners (item 2 of 7)

Owner instruction 2026-10-07 ("proceed with item 2"). Sparring: `plan-sparring.md` (premise correction) and `docs/validation/VTID-04938/plan-sparring.md`.
Not part of this VTID: the reviewer account itself, any migration, any gateway change.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (a database test and its CI workflow).

FINAL_URL: n/a (no runtime surface).

CURL_PROOF: n/a — nothing deployed, nothing probed against production.

OASIS_PROOF: n/a (no state change).

## Acceptance criteria

AC-1: A product of a merchant or org owned by an account in `service_bot_accounts` or `notification_test_actors` never becomes active, even when its org is `live` (insert and admin switch-on), and the switch-on is held as `excluded_account`.
  TEST: scripts/ci/sql-tests/vtid-04939-supplier-listing-gate.test.sql (CI SQL-SUPPLIER-LISTING-GATE)
AC-2: Registering the owner after the product is active switches it off; an org going live later does not activate a reviewer product.
  TEST: scripts/ci/sql-tests/vtid-04939-supplier-listing-gate.test.sql (CI SQL-SUPPLIER-LISTING-GATE)
AC-3: A real live supplier's product still goes active (the gate does not over-block).
  TEST: scripts/ci/sql-tests/vtid-04939-supplier-listing-gate.test.sql (CI SQL-SUPPLIER-LISTING-GATE)

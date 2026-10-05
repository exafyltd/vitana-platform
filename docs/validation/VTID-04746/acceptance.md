# VTID-04746 — CSV import errors carry a translatable code

The partner catalogue CSV import (VTID-04731) reported every problem as an English sentence. The Commerce Portal upload screen (VTID-04745) must show those problems in the partner's language. CLAUDE.md says backend-supplied UI text ships as a key and params, never a raw string. So every error now also carries a stable `code` and `params`. `message` stays for logs and API callers, so the change is backward compatible.

- **File errors:** `fileErrorCode` + `fileErrorParams`. The route returns them as `code` + `params` on a `400 invalid_csv`.
  - The codes are `empty`, `too_large`, `no_header`, `unknown_columns`, `duplicate_columns`, `missing_column`, `missing_price_column`, `no_rows`, `too_many_rows` and `unterminated_quote`.
- **Row errors:** `code` + `params` on each `{ line, field }`.
  - Parser codes: `field_count`, `price_both`, `not_money`, `not_cents` and `amount_too_large`.
  - Product-schema codes, from the Zod issue: `required`, `too_short`, `too_long`, `wrong_length`, `invalid_url`, `invalid_choice` and `ships_to_required`. Anything else is `invalid_value`.

## Acceptance criteria

AC-1: every file error returns its code and params, and the route passes them on `invalid_csv`.
  TEST: services/gateway/test/services/partner-catalogue-csv.test.ts
AC-2: every row error carries a code. Schema issues map to the stable set, and anything unknown is `invalid_value`.
  TEST: services/gateway/test/services/partner-catalogue-csv.test.ts
AC-3: the import route still answers on staging (read-only rejected probe, no token, 401).
  CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-4000-8000-000000000000/catalogue/products/import

## Staging

An import writes products into the shared production database, so none is run on staging. The staging suite probes the route and runs the tests.

OASIS_PROOF: no new event type. Only error bodies gain fields.

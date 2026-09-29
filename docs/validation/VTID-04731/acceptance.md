# VTID-04731 — Partner onboarding: catalogue CSV import

Spec: `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md` §6.2. The
catalogue route (VTID-04488) deferred CSV upload to its own VTID; this is it.

## Change

- `services/gateway/src/services/partner-catalogue-csv.ts` — pure parser.
  RFC 4180 quoting, comma or semicolon files (German spreadsheet exports use
  `;`), BOM stripped, case-insensitive header, unknown/duplicate/missing
  columns rejected as a file error, list columns split on `|`, `price` in
  major units (`19.99` / `19,99`, converted by string, never a float) or
  `price_cents`, never both. Each row is judged by the supplier portal's own
  `ProductSchema`, so a CSV row can never be something the one-product form
  refuses. Limits: 1,000,000 characters, 500 product rows, and prices no
  larger than the `integer` columns hold (2,147,483,647 cents), checked in
  validation so a dry run rejects what the real insert would fail on.
- `POST /api/v1/partner-onboarding/:orgId/catalogue/products/import`
  (org_admin only, body `{ csv, dry_run? }`):
  - 409 `CATALOGUE_LOCKED` (rejected/suspended org), 409 `NO_MERCHANT`;
  - 400 `invalid_csv` for a file-level problem;
  - `dry_run: true` → 200 `{ valid_rows, errors }`, nothing written;
  - any row error → 400 `invalid_rows` with every error and its line, nothing
    written (all or nothing);
  - otherwise one bulk insert of hidden drafts (`is_active: false`, the
    `supplier_referral` source network and key pattern of the single-product
    route; every draft carries the same keys, optional columns as `null`,
    because PostgREST rejects a bulk insert with differing keys — PGRST102,
    VTID-04095), a `partner_org.catalogue_imported` OASIS event, the catalogue
    step sync (plus `partner_org.catalogue_step_changed` when it moves), and
    201 with the refreshed onboarding state.

## Acceptance criteria

AC-1: the route is org_admin only, 401 JSON without a token, and locked for suspended/rejected orgs and orgs without a merchant.
  TEST: services/gateway/test/partner-onboarding-catalogue.test.ts
AC-2: a valid file is imported as hidden drafts in one insert under the org's merchant, and the catalogue step completes.
  TEST: services/gateway/test/partner-onboarding-catalogue.test.ts
AC-3: one bad row writes nothing and every error names its line and field.
  TEST: services/gateway/test/partner-onboarding-catalogue.test.ts
  TEST: services/gateway/test/services/partner-catalogue-csv.test.ts
AC-4: dry_run reports the same validation without any write or event.
  TEST: services/gateway/test/partner-onboarding-catalogue.test.ts
AC-5: the parser handles quoting, semicolon files, BOM, both price forms, and rejects unknown, duplicate and missing columns and oversize files.
  TEST: services/gateway/test/services/partner-catalogue-csv.test.ts
AC-6: the route is mounted on staging after deploy (401 JSON, was 404 HTML before).
  CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-4000-8000-000000000000/catalogue/products/import

## Route mount

ROUTE_MOUNT: `router.post('/:orgId/catalogue/products/import', …)` in `services/gateway/src/routes/partner-onboarding-catalogue.ts`, which `src/index.ts` already mounts at `/api/v1/partner-onboarding` (`mountRouterSync`, owner `partner-onboarding-catalogue`). No change to `index.ts`.
FINAL_URL: `POST /api/v1/partner-onboarding/:orgId/catalogue/products/import`
CURL_PROOF: before this deploy staging answers `404 text/html` ("Cannot POST") for the path while the sibling `POST …/catalogue/products` answers `401 application/json` from the same router (`outputs/staging-probe-before.txt`). After the deploy the new path must answer `401 application/json`; that is the first check in `staging-tests.json`.

## Staging

Staging writes to the production Supabase project, so no import is run
there. The staging suite probes the route read-only (rejected write probe,
401) and runs the unit and route suites above.

OASIS_PROOF: new event type `partner_org.catalogue_imported` (payload
`partner_organization_id`, `merchant_id`, `imported`), emitted once per
successful non-dry-run import, asserted in
`test/partner-onboarding-catalogue.test.ts`; the existing
`partner_org.catalogue_step_changed` fires after it only when the step moves.

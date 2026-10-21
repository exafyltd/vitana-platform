# VTID-05153 — Loop Engineering Phase 5: L9 Supplier catalog, wave 1

Owner approval 2026-10-13 ("Yes" at Gate 1). Sparring: `plan-sparring.md` (standard, 2 rounds, CONVERGED). Parent: VTID-05148. Doctrine: `docs/autonomy/LOOP-ENGINEERING.md` §6 item 5.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route. `GET /api/v1/autonomy/loops` gains `metrics_latest.L9`; `GET /api/v1/admin/partner-review/:orgId` gains `products[].catalog_check`; the supplier portal `GET /api/v1/vcaop/portal/my/products` and the org catalogue list return `attributes.catalog_check` shaped. All stay mounted and gated where they were (services/gateway/src/index.ts).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/autonomy/loops

OASIS_PROOF: no new topic. The routine records its run in `routine_runs` (trigger `gateway-runner`); wave 1 has no breach (poor supplier data is not a code failure).

CURL_PROOF: GET `/api/v1/autonomy/loops` and `/api/v1/admin/partner-review/00000000-0000-0000-0000-000000000000` unauthenticated on staging → 401 JSON; GET `/command-hub/` carries `loops-catalog.js?v=20261121-vtid-05153` and the served file has the L9 branch (staging-tests.json).

## Acceptance criteria

AC-1: supplier-catalog-check runs in the gateway routine runner daily at 13:00 UTC (14 runner routines); its catalog row is seeded idempotently without overwriting an existing row; the routine is owned by L9 in the loop catalog (sensors.routines), L9 stays PARTIAL with the new gap text.
  TEST: services/gateway/test/routine-runner/runner.test.ts
  TEST: services/gateway/test/routine-runner/status-route-and-workflows.test.ts
  TEST: services/gateway/test/loop-catalog.test.ts
  TEST: docs/validation/VTID-05153/migration-test.sql
AC-2: Candidates are supplier rows (source_network supplier_referral) of the supplements category, in orgs not rejected, without test/service accounts (exclusion list read fail-closed), prioritized unchecked/changed → needs_fix (strikes < 3, > 20 h) → ready_for_review (> 7 days), at most 20 per run.
  TEST: services/gateway/test/vtid-05153-catalog-check-run.test.ts
  TEST: services/gateway/test/vtid-05153-catalog-check-validators.test.ts
AC-3: Deterministic checks: lossless, idempotent normalization then ProductSchema (nothing invented); isCompleteOffering plus price > 0 for a product, ISO 4217, compare-at ≥ price, one image for a product; duplicates within the supplier by gtin/sku (same merchant) → canonical affiliate_url → normalized title, the newer row naming the older.
  TEST: services/gateway/test/vtid-05153-catalog-check-validators.test.ts
AC-4: Media: ssrfGuardedHead (HEAD, 5 s, ≤ 3 redirects with the host re-checked on each, no body read, no credentials, 405/501 → one GET Range bytes=0-0, private hosts refused) for at most 3 images per row; > 50 % network failures in a run → image_unchecked for every row, no image error, no strike.
  TEST: services/gateway/test/vtid-05153-ssrf-guarded-head.test.ts
  TEST: services/gateway/test/vtid-05153-catalog-check-run.test.ts
  TEST: services/gateway/test/vtid-05153-catalog-check-validators.test.ts
AC-5: Claim pre-screen: deterministic EN/DE disease-claim patterns behind the ClaimCheck seam; a hit only moves the row to needs_review — no block, no copy edit, nothing recorded as verified. Declared certifications are recorded as certifications_declared, never verified.
  TEST: services/gateway/test/vtid-05153-catalog-check-validators.test.ts
AC-6: One result per row in products.attributes.catalog_check ({v, state, checked_at, content_hash, errors [{code, field, params}], flags, duplicate_of?, normalized, fingerprint, strikes}); every error is a code + params, never English text; the same fingerprint on unchanged content three times → returned_to_supplier, an edit resets; returned rows are not re-checked until edited.
  TEST: services/gateway/test/vtid-05153-catalog-check-validators.test.ts
  TEST: services/gateway/test/vtid-05153-catalog-check-run.test.ts
AC-7: The write is a guarded PATCH (id, validated scalars, every written field's read value, jsonb equality on attributes; is_active=false for a write-back); a concurrent edit matches 0 rows and is checked again next run. No catalog-check code INSERTs into products, writes is_active / merchant_id / listing_hold / first_listed_at, or calls an LLM.
  TEST: services/gateway/test/vtid-05153-catalog-check-run.test.ts
  TEST: services/gateway/test/vtid-05153-catalog-check-source-guard.test.ts
AC-8: ProductFields.attributes drops exactly admin_listing and catalog_check from supplier input (create, patch; CSV has no attributes column; AI setup's kind/source survive); updateProduct keeps the stored catalog_check and admin_listing.
  TEST: services/gateway/test/vtid-05153-commerce-catalog-check-surfaces.test.ts
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-9: Back to the supplier: the checklist's catalogue step gets missing catalogue_fixes and detail.returned_products (status, submit, next step and evaluateVerification unchanged), counted by a separate head count; MCP next_action → {step: catalogue, tool: update_product} when no earlier required step is open; list_products shows check {state, codes}; the portal GET /products and the org catalogue list show catalog_check shaped ({state, errors [{code, field}], strikes}, no hash/fingerprint/normalized/duplicate id).
  TEST: services/gateway/test/vtid-05153-commerce-catalog-check-surfaces.test.ts
AC-10: reviewDetail carries catalog_check next to admin_listing; keep-offline / allow-listing stay the only per-offering decisions.
  TEST: services/gateway/test/vtid-05153-commerce-catalog-check-surfaces.test.ts
  CURL: GET /api/v1/admin/partner-review/00000000-0000-0000-0000-000000000000 → 401 JSON on staging
AC-11: L9 metrics in the run's findings (rows_checked, rows_auto_normalized, validation_failure_rate, ready_for_approval_share vs target 0.80, by_state, by_error_code; time_to_listing and human_edits_per_listing not_measured with a reason); no breach. GET /api/v1/autonomy/loops returns metrics_latest.L9; the L9 card shows the numbers.
  TEST: services/gateway/test/vtid-05153-catalog-check-run.test.ts
  TEST: services/gateway/test/vtid-05153-loops-l9-metrics.test.ts
  TEST: services/gateway/test/vtid-05148-loops-l3-metrics.test.ts
  TEST: services/gateway/test/routes/autonomy-loops.test.ts
  CURL: GET /api/v1/autonomy/loops → 401 JSON on staging

## After production (read-only)
The first `supplier-catalog-check` row in `routine_runs` (trigger `gateway-runner`) carries `findings.metrics` with the L9 numbers and `findings.run.candidates ≤ 20`.

## Decisions taken
- Branch base: VTID-05148 (Phase 4) was not yet on `origin/main`, so this branch is based on `origin/claude/vitanaland-loop-engineering-30pws3` (Phase 4's PR branch); the seed migration's timestamp (`20261014000000`) is later than every migration on `origin/main` (latest `20261013233000`).
- The shaped supplier view of `catalog_check` is also applied to the two other supplier-facing reads in the files in scope (`listCatalogue`, which backs the org catalogue list and MCP `list_products`, and `updateProduct`'s response), so no supplier surface returns the hash, fingerprint or duplicate id. The reviewer view (`reviewDetail`) carries the full object.
- The returned-products count is one head count over the org's merchants filtered on `category = supplements` and `attributes->catalog_check->>state = returned_to_supplier` (it is non-zero only for orgs with rows in the wave-1 category). It is advisory: a read error counts as 0 and is logged instead of failing the checklist (the step status never depends on it).
- MCP `next_action` puts the catalogue fixes before `submit_for_verification` when the checklist is otherwise complete (no earlier required step open). Its `supplier_action` is assistant-facing English, like every existing MCP `supplier_action`; the API fields the portal renders stay codes.
- `content_hash` is computed over the normalized (canonical) values, so the routine's own write-back of a normalized field and whitespace-only edits never change it; a real edit does.
- `rows_auto_normalized` counts rows that became `ready_for_review` in the run with no supplier edit since their previous check (or on their first check); a hop-by-hop chain is not stored, so an edit before an earlier failing check is not visible to this count.
- `image_unchecked` rows keep the state their other checks give (a row with no other error is `ready_for_review` with the flag), are re-checked first on the next run, and are not counted in `ready_for_approval_share`. In an outage a failing row keeps its previous strikes and fingerprint.
- Normalization writes back only changed fields whose canonical value exists (an empty string turned missing is judged as missing, never written as NULL). `normalized` lists the fields actually written (empty on a live row).
- Rows whose merchant has no partner organization (portal-created merchants) are checked and grouped by merchant for duplicates; rows of an unknown merchant or a rejected org are skipped.
- `ships_nowhere` is checked directly as well as through ProductSchema's refine, because Zod skips the refine when another field fails to parse.
- A failed result write makes the run `partial` (no breach, no self-healing); a 0-row match is a counted conflict, not a failure.
- Only `loops-catalog.js` changed in the Command Hub, so only its marker was bumped (`20261121-vtid-05153`); `app.js`/`styles.css` keep `20261120-vtid-05148`. Exact-version pins in the VTID-05084, VTID-05098 and VTID-05148 tests and staging suites follow.
- L1's gap text now says "Fourteen deterministic routines" (the count of gateway runner routines, now including supplier-catalog-check, owned by L9); nothing else in L1 changed.
- The VTID-05148 L3 metrics test asserted `METRICS_ROUTINES` and `metrics_latest` to equal the L3-only shape; it now checks the L3 entry and the two-routine map.
- The throwaway Postgres for the migration test ran under `/tmp` (the session scratchpad is not reachable by the unprivileged user Postgres must run as) and was removed after the run.

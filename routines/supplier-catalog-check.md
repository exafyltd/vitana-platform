# Routine: supplier-catalog-check

**Schedule:** `0 13 * * *` (daily 13:00 UTC)
**Runs in:** the gateway's routine runner (`services/gateway/src/services/catalog-check/run.ts`, VTID-05153), once per UTC day at the time above. It records the run in `routine_runs` (`trigger = gateway-runner`). The runner is off unless `ROUTINE_RUNNER_ENABLED=true` and never runs on staging (staging shares the production database).

**Catalog row:** `routines.name = 'supplier-catalog-check'`
**VTID:** `VTID-05153`
**Loop:** L9 Supplier catalog, wave 1 (cases S01 status → next_action, S02 normalize, S03 claim pre-screen only, S05 duplicates, S06 media; S04 certificates deferred)

## Autonomy contract

The routine checks and records. It **never** publishes or unpublishes, never writes `is_active`, `merchant_id`, `listing_hold` or `first_listed_at`, never inserts a row, never edits copy, and calls **no LLM**. The publish gate stays the org review plus the admin's per-offering keep-offline / allow-listing decision (VTID-04933, VTID-04769).

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Rows checked, results written, metrics recorded. |
| 🟡 `partial` | At least one result write failed (no breach, no self-healing). |
| 🔴 `failure` | A Supabase read failed, or the test/service account list could not be read (fail closed: nothing is written). |

## Steps

### 1. Candidates (at most 20 per run)

- `products` with `source_network = 'supplier_referral'` and `category = 'supplements'` (the one wave-1 category), whose merchant is known and whose organization (when it has one) is not `rejected`.
- Rows whose merchant owner or organization owner is in `service_bot_accounts` or `notification_test_actors` are skipped (NEVER rules 43–45; the list is read fail-closed).
- Priority: (1) never checked, changed since the last check (`content_hash`), or last checked while images could not be probed; (2) `needs_fix` with fewer than 3 strikes, last checked more than 20 h ago; (3) `ready_for_review` last checked more than 7 days ago (media re-check). Within a priority: oldest check first, then oldest row. `returned_to_supplier` and `needs_review` rows wait until the supplier edits the row.

### 2. Deterministic checks (`services/catalog-check/validators.ts`)

1. **Normalize (S02).** Lossless canonical form: whitespace trimmed and collapsed in title and brand, ISO codes upper-cased, empty strings dropped, duplicate images removed. The row is then judged by `ProductSchema` (the schema every ingestion path uses). A missing value stays missing and becomes an error; nothing is invented.
2. **Required fields and money.** `isCompleteOffering`, plus: `price_cents` an integer > 0 for a product (stricter than `isCompleteOffering`); `currency` ISO 4217; `compare_at_price_cents ≥ price_cents`; at least one image for a product. Money stays integer minor units.
3. **Duplicates within the supplier (S05).** Keys in order: same `gtin`/`sku` under the same merchant; same canonical `affiliate_url` (lower-case host, `utm_*` stripped); same normalized title. Only rows of the same supplier are compared; the newer row gets `duplicate`.
4. **Media (S06).** `ssrfGuardedHead` (`services/platform-detect.ts`) for at most 3 images per row: HEAD, 5 s, at most 3 redirects with the host re-checked on each, no body read, no credentials; 405/501 → one `GET` with `Range: bytes=0-0`. The content type must be `image/*`. **Outage guard:** when more than half of the run's probes fail at the network level, every row records the flag `image_unchecked` instead of image errors — no strike — and is re-checked first on the next run.
5. **Claim pre-screen (S03).** `services/catalog-check/claim-prescreen.ts`: a short EN/DE list of disease-claim patterns. A hit (`claim_disease_en` / `claim_disease_de`) only moves the row to `needs_review`, where a person decides. Nothing is ever recorded as verified. Phase 6 replaces the implementation behind the same `ClaimCheck` signature.
6. **Certificates (S04): deferred.** Declared certifications are recorded as the flag `certifications_declared`, never as verified.

### 3. The result (`products.attributes.catalog_check`, a reserved key)

```
{ v: 1, state: ready_for_review | needs_fix | needs_review | returned_to_supplier,
  checked_at, content_hash, errors: [{ code, field, params }], flags: [...],
  duplicate_of?, normalized: [fields written back], fingerprint, strikes }
```

- Errors are codes + params, never English text.
- `content_hash`: sha256 over the canonical supplier-mutable fields (title, description, price_cents, compare_at_price_cents, currency, images, affiliate_url, origin_country, ships_to_countries, ships_to_regions, category, attributes without the reserved keys). The routine's own write never changes it.
- **3 strikes.** `strikes` grows while the content and the error `fingerprint` (sorted error codes) stay the same; at 3 the state is `returned_to_supplier`. A supplier edit (new `content_hash`) starts over.
- **Write.** Service role, one PATCH per row, only when the row is unchanged since the read (filters on id, the validated scalars, every written field's read value and jsonb equality on `attributes`). A concurrent edit matches 0 rows (`write_conflicts`) and the row is checked again next run. Normalized fields are written back only to rows that are not live. The SET is only `attributes` plus normalized fields.
- `ProductFields.attributes` drops `admin_listing` and `catalog_check` from supplier input; `updateProduct` keeps the stored values.

### 4. Back to the supplier

- Checklist: the `catalogue` step gets `missing: ['catalogue_fixes']` and `detail.returned_products` (its status does not change — lifecycle, submit and go-live behave as before).
- MCP: `next_action` → `{ step: 'catalogue', tool: 'update_product' }` when no earlier required step is open; `list_products` shows each row's `check { state, codes }`.
- Supplier portal `GET /products` and the org catalogue list show `catalog_check` shaped: `{ state, errors: [{ code, field }], strikes }` (a duplicate carries the other row's title, never its id).
- Reviewer: `GET /api/v1/admin/partner-review/:orgId` shows the full `catalog_check` next to `admin_listing`.

## Metrics (`findings.metrics`)

- `rows_checked`, `rows_auto_normalized` (rows that became `ready_for_review` with no supplier edit since their previous check), `validation_failure_rate` (needs_fix + returned / rows checked in the run), `ready_for_approval_share` (`ready_for_review` with images checked / every category row with a result; **target 0.80**), `by_state`, `by_error_code`.
- `time_to_listing`, `human_edits_per_listing`: `{ state: 'not_measured', reason }` — no number is invented.
- `findings.run`: pool size, excluded rows, candidates, probes (`total`, `network_errors`, `outage`), `write_conflicts`, `write_errors`.

## Breach

None in wave 1. Poor supplier data is not a code failure and is never routed to self-healing. A crashed run is `failure`; the runner's stagnation stop applies.

## Where the numbers show

`GET /api/v1/autonomy/loops` → `metrics_latest.L9`; the L9 card on Command Hub → Autonomy → Loops.

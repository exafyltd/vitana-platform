# VTID-05488 — mt-discover-r2 / supplier-relationships-db

Plan: `.kiro/specs/mt-discover-r2/plan.md` (Fix item `supplier-relationships-db`, Migrations, Tests) and the
`supplier-relationships-db` group of `tasks.md` (D1-D6). Sparring record: `plan-sparring.md`.

VALIDATION_PROFILE: database (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md §7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| D1 table + RLS + Maxina seed | `supabase/migrations/20261102120000_vtid_05488_supplier_tenant_relationships.sql` |
| D2 `products.distribution` | `supabase/migrations/20261102120100_vtid_05488_products_distribution.sql` |
| D3 `partner_tenant` backfill | `supabase/migrations/20261102120200_vtid_05488_partner_tenant_backfill.sql` |
| D4 helper + tenant-scoped policies | `supabase/migrations/20261102120300_vtid_05488_products_merchants_tenant_rls.sql` |
| D5 rollbacks | `rollback-120300-…`, `rollback-120200-…`, `rollback-120100-…`, `rollback-120000-…` (apply in that order) |
| D5 read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| D5 queue / drift | `docs/multitenancy/MIGRATION-QUEUE.md` rows 26-29; `scripts/ci/migration-drift-baseline.json` (+2 not-yet-live tables, count 112) |
| D6 pgTAP | `pgtap/vtid_05488_supplier_tenant_relationships.test.sql` (79 cases) + `pgtap/vtid_05488_fixture.sql` |
| static gate | `services/gateway/test/vtid-05488-supplier-tenant-relationships.test.ts` |

Apply order: 120000 → 120100 → 120200 → 120300. Rollback order: 120300 → 120200 → 120100 → 120000 (each later rollback
refuses while a policy still reads what it would drop).

## Acceptance

AC-1 (D1) `supplier_tenant_relationships(id, merchant_id, partner_organization_id, tenant_id → tenants, status
proposed|active|declined|suspended, vertical_key, created_at, updated_at, decided_at)`. A member of T_B reads 0 T_A rows;
members read only their tenant's rows through an inline `user_tenants` EXISTS on `auth.uid()`; `service_role` has ALL;
authenticated has no write privilege; anon has no access. Every merchant that exists is `active` for Maxina and for no
other tenant.
TEST: pgTAP cases 1-12 and 18-35.

AC-2 (D2) `products.distribution text NOT NULL DEFAULT 'community'` with a `community|network` CHECK; the default stays;
every existing product is `community`; a writer that omits the column gets `community`.
TEST: pgTAP cases 8, 13-17, 21.

AC-3 (D3) `partner_tenant` is snapshotted into `bak_vtid_05488_partner_tenant` first; `partner_tenant.tenant_uuid` holds
the real tenant only for an unambiguous row (a uuid text of exactly one tenant, or a slug of exactly one tenant, and not
both readings naming different tenants); everything else is NULL.
TEST: pgTAP cases 36-45.

AC-4 (D4) `discover_tenant_gate_enabled()` is STABLE SECURITY DEFINER with `search_path = public, pg_catalog`. Non-NULL
tenant: that tenant's flag, false without a `tenant_settings` row, false for an absent / false / junk flag. NULL tenant:
true iff any tenant has the gate on (global coupling by design, fail closed: a tenant-less session turns network-only as soon as ANY tenant enables the gate; owner to confirm). The policies wrap the helper and `current_tenant_id()` as `(SELECT ...)` InitPlans and the helper resolves the tenant once. Gate off everywhere ⇒ `products_select` / `merchants_select` return exactly the
`is_active`-only rows for every user including a NULL tenant. Gate on ⇒ a T_B user reads 0 T_A-only supplier rows, a
`network` product is visible to both tenants, a NULL tenant sees network rows only and never errors, a suspended or
declined relationship grants nothing, `is_active` still filters. No `is_member()` / `tenant_id_for_policies()`
reference anywhere. No `product_orders` column.
TEST: pgTAP cases 3-5, 9-12, 46-79.

AC-5 (D5) each migration is idempotent, runs `SET LOCAL lock_timeout = '3s'` with up to 5 retries on
`lock_not_available`; four rollbacks, three read-only check files, queue rows 26-29 (`queued (pending owner approval)`),
drift baseline entries.
TEST: `outputs/read-only-checks-and-rollback-pglite.txt`, the gateway static test.

## Evidence (all local, PGlite = PostgreSQL 18 wasm; `pglite-harness/`)

| Run | Result |
|---|---|
| `outputs/pgtap-green-live-schema.txt` | 79 ok, 0 not ok (tenants keyed by `tenant_id`, the live key) |
| `outputs/pgtap-green-applied-twice.txt` | 79 ok: all four migrations applied twice (idempotent) |
| `outputs/pgtap-green-bootstrap-id-schema.txt` | 79 ok: tenants keyed by `id` (bootstrap), same unmodified migrations |
| `outputs/pgtap-red-no-migrations.txt` | RED: SQL error, no lane object exists (origin/main state) |
| `outputs/pgtap-red-without-rls-migration.txt` | RED: 27 not ok with 120000-120200 applied but not 120300 |
| `outputs/read-only-checks-and-rollback-pglite.txt` | live-before, post-apply-checks, all four rollbacks, rollback-check, re-apply |
| `outputs/jest-vtid-05488.txt` | the gateway static test |

## Deviations and limits (honest record)

* **pgTAP file location.** The lane's `paths` do not include `supabase/tests/`, and Lane scope rejects a file outside
  `paths`, so the pgTAP file and its fixture live under `docs/validation/VTID-05488/pgtap/` (exempt). CI's `supabase test db`
  does not pick it up there; moving it to `supabase/tests/` needs the lane `paths` widened by the owner. The file is
  written in real pgTAP syntax (`SELECT plan(79)`, `has_table`, `has_function`, `throws_ok`, `lives_ok`, `is`, `ok`).
* **D3 is expand-only.** `partner_tenant` is Prisma-managed with `tenant_id TEXT NOT NULL`, read and written as free text
  by the VCAOP gateway code (`.eq('partner_tenant.tenant_id', …)`). Retyping that column in place would break those
  writers at apply time, so the real tenant goes into the new nullable `tenant_uuid` and the text column is untouched.
  The contract step (writers move, then the text column goes) is a later, separately approved change. This is the
  plan's "free-text → real tenant UUID or NULL (platform)" with the safe conversion the plan asked for.
* **"Existing network merchants" = every existing merchant.** The schema has no separate network flag on `merchants`;
  today every authenticated user reads the whole active catalogue, so seeding all existing merchants active for Maxina
  keeps Maxina's gate-on catalogue equal to today's.
* **Tenants key.** The live key is `tenants.tenant_id` (VTID-04716); the bootstrap has `tenants.id`. The migrations
  resolve whichever exists, and the PGlite runs cover both.
* **Flag parsing.** The helper treats only the JSON value `true` (or the string `"true"`) as on, instead of casting to
  boolean, so a junk value in `tenant_settings.feature_flags` can never make every product read raise.
* **Vertical.** `vertical_key` is nullable text (NULL = the whole supplier); the policy does not filter by vertical yet.
* Local runs use stand-in tables and the REAL `current_tenant_id()` taken unmodified from
  `20260218000000_fix_maxina_signup_tenant_association.sql`. The full production schema and real pgTAP were not available
  (no docker, psql, supabase CLI): CI's pgTAP and the owner-approved read-only checks are authoritative.

## Review round 2 (2026-11-07-121500) disposition

1. D2 VALIDATE removed (fixed): the CHECK stays NOT VALID inside the ADD COLUMN transaction; the new column only holds the compliant default, so no scan under ACCESS EXCLUSIVE. Comment corrected.
2. Per-row gate cost (fixed): `(SELECT ...)` InitPlans in both policies, single tenant resolution in the plpgsql helper, same semantics incl. the NULL-tenant branch. An EXPLAIN on a realistic catalogue is a staging pre-apply step (no live SQL here).
3. New merchants (documented): `post-apply-checks.sql` check 7 asserts seeded rows = merchants_total and lists merchants without a Maxina row; rollout note: every new merchant needs an active relationship row before a tenant enables the gate.
4. NULL-tenant coupling (documented): above and in MIGRATION-QUEUE row 29.
5. pgTAP not run by CI (not fixed, justified): the lane's allowed paths exclude `supabase/tests/`; the suite is evidence, with the PGlite harness reproducing it. Moving it is a follow-up outside this lane.
6. Stand-in schema (not fixable here, justified): no live SQL is allowed; `live-before.sql` and `post-apply-checks.sql` are the staging procedure.
7. Slug collisions (fixed): `live-before.sql` check 7 lists partner keys colliding with tenant slugs.

# VTID-05506 — mt-m3-r2 / provision-erp-monitoring-db

Plan: `.kiro/specs/mt-m3-r2/plan.md` and the `provision-erp-monitoring-db` group of `tasks.md` (E1-E4). Sparring record:
`plan-sparring.md`.

VALIDATION_PROFILE: database (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md §7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| E1 provision_tenant records the ERP request; `erp` governed in the merge function | `supabase/migrations/20261102141000_vtid_05506_mt_provision_erp_request.sql` |
| E2 per-tenant isolation health | `supabase/migrations/20261102141100_vtid_05506_mt_isolation_health_by_tenant.sql` |
| rollbacks | `rollback-141100-isolation-health-by-tenant.sql`, then `rollback-141000-provision-erp-request.sql` |
| read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| E4 queue | `docs/multitenancy/MIGRATION-QUEUE.md` rows 61-62 + Notes bullet; `scripts/ci/migration-drift-baseline.json` untouched (no new table) |
| E3 pgTAP | `pgtap/vtid_05506_erp_monitoring.test.sql` (60 cases) |

Apply order: 141000 → 141100. Rollback order: 141100 → 141000.

## Acceptance

AC-1 (E1) `provision_tenant()` keeps its signature, body, return value, `SECURITY DEFINER`, `search_path = public` and
service_role-only grant, and additionally records `tenant_settings.feature_flags.erp.bootstrap_requested = true`. The flag
is set by a guarded UPDATE after the `tenant_settings` INSERT ... `ON CONFLICT DO NOTHING`, so it is recorded on the first
provisioning AND on a re-run of an already provisioned tenant (including one provisioned before this migration). The
guard is `IS DISTINCT FROM 'true'::jsonb`, so a re-run with the flag already true writes nothing (`updated_at`
untouched). Other `erp` subkeys are kept; a non-object `erp` value (string, JSON null, array) is repaired.
TEST: pgTAP cases 1-26.

AC-2 (E1) `erp` is a governed key of `tenant_settings_merge_feature_flags()`: with `p_allow_governed = false` both `jev`
and `erp` are dropped from the caller's object (update and insert paths), the stored values stay intact, ordinary keys
still merge; with `p_allow_governed = true` (exafy_admin) `erp` and `jev` can be replaced. Still `SECURITY INVOKER`,
pinned search_path, service_role only.
TEST: pgTAP cases 27-36.

AC-3 (E2) `ci_tenant_isolation_health_by_tenant()` returns `{generated_at, tenants[], totals{}, scan_errors[]}` with the
same nine counts as `ci_tenant_isolation_health()` per tenant. Every registered tenant is listed (zeros included); a
dangling tenant id gets its own row (`is_registered = false`, `slug` null); counts that have no tenant (null `tenant_id`
rows, users with zero / several primary tenants, auth users without membership) sit in exactly one row with
`tenant_id` null. For every column the rows sum to `ci_tenant_isolation_health()` and `totals` equals that sum. Each
table is scanned in its own exception block. STABLE SECURITY DEFINER, `search_path = public, pg_catalog`, service_role
only. `ci_tenant_isolation_health()` is untouched (body md5 pinned).
TEST: pgTAP cases 37-60.

AC-4 (E4) both migrations are guarded, idempotent (applied twice), expand-only, take `lock_timeout`, add no table and no
policy (`bare-policy-lint` reads 0); two rollbacks (restoring the VTID-05150 bodies byte for byte), three read-only check
files, queue rows 61-62 (`queued (pending owner approval)`).
TEST: `outputs/pgtap-green-applied-twice.txt`, `outputs/read-only-checks-and-rollback-pglite.txt`.

## Evidence (all local, PGlite = PostgreSQL 18 wasm; `pglite-harness/`)

| Run | Result |
|---|---|
| `outputs/pgtap-red-no-migrations.txt` | RED on origin/main (no lane migration): 31 not ok |
| `outputs/pgtap-red-without-by-tenant.txt` | RED with only 141000 loaded: 20 not ok (the whole by-tenant section) |
| `outputs/pgtap-green.txt` | 60 ok, 0 not ok |
| `outputs/pgtap-green-applied-twice.txt` | 60 ok: both migrations applied twice (idempotent) |
| `outputs/mutations.txt` | six mutations of the migrations each turn the pgTAP file red; restored -> 60 ok |
| `outputs/read-only-checks-and-rollback-pglite.txt` | live-before, post-apply-checks, both rollbacks, rollback-check (the three body md5 values equal live-before), re-apply |

## Decisions taken (conservative choices inside the approved plan)

1. **IS DISTINCT FROM, not the plan's `NOT (x = 'true')`.** The plan's literal guard is NULL when the path
   `erp.bootstrap_requested` is absent, so the UPDATE would never run for a tenant provisioned before this migration or
   right after the INSERT. `IS DISTINCT FROM 'true'::jsonb` treats an absent path as "not true". Pinned by cases 1, 14
   and mutation 1.
2. **The UPDATE also sets `updated_at = now()`** (only when it writes), nothing else in the row; `updated_by` is left
   alone because a re-run by another exafy_admin is not an edit by that admin.
3. **A `false` flag becomes `true`.** The flag records "an ERP bootstrap was requested by provisioning"; a consumer
   that completes a bootstrap would use its own subkey, which is kept (case 16).
4. **Rollbacks live in `docs/validation/VTID-05506/`**, not `supabase/migrations/`, although the lane `paths` also allow
   `*_rollback.sql` there: such a file shares the forward file's version and sorts after it ("." < "_"), so a full
   replay would undo the migration right after applying it (same decision as VTID-05507).
5. **The 141000 rollback restores both previous bodies and leaves stored data alone.** `erp.bootstrap_requested` flags
   already written stay in `feature_flags` (harmless without a reader); removing them is a data write the owner may
   decide separately.
6. **The by-tenant function sums dangling tenants into `foreign_tenant_rows`** exactly as the single-number function
   does (it counts any row whose tenant id is not in `tenants`, in every uuid `tenant_id` table including `memberships`
   and `user_tenants`), and attributes `memberships_not_in_user_tenants` / `user_tenants_not_in_memberships` to the
   tenant id on the row, so every column sums back to `ci_tenant_isolation_health()`.
7. **Queue rows are numbered 61 and 62** (rows 1-47 are on main; 48-60 are reserved for other lanes). The row numbers
   may shift at landing.
8. **`scripts/ci/migration-drift-baseline.json` is not edited**: the lane creates no table.
9. **The existing `supabase/tests/vtid_05150_provision_tenant.test.sql` is not edited** (outside the lane `paths`). It
   runs on the 05150 migrations only, where `feature_flags` still equals the jev object; after 141000 is applied the
   same assertion would see the extra `erp` key, which `pgtap/vtid_05506_erp_monitoring.test.sql` case 2 pins.

## Limits (honest record)

* **pgTAP file location.** The lane `paths` do not include `supabase/tests/`, so the pgTAP file lives under
  `docs/validation/VTID-05506/pgtap/`. CI's `supabase test db` does not pick it up there; the file is written in real
  pgTAP syntax. Local runs load the real VTID-05149/05150 migrations on the VTID-05150 fixture (stand-in tables with the
  live columns). No docker, psql or supabase CLI was available: the owner-approved read-only checks are authoritative
  after apply.
* The harness replaces `CREATE EXTENSION pgcrypto` with a `public.gen_random_bytes(int)` shim (random-looking, not
  cryptographic) because PGlite is run without contrib.

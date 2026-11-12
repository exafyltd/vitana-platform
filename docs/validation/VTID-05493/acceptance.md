# VTID-05493 — mt-tenant-admin-r2 / tenant-lifecycle-db

Plan: `.kiro/specs/mt-tenant-admin-r2/plan.md` and the `tenant-lifecycle-db` group of `tasks.md` (L1-L4, CROSS-SPEC O2).
Sparring record: `plan-sparring.md`.

VALIDATION_PROFILE: database (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md §7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| L1 `deactivate_tenant(slug)` + snapshot | `supabase/migrations/20261102070300_vtid_05493_mt_tenant_deactivate.sql` |
| L2 `archive_tenant(slug)`, `tenants.archived_at`, closing switch RPC | `supabase/migrations/20261102070350_vtid_05493_mt_tenant_archive_switch.sql` |
| rollbacks | `rollback-070350-tenant-archive-switch.sql` then `rollback-070300-tenant-deactivate.sql` |
| read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| L3 pgTAP | `pgtap/vtid_05493_tenant_lifecycle.test.sql` (72 cases) + `pgtap/vtid_05493_fixture.sql` |
| L4 queue / drift | `docs/multitenancy/MIGRATION-QUEUE.md` rows 30-31 (numbering may shift at landing); `scripts/ci/migration-drift-baseline.json` (+1 not-yet-live table, count 113) |
| static gate | `static-pins.test.mts` (25 cases, `node --test`, no dependencies) |

Apply order: 070300 → 070350. Rollback order: 070350 → 070300 (the second refuses while `archive_tenant` exists).

## Acceptance

AC-1 (L1) `deactivate_tenant(slug)` sets `tenants.is_active = false`, idempotently: the first call returns
`changed:true`, a repeat `changed:false`; the slug is trimmed and lower-cased; blank/NULL → `INVALID_SLUG`, unknown →
`TENANT_NOT_FOUND`, the default tenant → `DEFAULT_TENANT_PROTECTED`, a platform tenant → `PLATFORM_TENANT_PROTECTED`
(SQLSTATE 22023). SECURITY DEFINER, `search_path = public, pg_catalog`; EXECUTE for `service_role` only. No other tenant,
membership or setting row is touched. A snapshot of `is_active` is taken first into `bak_vtid_05493_tenant_lifecycle`,
closed to `authenticated` and `anon`.
TEST: pgTAP cases 1, 4-7, 11, 16-17, 26-36.

AC-2 (L2) `archive_tenant(slug)` sets `is_active = false` and `archived_at = now()` (kept if already set), idempotent,
same guards and grants; an already-deactivated tenant can be archived; deactivating an archived tenant changes nothing.
`tenants.archived_at` is a nullable `timestamptz` added with a lock timeout and retries (expand only).
TEST: pgTAP cases 2-3, 8-10, 55-70.

AC-3 (L2) The closing switch change: `switch_to_tenant_by_slug` keeps the VTID-05043 contract (open_signup join, 42501
`TENANT_NOT_JOINABLE`, grants). A member whose requested tenant is deactivated or archived resolves to the default
tenant, never a lockout; the rest of the function then runs against it. The membership rows in the deactivated tenant are
kept. A non-member cannot reach a deactivated tenant. An exafy admin still switches to it and still reads its row. The
audit row names the tenant entered plus `requested_slug` and `fallback:true`; a repeat call writes nothing.
TEST: pgTAP cases 12-15, 18-25, 37-54, 60-61, 71.

AC-4 (L3) pgTAP: idempotent RPCs; a deactivated tenant's member resolves to the default; an exafy admin can still read
it; the rollback restores the prior state (below).
TEST: `outputs/pgtap-green.txt`, `outputs/pgtap-green-applied-twice.txt`.

AC-5 (L3) Rollback restores prior state: after the rollbacks `deactivate_tenant`, `archive_tenant` and `archived_at` are
gone, the switch body is the VTID-05043 one (no `is_default`), and every tenant's `is_active` equals the snapshot.
TEST: `outputs/read-only-checks-and-rollback-pglite.txt` (rollback-check: `tenants_differing_from_snapshot 0`).

AC-6 (L4) Queue rows and drift baseline: rows 30-31 `queued (pending owner approval)`; `bak_vtid_05493_tenant_lifecycle`
listed in the drift baseline while unapplied.
TEST: `outputs/static-pins-green.txt`, `node --test scripts/ci/check-migration-drift.test.cjs`.

## Evidence (all local, PGlite = PostgreSQL 18 wasm; `pglite-harness/`)

| Run | Result |
|---|---|
| `outputs/pgtap-red-no-migrations.txt` | RED on the origin/main state: SQL error, no lane object exists |
| `outputs/pgtap-red-without-070350.txt` | RED with only 070300 applied |
| `outputs/pgtap-red-mutation-no-fallback.txt` | RED: 6 not ok when the inactive-tenant fallback is disabled in 070350 |
| `outputs/pgtap-green.txt` | 72 ok, 0 not ok |
| `outputs/pgtap-green-applied-twice.txt` | 72 ok: both migrations applied twice (idempotent) |
| `outputs/read-only-checks-and-rollback-pglite.txt` | live-before, post-apply-checks, use, rollbacks, rollback-check, re-run |
| `outputs/static-pins-red-on-origin-main.txt` | 25 failed on origin/main |
| `outputs/static-pins-green.txt` | 25 passed |

## Deviations and limits (honest record)

* **pgTAP location.** The lane `paths` do not include `supabase/tests/`; the pgTAP file lives under
  `docs/validation/VTID-05493/pgtap/` (exempt), written in pgTAP syntax. CI's `supabase test db` does not pick it up there.
* **Static gate location.** The lane `paths` do not include `services/gateway/test/`, so the static pins are a dependency-free `node --test` file under `docs/validation/VTID-05493/` (exempt); CI's gateway Jest does not pick it up.
* **Staging manifest.** `staging-tests.json` first named the `node --test` static file, which the staging-verify validator refuses (`EXISTING_REF`, `scripts/ci/staging-verify/lib.cjs`), and the gateway Jest config does not collect a file under `docs/validation/`. It now holds one read-only http probe (`GET /api/v1/admin/tenants`, expect 401: the existing admin route is still mounted and auth-gated). The static pins stay a CI/local gate. Validator output: `outputs/staging-manifest-validate.txt`.
* **Lane file and spec paths.** The lane's `paths` name `supabase/migrations/20261102070300_vtid_*_mt_tenant_deactivate.sql`
  and `…070350_vtid_*_mt_tenant_archive_switch.sql`; the files use VTID-05493 in the glob.
* **`current_tenant_id()` is not changed.** About 50 RLS policies read it; the claim the gateway reads is set by the
  switch RPC, which is the resolution point the spec names. Changing the helper is a separate, separately sparred decision.
* **The default tenant must be joinable.** If a member of a deactivated tenant is not yet a member of the default
  tenant, the fallback follows the existing rule: it joins only if the default tenant is `open_signup` (Maxina is);
  otherwise `TENANT_NOT_JOINABLE`. Owner to confirm if the default tenant is ever made invite-only.
* **Rollback of data.** The snapshot holds `is_active` at apply time; the rollback sets it back for tenants in the
  snapshot (for 070350 only archived ones, for 070300 all). A tenant created after apply is left as it is. The VTID-05043
  body restored by rollback-070350 is the migration body, not a live capture (`live-before.sql` records its md5).
* Local runs use stand-in tables and the REAL 05043 switch body; CI's pgTAP and the owner-approved read-only checks are
  authoritative.

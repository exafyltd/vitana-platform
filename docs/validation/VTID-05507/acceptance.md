# VTID-05507 — mt-m3-r2 / tenant-domains-db

Plan: `.kiro/specs/mt-m3-r2/plan.md` and the `tenant-domains-db` group of `tasks.md` (D1-D4). Sparring record:
`plan-sparring.md`.

VALIDATION_PROFILE: database (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md §7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| D1 table, RLS, host rules, reserved-slug trigger | `supabase/migrations/20261102140000_vtid_05507_mt_tenant_domains.sql` |
| D2 host arm overload | `supabase/migrations/20261102140100_vtid_05507_mt_resolve_tenant_host.sql` |
| rollbacks | `rollback-140100-resolve-tenant-host.sql`, then `rollback-140000-tenant-domains.sql` |
| read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| D4 queue / drift | `docs/multitenancy/MIGRATION-QUEUE.md` rows 30-31 + range note; `scripts/ci/migration-drift-baseline.json` (+`tenant_domains`, count 113) |
| D3 pgTAP | `pgtap/vtid_05507_tenant_domains.test.sql` (48 cases) + `pgtap/vtid_05507_fixture.sql` |

Apply order: 140000 → 140100. Rollback order: 140100 → 140000 (the 140000 rollback refuses while the two-argument
overload exists).

## Acceptance

AC-1 (D1) `tenant_domains(id, tenant_id → tenants ON DELETE CASCADE, host, is_primary, verified_at, created_at)`; `host`
unique, stored lower-case and trimmed, DNS-name format CHECK (1..253 chars); at most one primary host per tenant; RLS
enabled with NO client policy; anon and authenticated hold no privilege; service_role has full access.
TEST: pgTAP cases 1-22 and 48.

AC-2 (D1) a host equal to a reserved tenant slug is rejected on INSERT and on UPDATE OF host by a
`BEFORE INSERT OR UPDATE OF host` trigger that reads `reserved_tenant_slugs` (a CHECK cannot read another table);
updating another column is not blocked.
TEST: pgTAP cases 23-27.

AC-3 (D2) `resolve_tenant(p_host text, p_slug text)` is a separate overload with no parameter defaults. A host resolves
only when its row has `verified_at IS NOT NULL` and only through `_tenant_public_registry()`; an unverified host, or a
host on an inactive or platform tenant, resolves empty and falls through to the slug arm; a verified host wins over the
slug; NULL/NULL resolves empty.
TEST: pgTAP cases 28-39.

AC-4 (D2) the VTID-05151 one-argument `resolve_tenant(p_slug)` is untouched (body md5 equals the migration's), a
`{p_slug}`-only call still binds it, both overloads return the same 8 columns, no `tenant_domains` column is returned,
anon can execute both, the internal registry stays non-executable by anon.
TEST: pgTAP cases 40-47.

AC-5 (D4) both migrations are idempotent (D1 runs `SET LOCAL lock_timeout = '3s'` with up to 5 retries on
`lock_not_available`; D2 runs `lock_timeout 3s`), expand-only; two rollbacks, three read-only check files, queue rows
30-31 (`queued (pending owner approval)`), drift baseline entry. `bare-policy-lint` still reads 0.
TEST: `outputs/read-only-checks-and-rollback-pglite.txt`, `outputs/pgtap-green-applied-twice.txt`.

## Evidence (all local, PGlite = PostgreSQL 18 wasm; `pglite-harness/`)

| Run | Result |
|---|---|
| `outputs/pgtap-green.txt` | 48 ok, 0 not ok (tenants keyed by `tenant_id`, the live key) |
| `outputs/pgtap-green-applied-twice.txt` | 48 ok: both migrations applied twice (idempotent) |
| `outputs/pgtap-red-no-migrations.txt` | RED: SQL error, no lane object exists (origin/main state) |
| `outputs/pgtap-red-without-host-arm.txt` | RED: SQL error, `resolve_tenant(text, text)` missing when only 140000 is applied |
| `outputs/mutations.txt` | three mutations of the migrations each turn the pgTAP file red |
| `outputs/bootstrap-id-schema-d1.txt` | D1 on the bootstrap key (`tenants.id`): FK resolves to `tenants(id)` |
| `outputs/read-only-checks-and-rollback-pglite.txt` | live-before, post-apply-checks, both rollbacks, rollback-check, re-apply |

## Deviations and limits (honest record)

* **Rollback location.** The rollbacks live in `docs/validation/VTID-05507/` (as VTID-05488 did), not in
  `supabase/migrations/` as the lane's path list also allows. A `…_rollback.sql` next to the forward file shares its
  version number (`20261102140000`) and sorts AFTER the forward file ("." < "_"), so a full replay would drop the table
  right after creating it.
* **`host` is `text` with a lower-case CHECK, not `citext`.** No migration in this repository creates the `citext`
  extension, so depending on it would add an unverified live prerequisite. `CHECK (host = lower(btrim(host)))` plus the
  unique constraint gives the same case-insensitive uniqueness; the resolver lower-cases and trims its input.
* **"exafy-admin can write."** There is no client policy by design: the admin API reaches the table with the service
  role (which bypasses RLS), so an `exafy_admin` JWT has no direct table access. This matches the lane text
  "RLS enabled with NO client policy (service-role/exafy-admin only)".
* **pgTAP file location.** The lane `paths` do not include `supabase/tests/`, so the pgTAP file and fixture live under
  `docs/validation/VTID-05507/pgtap/`. CI's `supabase test db` does not pick it up there; the file is written in real
  pgTAP syntax. Local runs use stand-in tables and the REAL `20261014000600` registry migration. No docker, psql or
  supabase CLI was available: the owner-approved read-only checks are authoritative after apply.
* **Queue numbering.** Rows 30-31 follow the last row on origin/main (29); rows 21-25 belong to VTID-05571 and the
  tenant-lifecycle lane adds rows too, so the numbers may shift at landing.

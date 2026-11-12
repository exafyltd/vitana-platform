# VTID-05595 - mt-native-health-r2 / health-home-tenant-db

Plan: `.kiro/specs/mt-native-health-r2/plan.md` (Fix item `health-home-tenant-db`) and the `health-home-tenant-db` group of
`tasks.md` (H1-H4). Sparring record: `plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md section 7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| H1 column + FK + index | `supabase/migrations/20261102130000_vtid_05595_health_home_tenant_column.sql` |
| H2 resolver + batched backfill + guard | `supabase/migrations/20261102130100_vtid_05595_health_home_tenant_resolver_backfill.sql` |
| H3 queue rows 43-44 | `docs/multitenancy/MIGRATION-QUEUE.md` |
| H4 pgTAP | `services/gateway/test/mt-native-health/health-home-tenant.pgtap.sql` (40 cases) |
| rollbacks | `rollback-130100-...sql` then `rollback-130000-...sql` |
| read-only checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |

Apply order: 130000 then 130100. Rollback order: 130100 then 130000.

## Acceptance

Change types: Database.

AC-1 (H1) `app_users.health_home_tenant_id uuid NULL` references `tenants`, with a partial index; expand only, no row changes.
TEST: pgTAP cases 3, 4 and 35.

AC-2 (H2) `health_home_tenant_id(uuid)` is STABLE SECURITY DEFINER with a pinned search_path, never reads app_metadata, a JWT
claim or the session tenant, and returns `coalesce(column, the single primary user_tenants row)`; an ab_dual member
resolves to the same tenant whichever tenant the session carries; 0 or 2+ primary rows resolve to NULL; only
`service_role` can execute it.
TEST: pgTAP cases 5-17 and 31.

AC-3 (H2/H4) The backfill freezes only members with exactly one primary row and a NULL column, in batches, snapshotting
each first to `legacy_archive.bak_05595_health_home_tenant` (previous value, 30-day retention, not readable by members);
it is idempotent and never overwrites a frozen value; members with 0 or 2+ primary rows stay NULL.
TEST: pgTAP cases 18-30 and 32-34.

AC-4 (H2) The file opens with a `RAISE EXCEPTION` guard that aborts, changing nothing, unless every member has exactly one
primary `user_tenants` row (round-1 F6). A member cannot write the column, and the batch size is validated.
TEST: `pglite-harness/checks.sh guard` -> `outputs/guard-refuses-ambiguous-members.txt`; pgTAP cases 36-39.

AC-5 (rollback and checks) Both migrations are reversible and re-appliable; the pre-check counts ambiguous members; the
post-check asserts every member has a home tenant; the rollback check proves the column and functions are gone and the
snapshot is kept.
TEST: `pglite-harness/checks.sh` -> `outputs/read-only-checks-and-rollback-pglite.txt` (25 checks, all true).

AC-6 (H3) `docs/multitenancy/MIGRATION-QUEUE.md` rows 43-44 sit after row 42 and cite rows 14-16 (membership unification),
the rollback paths and the read-only pre/post-checks; the bare-policy lint still passes (the files add no RLS policy).
TEST: `outputs/jest-bare-policy-lint.txt` (8 pass); `validateManifest(staging-tests.json)` ok.

## Red on main, green on the branch

- Red: `lane.sh --no-migrations` (origin/main has neither migration) -> `outputs/pgtap-red-no-migrations.txt`;
  `lane.sh --only-column` -> `outputs/pgtap-red-column-only.txt`.
- Red by mutation: a resolver that prefers a session claim -> `outputs/pgtap-red-mutation-session-tenant-resolver.txt`
  (cases 7, 9 fail); a backfill without the exactly-one-primary filter -> `outputs/pgtap-red-mutation-backfill-ambiguous.txt`
  (cases 21, 27, 30, 32-34 fail).
- Green: `outputs/pgtap-green-live-schema.txt`, `pgtap-green-applied-twice.txt`, `pgtap-green-bootstrap-id-schema.txt` (40 ok each).

## Decisions taken

- Live tenants key is `tenants(tenant_id)` (VTID-04716); the FK resolves `tenant_id` else `id`, as VTID-05488 does. The design says `tenants(id)`.
- The FK is NO ACTION on delete: a tenant that holds a member's frozen health home cannot be deleted by accident.
- The guard (every member exactly one primary) is stricter than "leave 0 or 2+ NULL"; both hold: the guard gates the apply, and the callable backfill still leaves such members NULL.
- The snapshot lives in `legacy_archive` (like VTID-05491), outside `public`, so the drift baseline needs no change.
- The backfill is a separate service_role-only function so pgTAP can drive it on its own rows.
- `tasks.md` names `services/gateway/test/mt-native-health-r2/`; the lane file (`mt-native-health/`) governs.

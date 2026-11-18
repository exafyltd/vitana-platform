# VTID-05803 staging schema restore (single implementation)

The native PostgreSQL 17 dump of the source `public` schema is the base. It carries tables, constraints, indexes,
functions, triggers, views, RLS policies and privileges. No data is copied. Kiro 1's and Kiro 4's verified fixes are
integrated here, so there is one path: no delta schema-sync, FK-recreate, grants or RLS scripts, and no vector
pre-load or post-load.

## Run order (`run-staging.sh`, bash)
1. The commit and its checksums (`SHA256SUMS`) are verified.
2. `dump-schema.sh` reads `SOURCE_URI`, which must be the session pooler on 5432. It runs read-only and writes:
   - `sql/base-schema-public.sql`: `pg_dump --schema-only --no-owner --schema=public --no-publications
     --no-subscriptions --no-security-labels --lock-wait-timeout=30s`. It refuses data sections, a missing
     dump-complete trailer, a pg_dump major version other than 17, and replication or foreign-server objects. It
     rewrites `CREATE SCHEMA public;` to `IF NOT EXISTS` and counts the rewrite.
   - `sql/auth-users-stub.sql`: an empty `auth.users` with the source's column names and types, a primary key on
     `id` only, and no rows, defaults or triggers. Views and policies over `auth.users` restore unchanged (Kiro 1).
   - `sql/extensions.sql`: each approved extension in the schema the source has it in (Kiro 1 measured this). For
     example, `pg_trgm` stays in `public` because `gin_trgm_ops` is referenced as `public.gin_trgm_ops`.
   - `sql/source-counts.txt`: the live source probe (`sql/parity-probe.sql`), which is the parity baseline.
3. `schema-restore.sh` runs read-only gates first:
   - inputs and the exact staging writer `vitana`;
   - dump integrity;
   - production references. COMMENT text is ignored. A function body may name the production host only if
     `outbox-replacement-staging-invalid-host.sql` redefines that function in the same transaction.
   - a PostgreSQL 17 writer with an empty `public` schema.

   Then it applies the extensions, the stub and (with `AUTH_HELPERS=approved`) `auth-helpers-production-definitions.sql`,
   and checks the preconditions.
   - **Absent roles** (`filter-absent-roles.py`, Kiro 1): permissive policies and grants that name a role absent on
     staging are left out and logged in `absent-role-exclusions.log`. A RESTRICTIVE policy for an absent role stops
     the run before the load, because leaving it out would widen access.
   - **One transaction:** the filtered dump, `RESET ALL`, the staging outbox (`outbox-table-and-helpers.sql`, then
     `outbox-replacement-staging-invalid-host.sql`, both byte-identical to 0730de73), and
     `r2-exclude-auth-users-fks.sql`.
   - **R2:** public→auth.users FKs are excluded, because on an empty stub every member-row insert would fail. They are
     logged in `r2-excluded-fks.log`.
   - **Checks after the load:** table count against the dump; host exclusion; count parity against the live source
     (`parity-compare.py`); and the R2 check (`parity-definitions.py`: 0 public→auth.users FKs, all logged).
     `acl_api_entries` (anon, authenticated, service_role, PUBLIC) is the grant check. `acl_entries` is informational,
     because owner entries differ under `--no-owner`.

Exit codes for `schema-restore.sh`:
- 0: accepted.
- 1: refused, nothing written.
- 2: failed after writes began, or refused before the load (absent-role filter); `public` is untouched.
- 3: loaded, but a count or parity check failed.

## Proof on real PostgreSQL 17.12 with pgvector (stand-in source, not live acceptance)
The stand-in source was built by replaying all 1125 migration files of vitana-platform and vitana-v1 on a Supabase
stub. It has 535 tables, 314 FKs (104 into auth.users), 946 policies, 590 functions and 11 vector columns.
- **Dump:** 2,942,224 bytes, 1252 GRANT/REVOKE statements.
- **Restore:** rc=0.
  - 104 R2 FKs were excluded. The filter excluded 2 permissive policies and 9 grants, all for absent roles.
  - Count parity reported "unexplained mismatches: none". `acl_api_entries` was 854 on both sides.
  - 0 production references remained after the restore.
- **Object parity (A07):** PASS. Every difference is allowlisted from the logs: the R2 FKs, the outbox objects, the
  two replaced pg_net functions, auth triggers, owner entries and the absent-role exclusions.
- **Functional checks:**
  - A member-row insert without an auth row succeeds.
  - RLS keeps two users apart (`feedback_tickets`: other=0, self=1).
  - Vector columns are 11/11 and vector indexes 4/4.
  - The stub has 35 columns and 0 rows. `public` holds 0 rows.
- **Fail-closed:** a RESTRICTIVE policy for an absent role gives rc=2, and `public` keeps 0 relations.

# VTID-05803 staging schema restore (single implementation)

The native PostgreSQL 17 dump of the source `public` schema is authoritative. It carries tables, all foreign keys (VALID),
indexes, functions, triggers, views, RLS policies and privileges. No data is copied. The earlier delta scripts (schema
sync, FK recreate, grants, RLS parity, vector preload/postload, auth bridge, outbox) were removed from this package so that
only one migration path exists.

## Run order (`run-staging.sh`, bash)
1. Commit and checksums verified (`SHA256SUMS`).
2. `dump-schema.sh`: `pg_dump --schema-only --no-owner --schema=public --no-publications --no-subscriptions
   --no-security-labels --lock-wait-timeout=30s` from `SOURCE_URI`, which must use the session pooler on 5432. The
   script refuses data sections (TABLE DATA, SEQUENCE SET, COPY, setval), a missing dump-complete trailer, a pg_dump
   major version other than 17, and replication or foreign-server objects. It rewrites `CREATE SCHEMA public;` to
   `IF NOT EXISTS` (counted), then writes `sql/base-schema-public.sql` and its SHA256SUMS line. It is skipped if the
   dump is already present.
3. `schema-restore.sh`. Read-only gates run first: inputs, the exact staging writer `vitana`, dump integrity, no
   production reference in the dump, PG 17 writer, and `public` empty. Then it creates the extensions in schema
   `extensions`, applies the auth stub `aurora-auth-compat-stub.sql` (empty `auth.users`), and applies
   `auth-helpers-production-definitions.sql` if `AUTH_HELPERS=approved` (the roles and `auth.uid/jwt/role/email`). It
   checks the preconditions, then loads the dump in one transaction, compares counts with the dump, and runs the
   post-checks: host exclusion, count parity (`parity-compare.py` against `source-baseline-2026-11-17.txt`) and FK
   definition parity (`parity-definitions.py` against `source-auth-fk-inventory.tsv`, 136 public→auth.users).

Exit codes for `schema-restore.sh`:
- 0: accepted.
- 1: refused, nothing written.
- 2: failed after writes began; the transaction rolled back.
- 3: loaded, but a count or parity check failed.

## Foreign keys referencing auth.users (live inventory, 2026-11-17)
146 in total. 136 public → auth.users come from the dump and need the stub. 10 auth → auth.users are Supabase Auth's
own tables and are not restored.

## Local proof (PostgreSQL 17.5, PGlite; not live acceptance)
A real `pg_dump 17` (wasm build) of a Supabase-shaped fixture was run through `dump-schema.sh` and then
`schema-restore.sh`:
- **Dump checks:** the clean dump passed. Dumps with data, a truncated dump and port 6543 were refused.
- **Restore:** 3 of 3 tables were restored. Grants were kept (REVOKE EXECUTE FROM PUBLIC was preserved), as were RLS
  and the policy. No FK was NOT VALID, there were 0 rows, and the `extensions.uuid_generate_v4()` default resolved.
- **Second run:** refused, because `public` was no longer empty.

# VTID-05803 schema-restore package (schema only)

Source inventory: `source-auth-fk-inventory.tsv`, read-only `pg_constraint` query against the production Supabase
project (inmkhvwdcuyhnxkgfvsb), 2026-11-17. Schema only: no rows and no production data are copied.

## Foreign keys referencing auth.users (live, 2026-11-17)
- Total: 146
- public -> auth.users (applicable, all recreated): 136
- auth -> auth.users (10): these belong to Supabase Auth tables, which are not restored to Aurora. They are listed in the
  inventory and are NOT created here. Aurora gets only the empty `auth.users` stub, so these constraints have no target
  schema to live in.

## Reconciling the counts
- 146: total foreign keys referencing auth.users (136 + 10).
- 136: public -> auth.users. This is the applicable scope and the parity probe's expected value.
- 127: the count in the recreate script's 2026-10-09 header. It predates the current catalog. The live catalog now has 136,
  so the difference is drift since then (inference from the timestamps, not a proven cause).

## Run order (schema-restore.sh)
1. aurora-auth-compat-stub.sql: creates schema auth and an empty auth.users (id uuid primary key). No rows.
2. aurora-cutover-recreate-foreign-keys.sql (public -> public, unchanged)
3. aurora-cutover-recreate-auth-foreign-keys.sql: 136 public -> auth.users constraints, from the inventory's definitions.

## Local reproduction (PostgreSQL 16)
- Created the auth stub and the 125 referencing public tables (136 columns, from the inventory's source columns and types).
- Applied aurora-cutover-recreate-auth-foreign-keys.sql: 136 constraints created, 0 missing, 0 extra.
- Attribute parity against the live inventory: definition (pg_get_constraintdef), table, confupdtype, confdeltype,
  confmatchtype, convalidated, condeferrable and condeferred. 136 checked, 0 real mismatches.

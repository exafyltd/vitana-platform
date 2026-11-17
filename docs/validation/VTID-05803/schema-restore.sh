#!/usr/bin/env bash
# VTID-05803 — schema-only restore into Aurora STAGING (no member data).
# Composes the existing repo SQL in its documented order. Runs only in a VPC executor that has PGHOST/PGUSER/PGPASSWORD
# for the staging writer. Refuses any non-staging target. Stops at the first error (ON_ERROR_STOP=1).
set -euo pipefail
REPO="${REPO:-/work/vitana-platform}"
S="$REPO/scripts/aws"
: "${PGHOST:?PGHOST required}" "${PGUSER:?PGUSER required}" "${PGPASSWORD:?PGPASSWORD required}"
export PGDATABASE="${PGDATABASE:-vitana}" PGSSLMODE=require

# Gate 1 — target guard: staging writer only.
case "$PGHOST" in
  vitana-aurora-staging-writer.*|vitana-aurora-staging.cluster-*) ;;
  *) echo "REFUSED: target $PGHOST is not the staging writer"; exit 1 ;;
esac
case "$PGHOST" in *prod*|*rehearsal*|*awsdr*|*postgres-staging*) echo "REFUSED: non-staging name"; exit 1 ;; esac
echo "gate 1 ok: target $PGHOST"

# Gate 2 — the database must be empty of public relations before a schema-only restore.
N=$(psql -X -At -c "select count(*) from information_schema.tables where table_schema='public'")
[ "$N" = "0" ] || { echo "REFUSED: public schema already has $N tables; not overwriting"; exit 1; }
echo "gate 2 ok: public tables = 0"

psql_f() { echo "== $1"; psql -X -v ON_ERROR_STOP=1 -q -f "$S/$1" >/dev/null; echo "   ok $1"; }

# Ordered restore (documented in the repo scripts):
psql_f aurora-cutover-auth-bridge.sql            # auth schema bridge (idempotent)
psql_f aurora-cutover-schema-sync.sql            # tables, columns, sequences (part 1)
psql_f aurora-cutover-vector-preload.sql         # pgvector columns pre-load (before FKs)
psql_f aurora-cutover-recreate-foreign-keys.sql  # constraints
psql_f aurora-cutover-restore-grants.sql         # grants
psql_f aurora-restore-rls-parity.sql             # RLS policies
psql_f aurora-cutover-outbox.sql                 # outbox replacement
psql_f aurora-cutover-schema-sync-views.sql      # views, LAST
# NOT run here: aurora-cutover-vector-postload.sql — it converts vector columns AFTER a data load (data-dependent).

# Gate 3 — verification: counts only, no data.
psql -X -At -c "select 'tables='||count(*) from information_schema.tables where table_schema='public'"
psql -X -At -c "select 'functions='||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'"
psql -X -At -c "select 'indexes='||count(*) from pg_indexes where schemaname='public'"
psql -X -At -c "select 'fk_constraints='||count(*) from pg_constraint where contype='f' and connamespace='public'::regnamespace"
psql -X -At -c "select 'rls_policies='||count(*) from pg_policies where schemaname='public'"
psql -X -At -c "select 'rls_enabled_tables='||count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity"
psql -X -At -c "select 'table_rows_total='||coalesce(sum(n_live_tup),0) from pg_stat_user_tables where schemaname='public'"
echo "schema-only restore finished"

#!/usr/bin/env bash
# restore-sparring-schema.sh — database-owner-run, ONE time, on Aurora STAGING only (VTID-05803 cluster).
# Creates only what plan sparring needs (schema, no data, no production read):
#   0  roles anon/authenticated/service_role + auth helper functions   (PR #5104, 00-supabase-roles-and-auth.sql)
#   1  supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql
#   2  supabase/migrations/20260628120000_fix_allocate_global_vtid_seq_drift.sql
#   3  supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql
#   4  supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql
#   5  supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql
#   6  restore-sparring-grants.sql (revokes, authenticator membership, staging sequence range)
# Every file is pinned by sha256; the run is one transaction (all or nothing).
#
# Where: a VPC-attached AWS CloudShell environment (vpc-05958f035e596fe64, subnet-0ff45a2051c5e5482,
#        security group sg-0a8531c0ec2130457) or any shell that reaches the private writer endpoint.
# Credential: the RDS-managed master secret of the cluster, read at run time with the caller's own identity,
#        kept only in this process (PGPASSWORD), never printed, never copied to another secret.
#
# Usage: restore-sparring-schema.sh --repo <vitana-platform checkout at origin/main> [--apply]
#        default is a dry run: guards, checksums, connection and the empty-schema check only.
set -euo pipefail
ACCOUNT=472838866351; REGION=eu-central-1
CLUSTER=vitana-aurora-staging
WRITER=vitana-aurora-staging-writer.cfk228aiedf3.eu-central-1.rds.amazonaws.com
DB=vitana
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO=""; APPLY=0
while [ $# -gt 0 ]; do case "$1" in --repo) REPO="$2"; shift;; --apply) APPLY=1;; *) echo "unknown $1" >&2; exit 2;; esac; shift; done
[ -n "$REPO" ] || { echo "--repo required" >&2; exit 2; }
die() { echo "REFUSED: $*" >&2; exit 1; }

[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || die "wrong AWS account"
case "$WRITER" in *prod*|*rehearsal*|*awsdr*|*postgres-staging*) die "host guard";; vitana-aurora-staging-writer.*) ;; *) die "host guard";; esac

ROLES_SQL="$HERE/00-supabase-roles-and-auth.sql"
[ -f "$ROLES_SQL" ] || git -C "$REPO" show 'origin/ccr-8c2acb5d-9s7oxm:docs/validation/VTID-05803/migration/00-supabase-roles-and-auth.sql' > "$ROLES_SQL"
M="$REPO/supabase/migrations"
FILES=(
  "$ROLES_SQL|d600eefcc0cc8abad64b87627a3bccd96d294c01269dd3337420758ef2f7c3b5"
  "$M/20251217000000_vtid_ledger_and_allocator.sql|9afe19d8a6fab3385adcb89ddfdce59c052c5c264b8f4447e2ddd2991316598d"
  "$M/20260628120000_fix_allocate_global_vtid_seq_drift.sql|e137895841d951c4054159bd6d723c219494e10376035e44472f95f5e3a824fe"
  "$M/20261004110000_vtid_04868_plan_sparring_gate.sql|80bc587894c2efdfea3fbc44a9c7488afa46dbbea8e96e9ef952516ed48c26ff"
  "$M/20261004120000_vtid_04868_plan_sparring_hardening.sql|2eaec16934081fdf754eb831d95fdb806bd9c067cc03282077a005ba91cb3796"
  "$M/20261015180000_vtid_05214_plan_sparring_policy_approval.sql|a58bd37974235c7a3117c7f8bad7efbefdcfb0110c11e3b7d9863300805122f5"
  "$HERE/restore-sparring-grants.sql|@"
)
for e in "${FILES[@]}"; do
  f="${e%%|*}"; want="${e##*|}"
  [ -f "$f" ] || die "missing $f"
  [ "$want" = "@" ] && { echo "ok   $(basename "$f") (this plan's file)"; continue; }
  [ "$(sha256sum "$f" | cut -c1-64)" = "$want" ] || die "checksum mismatch: $f"
  echo "ok   $(basename "$f") sha256 ${want:0:16}…"
done

SECRET_ARN=$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER" --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
case "$SECRET_ARN" in arn:aws:secretsmanager:*:secret:rds!cluster-*) ;; *) die "no RDS-managed master secret on $CLUSTER";; esac
CRED=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)
export PGUSER=$(jq -r .username <<<"$CRED") PGPASSWORD=$(jq -r .password <<<"$CRED"); unset CRED
export PGHOST=$WRITER PGDATABASE=$DB PGPORT=5432 PGSSLMODE=require

[ "$(psql -XAtc 'select current_database()')" = "$DB" ] || die "not connected to $DB"
N=$(psql -XAtc "select count(*) from pg_tables where schemaname='public'")
echo "connected to $DB on $WRITER as the master user; public tables: $N"
[ "$N" = 0 ] || die "public schema is not empty ($N tables): this restore only runs on the empty staging database"
[ $APPLY = 1 ] || { echo "dry run OK — re-run with --apply"; exit 0; }

ARGS=(-X -v ON_ERROR_STOP=1 --single-transaction)
for e in "${FILES[@]}"; do ARGS+=(-f "${e%%|*}"); done
psql "${ARGS[@]}"
unset PGPASSWORD

echo "restored. Post-checks (read-only):"
PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text | jq -r .password) \
psql -XAt <<'SQL'
select 'tables', string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public';
select 'functions', count(*) from pg_proc where pronamespace='public'::regnamespace
  and proname in ('allocate_global_vtid','plan_sparring_append_round','plan_sparring_check','_plan_sparring_gate_eval','plan_sparring_trigger_status');
select 'trigger_on_vtid_ledger', count(*) from pg_trigger where tgname='trg_plan_sparring_check' and not tgisinternal;
select 'plan_sparring_config_mode', mode from public.plan_sparring_config;
select 'system_controls_table_present', to_regclass('public.system_controls') is not null;
select 'authenticator_member_of', string_agg(r.rolname, ',') from pg_auth_members m join pg_roles r on r.oid=m.roleid
  join pg_roles u on u.oid=m.member where u.rolname='authenticator';
select 'vtid_ledger_rows', count(*) from public.vtid_ledger;
SQL

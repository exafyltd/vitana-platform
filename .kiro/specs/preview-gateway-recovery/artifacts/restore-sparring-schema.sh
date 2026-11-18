#!/usr/bin/env bash
# restore-sparring-schema.sh — database-owner-run, ONE time, on Aurora STAGING only (cluster vitana-aurora-staging,
# database vitana). Applies restore-sparring.manifest: the request roles + the five ledger/sparring migrations +
# the grants file. Schema only: no data is copied and nothing is read from production.
#
#   (default)   dry run: identity, host guard, checksums, connection, precheck-sparring.sql (read-only). Writes nothing.
#   --apply     precheck, then every manifest file in order (ON_ERROR_STOP). Records which roles it created in
#               ./restore-sparring-state.json. Not one transaction: three migrations carry their own BEGIN/COMMIT;
#               on any failure run --rollback (rehearsal section C).
#   --rollback  rollback-sparring-schema.sql: drops everything the restore created, and only the roles it created.
#
# Where: a VPC-attached AWS CloudShell environment (vpc-05958f035e596fe64, subnet-0ff45a2051c5e5482,
#        security group sg-0a8531c0ec2130457), with psql 17 and jq.
# Credential: the RDS-managed master secret of the cluster, read at run time with the caller's own identity,
#        held only in this process (PGPASSWORD), never printed, never copied into another secret.
#
# Usage: restore-sparring-schema.sh --repo <vitana-platform checkout> [--apply | --rollback]
set -euo pipefail
ACCOUNT=472838866351; REGION=eu-central-1
CLUSTER=vitana-aurora-staging
WRITER=vitana-aurora-staging-writer.cfk228aiedf3.eu-central-1.rds.amazonaws.com
DB=vitana
STATE=./restore-sparring-state.json
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO=""; MODE=dry
while [ $# -gt 0 ]; do case "$1" in --repo) REPO="$2"; shift;; --apply) MODE=apply;; --rollback) MODE=rollback;; *) echo "unknown $1" >&2; exit 2;; esac; shift; done
[ -n "$REPO" ] || { echo "--repo required" >&2; exit 2; }
die() { echo "REFUSED: $*" >&2; exit 1; }

[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || die "wrong AWS account"
case "$WRITER" in *prod*|*rehearsal*|*awsdr*|*postgres-staging*) die "host guard";; vitana-aurora-staging-writer.*) ;; *) die "host guard";; esac
[ "$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER" --query 'DBClusters[0].TagList[?Key==`Environment`].Value | [0]' --output text)" = staging ] \
  || die "cluster $CLUSTER is not tagged Environment=staging"

FILES=()
while read -r sum path; do
  case "$sum" in ''|\#*) continue;; esac
  f="$REPO/$path"; [ -f "$f" ] || die "missing $path"
  [ "$(sha256sum "$f" | cut -c1-64)" = "$sum" ] || die "checksum mismatch: $path"
  echo "ok   $sum  $path"; FILES+=("$f")
done < "$HERE/restore-sparring.manifest"
[ ${#FILES[@]} = 7 ] || die "expected 7 manifest files, got ${#FILES[@]}"

SECRET_ARN=$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER" --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
case "$SECRET_ARN" in arn:aws:secretsmanager:*:secret:rds!cluster-*) ;; *) die "no RDS-managed master secret on $CLUSTER";; esac
CRED=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)
export PGUSER=$(jq -r .username <<<"$CRED") PGPASSWORD=$(jq -r .password <<<"$CRED"); unset CRED
export PGHOST=$WRITER PGDATABASE=$DB PGPORT=5432 PGSSLMODE=require
P=(psql -X -v ON_ERROR_STOP=1)

case "$MODE" in
  dry)
    # Sanitized by construction: hostnames, role names, attributes and counts only; no credential is printed.
    { echo "dry run $(date -u +%FT%TZ) by $(aws sts get-caller-identity --query Arn --output text)"
      echo "target $PGHOST / $PGDATABASE (cluster $CLUSTER, tag Environment=staging)"
      "${P[@]}" -At -F ' = ' -f "$HERE/precheck-sparring.sql"; } 2>&1 | tee restore-sparring-dryrun.txt
    [ "${PIPESTATUS[0]}" = 0 ] || die "precheck refused (see restore-sparring-dryrun.txt)"
    echo "dry run OK — nothing written. Send restore-sparring-dryrun.txt; do not run --apply yet.";;
  apply)
    [ ! -e "$STATE" ] || die "$STATE exists (an apply was already recorded)"
    CREATED=$("${P[@]}" -At -c "select string_agg(n, ',') from unnest(array['anon','authenticated','service_role','vitana_governance_owner']) n where not exists (select 1 from pg_roles where rolname=n)")
    jq -n --arg roles "$CREATED" --arg at "$(date -u +%FT%TZ)" --arg who "$(aws sts get-caller-identity --query Arn --output text)" \
      '{created_roles:$roles, applied_at:$at, applied_by:$who}' > "$STATE"
    ARGS=(-q -f "$HERE/precheck-sparring.sql"); for f in "${FILES[@]}"; do ARGS+=(-f "$f"); done
    if ! "${P[@]}" "${ARGS[@]}"; then echo "FAILED — undo with: $0 --repo $REPO --rollback" >&2; exit 1; fi
    echo "applied. Post-checks (read-only):"
    "${P[@]}" -At <<'SQL'
select 'tables', string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public';
select 'gate_trigger', count(*) from pg_trigger where tgname='trg_plan_sparring_check' and not tgisinternal;
select 'plan_sparring_config_mode', mode from public.plan_sparring_config;
select 'system_controls_absent', to_regclass('public.system_controls') is null;
select 'authenticator_member_of', string_agg(r.rolname, ',' order by r.rolname) from pg_auth_members m join pg_roles r on r.oid=m.roleid
  join pg_roles u on u.oid=m.member where u.rolname='authenticator';
select 'vtid_ledger_rows', count(*) from public.vtid_ledger;
SQL
    ;;
  rollback)
    [ -f "$STATE" ] || die "no $STATE: rollback drops only roles this restore created, and needs that record"
    "${P[@]}" -At -v drop_roles="$(jq -r .created_roles "$STATE")" -v drop_schemas= -f "$HERE/rollback-sparring-schema.sql"
    mv "$STATE" "$STATE.rolled-back.$(date -u +%Y%m%dT%H%M%SZ)";;
esac
unset PGPASSWORD

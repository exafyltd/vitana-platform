#!/usr/bin/env bash
# VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover; design.md §4, §6): fill the two placeholder secrets of
# the staging database stack once the cluster is loaded:
#   vitana/aurora/staging-db/database-url               -> login role vitana_staging_app (gateway AURORA_DATABASE_URL)
#   vitana/aurora/staging-db/postgrest-authenticator-uri -> login role authenticator (PostgREST PGRST_DB_URI, gateway RLS URL)
# Both roles get their own random password (the RDS-managed master password rotates, so it is never put in a URL).
# Runs with the staging database role (vars.AWS_STAGING_DB_ROLE_ARN), which can only reach vitana-aurora-staging and its
# own secrets. Secret values are written from a 0600 file and never printed.
#
#   bash scripts/aws/staging-cutover-secrets.sh --cluster vitana-aurora-staging [--rotate] [--plan]
#
# Default: idempotent; a secret that is no longer the placeholder 'unset' is left alone (a running isolated task keeps
# working). --rotate sets new passwords even when set: only while staging runs on the shared plane (the workflow refuses
# it when STAGING_DATA_PLANE=isolated). --plan prints the steps, no AWS call. Needs STAGING_DB_COST_APPROVED=yes.
# Exit: 0 ok, 1 AWS failure / refused, 2 usage.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=staging-db-common.sh
. "$here/staging-db-common.sh"

cluster=""; rotate=0; plan=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) cluster="${2:-}"; shift 2 ;;
    --rotate) rotate=1; shift ;;
    --plan) plan=1; shift ;;
    *) sdb_usage "unknown argument: $1" ;;
  esac
done
sdb_check_cluster "$cluster"
SECRET_DB="vitana/aurora/staging-db/database-url"
SECRET_AUTH="vitana/aurora/staging-db/postgrest-authenticator-uri"
APP_ROLE="vitana_staging_app"
AUTH_ROLE="authenticator"

if [ "$plan" = 1 ]; then
  cat <<EOF
[plan] aws sts get-caller-identity (account $SDB_ACCOUNT)
[plan] aws rds describe-db-clusters --db-cluster-identifier $cluster   (endpoint, master secret, tag vitana-env=staging)
[plan] aws secretsmanager get-secret-value --secret-id $SECRET_DB / $SECRET_AUTH   (placeholder check only)
[plan] aws rds-data execute-statement --resource-arn $(sdb_cluster_arn "$cluster") --database vitana   (create/alter roles $APP_ROLE, $AUTH_ROLE)
[plan] aws secretsmanager put-secret-value --secret-id $SECRET_DB / $SECRET_AUTH   (from a 0600 file, never printed)
EOF
  exit 0
fi
[ "${STAGING_DB_COST_APPROVED:-}" = yes ] || sdb_die "refused: STAGING_DB_COST_APPROVED is not 'yes' (owner cost approval, design.md §6.1)"
sdb_check_account
aws() { command aws --region "$SDB_REGION" "$@"; }

cj=$(aws rds describe-db-clusters --db-cluster-identifier "$cluster" --output json) || sdb_die "cluster $cluster not found"
[ "$(jq -r '.DBClusters[0].TagList[]? | select(.Key == "vitana-env") | .Value' <<<"$cj")" = staging ] || sdb_die "refused: $cluster is not tagged vitana-env=staging"
endpoint=$(jq -r '.DBClusters[0].Endpoint // empty' <<<"$cj")
master=$(jq -r '.DBClusters[0].MasterUserSecret.SecretArn // empty' <<<"$cj")
[ -n "$endpoint" ] && [ -n "$master" ] || sdb_die "cluster $cluster has no endpoint or managed master secret"
case "$endpoint" in "$cluster".cluster-*.${SDB_REGION}.rds.amazonaws.com) ;; *) sdb_die "refused: endpoint '$endpoint' is not the writer endpoint of $cluster" ;; esac

is_placeholder() { [ "$(aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text)" = unset ]; }
if [ "$rotate" = 0 ] && ! is_placeholder "$SECRET_DB" && ! is_placeholder "$SECRET_AUTH"; then
  echo "staging-cutover-secrets: both secrets are already set; nothing changed (use --rotate only while staging is on the shared plane)"
  exit 0
fi

dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cutover-secrets.XXXXXX"); chmod 700 "$dir"
trap 'rm -rf "$dir"' EXIT
rand_hex() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; } # 48 hex characters
pw_app=$(rand_hex); pw_auth=$(rand_hex)
printf '%s%s' "$pw_app" "$pw_auth" | grep -Eq '^[0-9a-f]{96}$' || sdb_die "password generation failed"
sql() { aws rds-data execute-statement --resource-arn "$(sdb_cluster_arn "$cluster")" --secret-arn "$master" --database vitana --sql "$1" >/dev/null; }
# Hex passwords only (no quote can appear). The statements are not echoed.
sql "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN CREATE ROLE $APP_ROLE LOGIN; END IF; END \$\$"
sql "ALTER ROLE $APP_ROLE LOGIN PASSWORD '$pw_app'"
sql "GRANT rds_superuser TO $APP_ROLE"
sql "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$AUTH_ROLE') THEN CREATE ROLE $AUTH_ROLE LOGIN NOINHERIT; END IF; END \$\$"
sql "ALTER ROLE $AUTH_ROLE LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '$pw_auth'"
sql "GRANT anon, authenticated, service_role TO $AUTH_ROLE"
umask 077
printf 'postgresql://%s:%s@%s:5432/vitana?sslmode=require' "$APP_ROLE" "$pw_app" "$endpoint" > "$dir/db"
printf 'postgres://%s:%s@%s:5432/vitana?sslmode=require' "$AUTH_ROLE" "$pw_auth" "$endpoint" > "$dir/auth"
aws secretsmanager put-secret-value --secret-id "$SECRET_DB" --secret-string "file://$dir/db" >/dev/null
aws secretsmanager put-secret-value --secret-id "$SECRET_AUTH" --secret-string "file://$dir/auth" >/dev/null
echo "staging-cutover-secrets: $SECRET_DB and $SECRET_AUTH set for $cluster ($APP_ROLE, $AUTH_ROLE); values not printed"

#!/usr/bin/env bash
# VTID-05782 (plan autonomous-to-staging-r2, lane staging-db-provision): shared guards of the staging database scripts
# (staging-db-provision.sh, staging-db-load.sh). Sourced, never run. No AWS call happens here except in
# sdb_check_account, which the callers run only in their apply/load modes.
#
# The only cluster these scripts accept is a staging cluster: `vitana-aurora-staging` or `vitana-aurora-staging-<suffix>`
# (lowercase letters, digits, dashes), and never a name that contains "prod". Any other name — the production cluster
# included — is refused before any AWS call. The IAM role of the stack (infra/staging-db/stack.yaml) is narrower still:
# it can create and load exactly `vitana-aurora-staging`.

SDB_REGION="eu-central-1"
SDB_ACCOUNT="472838866351"
SDB_STACK_DEFAULT="vitana-staging-db"

sdb_die() { echo "::error::$*" >&2; exit 1; }
sdb_usage() { echo "::error::$*" >&2; exit 2; }

# sdb_check_cluster <name>: exit 1 unless <name> is a staging cluster name.
sdb_check_cluster() {
  local c="${1:-}"
  [ -n "$c" ] || sdb_usage "--cluster is required (vitana-aurora-staging)"
  case "$c" in
    *prod*|*PROD*|*Prod*) sdb_die "refused: cluster '$c' names production; these scripts only touch vitana-aurora-staging" ;;
  esac
  if ! printf '%s' "$c" | grep -Eq '^vitana-aurora-staging(-[a-z0-9]+)*$'; then
    sdb_die "refused: cluster '$c' is not a staging cluster (expected vitana-aurora-staging or vitana-aurora-staging-<suffix>)"
  fi
}

# sdb_check_account: the credentials must be for the Vitana account in eu-central-1 (CLAUDE.md ALWAYS 11).
sdb_check_account() {
  if [ -n "${AWS_REGION:-}" ] && [ "$AWS_REGION" != "$SDB_REGION" ]; then sdb_die "AWS_REGION=$AWS_REGION, expected $SDB_REGION"; fi
  local acct
  acct=$(aws sts get-caller-identity --query Account --output text) || sdb_die "aws sts get-caller-identity failed"
  [ "$acct" = "$SDB_ACCOUNT" ] || sdb_die "credentials are for account $acct, expected $SDB_ACCOUNT"
}

# sdb_cluster_arn <name>
sdb_cluster_arn() { printf 'arn:aws:rds:%s:%s:cluster:%s' "$SDB_REGION" "$SDB_ACCOUNT" "$1"; }

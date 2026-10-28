#!/usr/bin/env bash
# Set the password of Aurora login role `realtime_admin` (VTID-05023, plan part
# 7a) from Secrets Manager, without the plaintext ever reaching SQL, a log or
# the repo: the password is read into this process, turned into a
# SCRAM-SHA-256 verifier locally (what psql's \password sends), and only the
# verifier goes to Aurora through the RDS Data API as the cluster master user.
#
# Order: AWS-PROD-DEPLOY-REALTIME-AURORA.yml phase=secrets (creates the secret
# once) -> aurora-run-sql.sh aurora-realtime-setup.sql (creates the role) ->
# this script -> the workflow's phase=deploy.
#
# Usage: bash scripts/aws/aurora-realtime-set-password.sh
# Re-running is safe (same password, new salt).
set -euo pipefail
R=eu-central-1
ACCOUNT=472838866351
SECRET_ID=vitana/aurora/prod/realtime-admin-password
CLUSTER=vitana-aurora-prod
CLUSTER_ARN="arn:aws:rds:$R:$ACCOUNT:cluster:$CLUSTER"

ACCT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCT" = "$ACCOUNT" ] || { echo "Refusing: caller is in account $ACCT, expected $ACCOUNT" >&2; exit 1; }

MASTER_SECRET=$(aws rds describe-db-clusters --region "$R" --db-cluster-identifier "$CLUSTER" \
  --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)

VERIFIER=$(aws secretsmanager get-secret-value --region "$R" --secret-id "$SECRET_ID" \
  --query SecretString --output text | python3 -I "$(dirname "$0")/scram_verifier.py")
case "$VERIFIER" in SCRAM-SHA-256\$4096:*) ;; *) echo "Could not build the SCRAM verifier" >&2; exit 1 ;; esac

aws rds-data execute-statement --region "$R" --resource-arn "$CLUSTER_ARN" \
  --secret-arn "$MASTER_SECRET" --database vitana \
  --sql "ALTER ROLE realtime_admin WITH LOGIN PASSWORD '$VERIFIER'" >/dev/null
echo "OK: realtime_admin password set from $SECRET_ID (SCRAM verifier only; plaintext never sent)"

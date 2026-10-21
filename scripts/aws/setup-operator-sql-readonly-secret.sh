#!/usr/bin/env bash
#
# VTID-04037 — provision the connection-URL secret the Operator Console's
# read-only SQL tool (dev_run_sql_readonly, VTID-04023) needs.
#
# WHY THIS EXISTS
#
# operator-sql-readonly.ts reads OPERATOR_SQL_READONLY_DATABASE_URL — a full
# Postgres URL for a READ-ONLY login role on the Aurora READER endpoint. The
# only read-only Aurora credential that exists today,
# vitana/aurora/prod/claude-readonly, is an RDS Data API secret
# ({"username","password"} JSON), not a URL, and no Claude Code session can
# read secret VALUES (secretsmanager:GetSecretValue is deliberately withheld,
# see bootstrap-claude-diagnostics-user.sh). So, like setup-fish-audio-
# secret.sh, this is the exact idempotent call an operator runs instead.
#
# WHAT IT DOES
#
#   1. Resolves the Aurora READER endpoint of vitana-aurora-prod (never the
#      writer — a reader endpoint cannot accept a write even if a role could).
#   2. Reads username/password from vitana/aurora/prod/claude-readonly (the
#      claude_readonly login role, rolsuper=false — verified in the Phase-0
#      reconciliation docs) and composes
#        postgresql://<user>:<pass>@<reader-endpoint>:5432/vitana?sslmode=require
#   3. Creates or updates vitana/gateway/staging/operator-sql-readonly-url.
#
# AWS-STAGE-DEPLOY-GATEWAY.yml resolves that secret OPTIONALLY (ERP-bridge
# pattern): once it exists, the next staging deploy wires
# OPERATOR_SQL_READONLY_ENABLED=true + the URL as a task-def secret; while it
# is absent nothing is wired and the tool reports not_configured. The tool
# itself still runs every statement inside BEGIN READ ONLY with
# default_transaction_read_only=on, so the role being read-only is defense in
# depth, not the only guard.
#
# USAGE
#
#   scripts/aws/setup-operator-sql-readonly-secret.sh                 # dry run
#   scripts/aws/setup-operator-sql-readonly-secret.sh --apply         # create/update the secret
#   scripts/aws/setup-operator-sql-readonly-secret.sh status
#
# Needs: rds:DescribeDBClusters, secretsmanager:GetSecretValue on the
# claude-readonly secret, secretsmanager:CreateSecret/PutSecretValue on the
# new one. Never touches the prod gateway task def.

set -euo pipefail

REGION="eu-central-1"
CLUSTER_ID="vitana-aurora-prod"
SOURCE_SECRET="vitana/aurora/prod/claude-readonly"
TARGET_SECRET="vitana/gateway/staging/operator-sql-readonly-url"
DB_NAME="vitana"
ACTION="provision"
APPLY=0

say() { echo "[setup-operator-sql-readonly-secret] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    provision|status) ACTION="$1"; shift ;;
    --apply) APPLY=1; shift ;;
    --db) DB_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$ACTION" == "status" ]]; then
  ARN=$(aws secretsmanager describe-secret --region "$REGION" --secret-id "$TARGET_SECRET" --query ARN --output text 2>/dev/null || true)
  if [[ -z "$ARN" || "$ARN" == "None" ]]; then say "$TARGET_SECRET: absent"; else say "$TARGET_SECRET: $ARN"; fi
  exit 0
fi

READER=$(aws rds describe-db-clusters --region "$REGION" --db-cluster-identifier "$CLUSTER_ID" \
  --query 'DBClusters[0].ReaderEndpoint' --output text)
[[ -n "$READER" && "$READER" != "None" ]] || { echo "no reader endpoint for $CLUSTER_ID" >&2; exit 1; }
say "reader endpoint: $READER"

if [[ "$APPLY" -ne 1 ]]; then
  say "dry run — would compose postgresql://<claude_readonly>:<pass>@$READER:5432/$DB_NAME?sslmode=require"
  say "and create/update $TARGET_SECRET. Re-run with --apply."
  exit 0
fi

SRC=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SOURCE_SECRET" --query SecretString --output text)
USER_NAME=$(echo "$SRC" | jq -r '.username')
PASS=$(echo "$SRC" | jq -r '.password')
[[ -n "$USER_NAME" && "$USER_NAME" != "null" && -n "$PASS" && "$PASS" != "null" ]] || { echo "$SOURCE_SECRET is not a {username,password} JSON secret" >&2; exit 1; }
ENC_PASS=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PASS")
URL="postgresql://${USER_NAME}:${ENC_PASS}@${READER}:5432/${DB_NAME}?sslmode=require"

if aws secretsmanager describe-secret --region "$REGION" --secret-id "$TARGET_SECRET" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$TARGET_SECRET" --secret-string "$URL" >/dev/null
  say "updated $TARGET_SECRET"
else
  aws secretsmanager create-secret --region "$REGION" --name "$TARGET_SECRET" \
    --description "VTID-04037: read-only Postgres URL (claude_readonly on the Aurora reader) for the Operator Console dev_run_sql_readonly tool" \
    --secret-string "$URL" >/dev/null
  say "created $TARGET_SECRET"
fi
say "next staging gateway deploy wires OPERATOR_SQL_READONLY_ENABLED=true automatically (AWS-STAGE-DEPLOY-GATEWAY.yml)."

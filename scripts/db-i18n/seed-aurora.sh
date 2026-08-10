#!/usr/bin/env bash
# Seed DB-content i18n into AURORA (not Supabase).  VTID-03515 / VTID-03517
#
# WHERE TO RUN THIS
# -----------------
# Aurora prod is in a PRIVATE VPC (10.0.31.82, PubliclyAccessible=false) with
# IAM database auth DISABLED. It is not reachable from a laptop or from a
# generic CI runner. Run this from something inside the VPC:
#
#   * an ECS exec session on a task in the cluster, or
#   * a bastion / EC2 host in the same VPC, or
#   * CloudShell with VPC networking enabled
#
# and from a principal allowed to read Secrets Manager (the Claude agent user
# is explicitly DENIED secretsmanager:GetSecretValue by its permissions
# boundary, which is why this is a script for you rather than something the
# agent ran itself).
#
# WHAT IT DOES
# ------------
#   --check   report per-locale coverage, write nothing            (default)
#   --apply   translate what is stale/missing and UPSERT to Aurora
#   --replay  re-apply the committed artifacts, zero LLM spend
#   --verify  row-count + source_sha reconciliation, read-only
#
set -euo pipefail

MODE="${1:---check}"
LOCALES="${LOCALES:-es,sr,fr,pt,ru,pl}"
REGION="${AWS_REGION:-eu-central-1}"
SECRET_ID="${AURORA_SECRET_ID:-vitana/aurora/prod/database-url}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# --- 1. RDS CA bundle -------------------------------------------------------
# Without this, TLS verification fails against RDS. aurora-client.ts fails
# CLOSED here on purpose: a specific certificate error tells you to install the
# bundle, whereas a silent downgrade tells you nothing.
CA_PATH="${AURORA_CA_BUNDLE_PATH:-/tmp/rds-global-bundle.pem}"
if [ ! -f "$CA_PATH" ]; then
  echo "==> downloading RDS CA bundle to $CA_PATH"
  curl -fsSL -o "$CA_PATH" \
    "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"
fi
export AURORA_CA_BUNDLE_PATH="$CA_PATH"

# --- 2. credentials ---------------------------------------------------------
echo "==> reading $SECRET_ID from Secrets Manager"
RAW="$(aws secretsmanager get-secret-value \
        --secret-id "$SECRET_ID" --region "$REGION" \
        --query SecretString --output text)"
# The secret may be a bare URL or a JSON blob; accept both, print neither.
if printf '%s' "$RAW" | head -c1 | grep -q '{'; then
  AURORA_DATABASE_URL="$(printf '%s' "$RAW" | python3 -c \
    'import json,sys; d=json.load(sys.stdin); print(d.get("DATABASE_URL") or d.get("url") or next(iter(d.values())))')"
else
  AURORA_DATABASE_URL="$RAW"
fi
export AURORA_DATABASE_URL
unset RAW
# Point at the WRITER endpoint. A reader connection fails on the first upsert,
# ~250 rows in, leaving the surface half-written.
case "$AURORA_DATABASE_URL" in
  *cluster-ro-*) echo "REFUSING: that is the READER endpoint. Use the writer." >&2; exit 2 ;;
esac

# --- 3. the two independent gates ------------------------------------------
# Reaching a database is not permission to write to it: AURORA_DATABASE_URL
# gates connectivity, AURORA_I18N_WRITES gates writing. Both are required, and
# only --apply/--replay set the second one.
export DB_I18N_TARGET=aurora

cd "$REPO_DIR/services/gateway"
[ -d node_modules ] || npm ci --no-audit --no-fund

case "$MODE" in
  --check)
    npm run i18n:db:seed -- --locale="$LOCALES" --check
    ;;
  --verify)
    npm run i18n:db:seed -- --locale="$LOCALES" --verify
    ;;
  --apply)
    export AURORA_I18N_WRITES=enabled
    npm run i18n:db:seed -- --ensure-schema --locale="$LOCALES" --apply
    echo "==> reconciling"
    npm run i18n:db:seed -- --locale="$LOCALES" --verify
    ;;
  --replay)
    export AURORA_I18N_WRITES=enabled
    npm run i18n:db:seed -- --ensure-schema --locale="$LOCALES" --from-artifact --apply
    npm run i18n:db:seed -- --locale="$LOCALES" --verify
    ;;
  *)
    echo "usage: $0 [--check|--apply|--replay|--verify]" >&2; exit 1 ;;
esac

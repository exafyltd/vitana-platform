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

# --- 4. Supabase credentials -----------------------------------------------
# Aurora is DOWNSTREAM of Supabase here, so three of the four modes need to
# read upstream (VTID-03574):
#
#   --sync-locales  copies the locale registry in
#   --verify        reconciles the two sides — that IS its job
#   --apply         does both of the above
#
# Only --check is Aurora-only. Fetching these lazily and failing with a named
# secret beats the previous behaviour, where a successful 20-minute apply
# finished by throwing a config error in the reconciliation step.
require_supabase_env() {
  [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE:-}" ] && return 0
  echo "==> reading Supabase credentials from Secrets Manager"
  SUPABASE_URL="${SUPABASE_URL:-$(aws secretsmanager get-secret-value \
      --secret-id "${SUPABASE_URL_SECRET_ID:-vitana/supabase/prod/url}" \
      --region "$REGION" --query SecretString --output text)}"
  SUPABASE_SERVICE_ROLE="${SUPABASE_SERVICE_ROLE:-$(aws secretsmanager get-secret-value \
      --secret-id "${SUPABASE_ROLE_SECRET_ID:-vitana/supabase/prod/service-role}" \
      --region "$REGION" --query SecretString --output text)}"
  if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE" ]; then
    echo "REFUSING: could not resolve Supabase credentials. Set SUPABASE_URL and" >&2
    echo "SUPABASE_SERVICE_ROLE in the environment, or point SUPABASE_URL_SECRET_ID/" >&2
    echo "SUPABASE_ROLE_SECRET_ID at the right secrets." >&2
    exit 2
  fi
  export SUPABASE_URL SUPABASE_SERVICE_ROLE
}

# --replay replays COMMITTED artifacts. There are currently none tracked under
# data/db-i18n/, so without this the mode runs to completion having upserted
# nothing and reports success — the failure mode this whole pipeline exists to
# avoid, since an empty locale is indistinguishable from an up-to-date one.
require_artifacts() {
  if [ -z "$(find "$REPO_DIR/data/db-i18n" -name '*.json' -type f 2>/dev/null | head -1)" ]; then
    echo "REFUSING: --replay re-applies committed artifacts and there are none under" >&2
    echo "$REPO_DIR/data/db-i18n. Run --apply first (it writes them), then commit them." >&2
    exit 2
  fi
}

cd "$REPO_DIR/services/gateway"
[ -d node_modules ] || npm ci --no-audit --no-fund

case "$MODE" in
  --check)
    npm run i18n:db:seed -- --locale="$LOCALES" --check
    ;;
  --verify)
    require_supabase_env
    npm run i18n:db:seed -- --locale="$LOCALES" --verify
    ;;
  --apply)
    require_supabase_env
    export AURORA_I18N_WRITES=enabled
    # --ensure-schema and --sync-locales now fall THROUGH into the apply
    # (VTID-03572); before that they returned, so this line created a schema
    # and exited, and the reconciliation below then reported every row missing.
    npm run i18n:db:seed -- --ensure-schema --sync-locales --locale="$LOCALES" --apply
    echo "==> reconciling"
    npm run i18n:db:seed -- --locale="$LOCALES" --verify
    ;;
  --replay)
    require_supabase_env
    require_artifacts
    export AURORA_I18N_WRITES=enabled
    npm run i18n:db:seed -- --ensure-schema --sync-locales --locale="$LOCALES" --from-artifact --apply
    npm run i18n:db:seed -- --locale="$LOCALES" --verify
    ;;
  *)
    echo "usage: $0 [--check|--apply|--replay|--verify]" >&2; exit 1 ;;
esac

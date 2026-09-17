#!/usr/bin/env bash
#
# VTID-04000 — provision the Vertex Serbian bridge: a scoped GCP service
# account on a NEW, dedicated GCP project (never the decommissioned
# `lovable-vitana-vers1`), and its key pushed into AWS Secrets Manager as
# `GCP_SERVICE_ACCOUNT_JSON`, matching the exact shape
# `services/gateway/src/lib/gcp-adc-bootstrap.ts` already knows how to
# resolve (raw or base64-encoded JSON; materializes to
# GOOGLE_APPLICATION_CREDENTIALS at boot on AWS ECS, where there is no GCP
# metadata server for ADC to resolve for free).
#
# WHY THIS EXISTS
#
# `VertexLiveClient` + the ADC bootstrap were never deleted after the GCP
# shutdown (CLAUDE.md §1) — they were made structurally unreachable by
# `upstream-provider-selector.ts` (VTID-03723). VTID-04000 reopened ONE
# narrow, explicit path back to Vertex — Serbian only, behind
# `VERTEX_SERBIAN_BRIDGE_ENABLED=true` — for a time-boxed 90-day free-credit
# window on a brand-new GCP project the platform owner created for exactly
# this. This script provisions the credential that path needs; it does not
# touch the decommissioned project in any way.
#
# WHAT IT DOES NOT DO
#
#   - It does NOT wire the secret or the `VERTEX_SERBIAN_BRIDGE_ENABLED`/
#     `GOOGLE_CLOUD_PROJECT`/`VERTEX_AI_LOCATION` env vars into any ECS task
#     definition. Same reasoning as every other secret script in this repo
#     (setup-fish-audio-secret.sh's header): no Claude Code session here has
#     `secretsmanager:CreateSecret`, so this is the exact, idempotent call an
#     operator runs instead. Add the wiring to
#     AWS-STAGE-DEPLOY-GATEWAY.yml's secret-resolution loop and task-def jq
#     block ONLY after running this script with `--apply` and confirming
#     both the GCP service account and the AWS secret exist (`status`).
#   - It never touches production, and never touches the decommissioned GCP
#     project — `--gcp-project` is REQUIRED with no default, precisely so
#     this can never accidentally run against `lovable-vitana-vers1`.
#   - It never writes the service-account key to a persistent file — the key
#     is generated to a temp file, read into memory for the AWS upload, and
#     the temp file is shredded/removed in a trap on every exit path.
#
# USAGE
#
#   scripts/aws/setup-vertex-serbian-bridge.sh status \
#       --gcp-project <new-project-id> --env staging
#
#   scripts/aws/setup-vertex-serbian-bridge.sh provision \
#       --gcp-project <new-project-id> --env staging          # dry run
#
#   scripts/aws/setup-vertex-serbian-bridge.sh provision \
#       --gcp-project <new-project-id> --env staging --apply
#
# Requires: gcloud (authenticated against the NEW project), aws CLI
# (authenticated against 472838866351/eu-central-1).

set -euo pipefail

REGION="eu-central-1"
ENV_NAME="staging"
GCP_PROJECT=""
ACTION=""
APPLY=0
SA_NAME="vitana-orb-vertex-bridge"
KEY_FILE=""

say() { echo "[setup-vertex-serbian-bridge] $*"; }
plan() { echo "  [dry-run] $*"; }

cleanup() {
  if [[ -n "$KEY_FILE" && -f "$KEY_FILE" ]]; then
    rm -f "$KEY_FILE"
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    provision|status) ACTION="$1"; shift ;;
    --gcp-project) GCP_PROJECT="$2"; shift 2 ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ACTION" ]]; then
  echo "Usage: $0 {provision|status} --gcp-project <new-project-id> [--env staging|prod] [--apply]" >&2
  exit 1
fi

if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Refusing unknown --env '$ENV_NAME' — must be 'staging' or 'prod'." >&2
  exit 1
fi

if [[ -z "$GCP_PROJECT" ]]; then
  echo "--gcp-project is required (the NEW project id — never lovable-vitana-vers1)." >&2
  exit 1
fi

if [[ "$GCP_PROJECT" == "lovable-vitana-vers1" ]]; then
  echo "Refusing: lovable-vitana-vers1 is permanently decommissioned (CLAUDE.md §1)." >&2
  echo "This script only provisions credentials for the new, dedicated bridge project." >&2
  exit 1
fi

SA_EMAIL="${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
SECRET_NAME="vitana/gateway/${ENV_NAME}/gcp-service-account-json"

case "$ACTION" in
  status)
    say "GCP service account ($GCP_PROJECT):"
    if gcloud iam service-accounts describe "$SA_EMAIL" --project "$GCP_PROJECT" >/dev/null 2>&1; then
      say "  EXISTS: $SA_EMAIL"
    else
      say "  MISSING: $SA_EMAIL"
    fi
    say "AWS secret ($REGION):"
    if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
      say "  EXISTS: $SECRET_NAME"
    else
      say "  MISSING: $SECRET_NAME"
    fi
    ;;
  provision)
    say "Target GCP project: $GCP_PROJECT"
    say "Target service account: $SA_EMAIL"
    say "Target AWS secret: $SECRET_NAME (region $REGION)"

    if [[ "$APPLY" != "1" ]]; then
      plan "gcloud iam service-accounts create $SA_NAME --project=$GCP_PROJECT --display-name='Vitana ORB Vertex Serbian bridge (VTID-04000, 90-day credit window)'"
      plan "gcloud projects add-iam-policy-binding $GCP_PROJECT --member=serviceAccount:$SA_EMAIL --role=roles/aiplatform.user"
      plan "gcloud iam service-accounts keys create <tempfile> --iam-account=$SA_EMAIL"
      plan "aws secretsmanager create-secret --region $REGION --name $SECRET_NAME --secret-string <base64 key JSON>"
      say "Dry run only. Re-run with --apply to actually create the service account, grant it roles/aiplatform.user, and push its key to Secrets Manager."
      exit 0
    fi

    if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
      say "$SECRET_NAME already exists — this script never overwrites a live key. Use the AWS Console/CLI to rotate it."
      exit 0
    fi

    if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$GCP_PROJECT" >/dev/null 2>&1; then
      say "Creating service account $SA_EMAIL ..."
      gcloud iam service-accounts create "$SA_NAME" \
        --project="$GCP_PROJECT" \
        --display-name="Vitana ORB Vertex Serbian bridge (VTID-04000, 90-day credit window)"
    else
      say "$SA_EMAIL already exists — reusing it (only its key/secret are missing)."
    fi

    say "Granting roles/aiplatform.user (least-privilege — Vertex Live API access only) ..."
    gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="roles/aiplatform.user" \
      --condition=None >/dev/null

    KEY_FILE="$(mktemp)"
    say "Generating a new key for $SA_EMAIL ..."
    gcloud iam service-accounts keys create "$KEY_FILE" --iam-account="$SA_EMAIL"

    say "Pushing key to AWS Secrets Manager as $SECRET_NAME ..."
    aws secretsmanager create-secret \
      --region "$REGION" \
      --name "$SECRET_NAME" \
      --description "VTID-04000 Vertex Serbian bridge GCP service account key ($ENV_NAME) — new project $GCP_PROJECT, 90-day credit window, sr-only" \
      --secret-string "file://${KEY_FILE}" \
      --tags Key=vtid,Value=VTID-04000 >/dev/null
    say "Created $SECRET_NAME. Local key file will be shredded on exit."
    say ""
    say "Next steps:"
    say "  1. Wire GCP_SERVICE_ACCOUNT_JSON:$SECRET_NAME into AWS-STAGE-DEPLOY-GATEWAY.yml's secret-resolution loop and task-def jq block."
    say "  2. Also set (plain env, not secrets): GOOGLE_CLOUD_PROJECT=$GCP_PROJECT, VERTEX_AI_LOCATION=<region>, VERTEX_SERBIAN_BRIDGE_ENABLED=true."
    say "  3. Confirm neither GOOGLE_CLOUD_PROJECT nor GCP_PROJECT_ID is left unset on the task def — orb/live/config.ts's own fallback for an unset value is still the DECOMMISSIONED project id."
    say "  4. Dispatch a staging deploy, then run scripts/tts/... equivalent live-verification for Vertex (see docs/validation/VTID-04000/) before enabling on prod."
    ;;
esac

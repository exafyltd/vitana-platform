#!/usr/bin/env bash
#
# VTID-05159 (Health Hub Phase 1 / A2, plan Change 11) — provision the
# encrypted S3 bucket for the health store's raw ingest batches.
#
# WHAT IT HOLDS
#
#   s3://vitana-health-raw-<env>/u/<user_id>/<source_id>/<yyyy>/<mm>/<dd>/<batch_id>.json.gz
#
# The consented subset of every writeHealthSamples call (GDPR Art. 9 data),
# kept 30 days so a batch can be reprocessed, then expired by lifecycle.
# services/gateway/src/services/health-store/raw-batch-store.ts writes,
# reads and erases it (account erasure, withdrawal) under the ECS task role.
#
# WHAT THIS CREATES (dry run by default; --apply is OWNER-RUN)
#
#   - a dedicated KMS CMK + alias alias/vitana-health-raw-<env>, rotation on;
#   - the bucket in eu-central-1: Block Public Access, default SSE-KMS with
#     that CMK and an S3 bucket key, versioning OFF (a delete is final —
#     erasure depends on it), lifecycle: expire after 30 days, abort
#     incomplete multipart uploads after 1 day;
#   - a bucket policy: TLS only, SSE-KMS only, and Put/Get/Delete/List for the
#     gateway task role, this bucket only;
#   - an identity policy on the task role: the same S3 actions plus
#     kms:GenerateDataKey / kms:Decrypt on this key only.
#
# Nothing here edits a task definition. The gateway reads HEALTH_RAW_BUCKET
# (and HEALTH_STORE_ENABLED) from its task definition; setting them is the
# production go-live step of plan Rollout 6, a separate Gate 2. Staging is
# refused: staging shares the production Supabase project and the store is
# forced off there.
#
# USAGE
#
#   scripts/aws/setup-health-raw-bucket.sh 0t            # dry run, prints the plan, calls nothing
#   scripts/aws/setup-health-raw-bucket.sh prod --apply  # owner only
#
# Env overrides: ECS_TASK_ROLE (default vitana-ecs-task-role).

set -euo pipefail
export AWS_PAGER=""

ACCOUNT_ID="472838866351"
REGION="eu-central-1"
ENV_NAME="${1:-}"
APPLY=0
[ "${2:-}" = "--apply" ] && APPLY=1

case "$ENV_NAME" in
  0t|prod) ;;
  staging)
    echo "ERROR: no health raw bucket for staging — staging shares the production Supabase project and the store is forced off there (VITANA_ENV=staging)." >&2
    exit 1 ;;
  *)
    echo "Usage: $0 <0t|prod> [--apply]" >&2
    exit 1 ;;
esac

BUCKET="vitana-health-raw-${ENV_NAME}"
KEY_ALIAS="alias/vitana-health-raw-${ENV_NAME}"
TASK_ROLE="${ECS_TASK_ROLE:-vitana-ecs-task-role}"
TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE}"
POLICY_NAME="VitanaHealthRawBatches-${ENV_NAME}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

DENIED=()
run() {
  if [ "$APPLY" = "1" ]; then
    echo "+ $*"
    local out
    if out="$("$@" 2>&1)"; then
      if [ -n "$out" ]; then echo "$out"; fi
    else
      echo "$out"
      echo "!! DENIED/FAILED: $*"
      DENIED+=("$* :: $(echo "$out" | tail -n 1)")
    fi
  else
    echo "[dry-run] $*"
  fi
}

echo "=== Health store raw-batch bucket (VTID-05159) ==="
echo "account  : $ACCOUNT_ID"
echo "region   : $REGION"
echo "env      : $ENV_NAME"
echo "bucket   : $BUCKET"
echo "kms alias: $KEY_ALIAS"
echo "task role: $TASK_ROLE"
[ "$APPLY" = "1" ] || echo "MODE     : DRY RUN (pass --apply to execute; owner-run)"
echo

if [ "$APPLY" = "1" ]; then
  CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo unknown)"
  if [ "$CURRENT_ACCOUNT" != "$ACCOUNT_ID" ]; then
    echo "ERROR: caller is account '$CURRENT_ACCOUNT', expected '$ACCOUNT_ID'. Refusing." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------- KMS key
KEY_ARN="<key-arn-of-${KEY_ALIAS}>"
if [ "$APPLY" = "1" ]; then
  EXISTING="$(aws kms describe-key --region "$REGION" --key-id "$KEY_ALIAS" --query KeyMetadata.Arn --output text 2>/dev/null || true)"
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
    KEY_ARN="$EXISTING"
    echo "kms key $KEY_ALIAS already exists — $KEY_ARN"
  else
    KEY_ARN="$(aws kms create-key --region "$REGION" \
      --description "VTID-05159 health store raw batches (${ENV_NAME})" \
      --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
      --tags TagKey=vtid,TagValue=VTID-05159 TagKey=data,TagValue=health-art9 \
      --query KeyMetadata.Arn --output text)"
    run aws kms create-alias --region "$REGION" --alias-name "$KEY_ALIAS" --target-key-id "$KEY_ARN"
  fi
else
  echo "[dry-run] aws kms create-key --region $REGION --description 'VTID-05159 health store raw batches (${ENV_NAME})' (unless $KEY_ALIAS exists)"
  echo "[dry-run] aws kms create-alias --region $REGION --alias-name $KEY_ALIAS --target-key-id <new key>"
fi
run aws kms enable-key-rotation --region "$REGION" --key-id "$KEY_ARN"

# ---------------------------------------------------------------- bucket
if [ "$APPLY" = "1" ] && aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "bucket $BUCKET already exists — re-applying its settings."
else
  run aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION"
fi

run aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

cat > "$WORKDIR/encryption.json" <<JSON
{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"${KEY_ARN}"},"BucketKeyEnabled":true}]}
JSON
run aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration "file://$WORKDIR/encryption.json"

# Versioning stays OFF: an erasure must be final (no noncurrent versions).
if [ "$APPLY" = "1" ]; then
  VERSIONING="$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text 2>/dev/null || echo None)"
  if [ "$VERSIONING" = "Enabled" ] || [ "$VERSIONING" = "Suspended" ]; then
    echo "!! versioning is $VERSIONING on $BUCKET — a versioned bucket keeps deleted health data. Fix by hand before enabling the store." >&2
    DENIED+=("versioning is $VERSIONING on $BUCKET")
  fi
else
  echo "[dry-run] versioning: left OFF (checked with get-bucket-versioning on --apply)"
fi

cat > "$WORKDIR/lifecycle.json" <<'JSON'
{
  "Rules": [
    { "ID": "expire-raw-batches-30d", "Status": "Enabled", "Filter": { "Prefix": "u/" }, "Expiration": { "Days": 30 } },
    { "ID": "abort-incomplete-multipart-1d", "Status": "Enabled", "Filter": { "Prefix": "" }, "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } }
  ]
}
JSON
echo "lifecycle:"; cat "$WORKDIR/lifecycle.json"
run aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration "file://$WORKDIR/lifecycle.json"

cat > "$WORKDIR/bucket-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TlsOnly",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "SseKmsOnly",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::${BUCKET}/*",
      "Condition": { "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" } }
    },
    {
      "Sid": "GatewayTaskRoleObjects",
      "Effect": "Allow",
      "Principal": { "AWS": "${TASK_ROLE_ARN}" },
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "GatewayTaskRoleList",
      "Effect": "Allow",
      "Principal": { "AWS": "${TASK_ROLE_ARN}" },
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    }
  ]
}
JSON
echo "bucket policy:"; cat "$WORKDIR/bucket-policy.json"
run aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$WORKDIR/bucket-policy.json"

# ---------------------------------------------------------------- task role
cat > "$WORKDIR/role-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "HealthRawList", "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::${BUCKET}" },
    { "Sid": "HealthRawObjects", "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::${BUCKET}/*" },
    { "Sid": "HealthRawKey", "Effect": "Allow", "Action": ["kms:GenerateDataKey", "kms:Decrypt"], "Resource": "${KEY_ARN}" }
  ]
}
JSON
echo "task role policy ($POLICY_NAME on $TASK_ROLE):"; cat "$WORKDIR/role-policy.json"
run aws iam put-role-policy --role-name "$TASK_ROLE" --policy-name "$POLICY_NAME" \
  --policy-document "file://$WORKDIR/role-policy.json"

echo
if [ "${#DENIED[@]}" -gt 0 ]; then
  echo "=== INCOMPLETE — ${#DENIED[@]} step(s) failed; run them with an owner/IAM-admin identity ==="
  for d in "${DENIED[@]}"; do echo "  - $d"; done
  exit 2
fi
if [ "$APPLY" = "1" ]; then
  echo "=== Done === Next (go-live Gate 2 only): HEALTH_RAW_BUCKET=$BUCKET on the ${ENV_NAME} gateway task definition."
else
  echo "Dry run only. Re-run with --apply (owner-run)."
fi

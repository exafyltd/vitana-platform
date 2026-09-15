#!/usr/bin/env bash
#
# VTID-03765 — provision the S3 buckets for the B6 Storage migration
# (docs/AURORA-B6-STORAGE-INVENTORY.md), and set their public/private
# access to match what the live Supabase Storage inventory found.
#
# WHY THIS EXISTS
#
# B6's inventory pass found 19 live Supabase Storage buckets (1,099
# objects, ~5GB) behind the gateway's STORAGE_PROVIDER=s3 path
# (services/gateway/src/services/storage/storage-provider.ts) and the 19
# frontend call sites in exafyltd/vitana-v1. This script is the
# reproducible record of the bucket-provisioning half of that migration —
# it was first run live, ad hoc, during VTID-03765; this codifies it so a
# second environment (or a rebuild) gets the identical result instead of
# someone re-deriving the bucket list and ACL split from the inventory doc
# by hand.
#
# WHAT THIS DOES NOT DO
#
# It does not copy any object data — see migrate-storage-to-s3.sh for
# that, a separate step run only after the buckets below exist. It also
# does not touch the gateway's STORAGE_PROVIDER env var — that flip is a
# deliberate, separate operator action taken only once the data copy is
# verified complete (flipping early 404s every existing file, per
# storage-provider.ts's own header comment).
#
# USAGE
#
#   scripts/aws/setup-storage-buckets.sh            # dry run, prints the plan
#   scripts/aws/setup-storage-buckets.sh --apply    # actually create things
#
# Idempotent: an existing bucket is left alone, not recreated.

set -euo pipefail

ACCOUNT_ID="472838866351"
REGION="${AWS_REGION:-eu-central-1}"
BUCKET_PREFIX="vitana-storage-"

# Same public/private split B6's inventory found live on Supabase
# (docs/AURORA-B6-STORAGE-INVENTORY.md's per-bucket table).
PUBLIC_BUCKETS=(avatars covers diary-photos intent-covers media media-uploads stream-recordings event-images media-music media-podcasts media-videos campaign-images community-marketplace-listings default-images media-thumbnails)
PRIVATE_BUCKETS=(feedback-attachments chat-attachments health-reports voucher-pdfs)

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

run() {
  if [ "$APPLY" = "1" ]; then
    echo "+ $*"
    "$@"
  else
    echo "[dry-run] $*"
  fi
}

echo "=== B6 storage bucket provisioning ==="
echo "account : $ACCOUNT_ID"
echo "region  : $REGION"
echo "public  : ${#PUBLIC_BUCKETS[@]} buckets"
echo "private : ${#PRIVATE_BUCKETS[@]} buckets"
[ "$APPLY" = "1" ] || echo "MODE    : DRY RUN (pass --apply to execute)"
echo

# Guard against pointing this at the wrong account — CLAUDE.md IF-THEN 11.
CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo unknown)"
if [ "$CURRENT_ACCOUNT" != "$ACCOUNT_ID" ]; then
  echo "ERROR: caller is account '$CURRENT_ACCOUNT', expected '$ACCOUNT_ID'." >&2
  echo "Refusing to provision into the wrong account." >&2
  exit 1
fi

create_bucket_if_missing() {
  local bucket="$1"
  if aws s3api head-bucket --bucket "$bucket" --region "$REGION" 2>/dev/null; then
    echo "bucket $bucket already exists — leaving it alone."
  else
    echo "bucket $bucket does not exist — creating."
    run aws s3api create-bucket \
      --bucket "$bucket" \
      --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
}

echo "--- public buckets (public-read policy) ---"
for name in "${PUBLIC_BUCKETS[@]}"; do
  bucket="${BUCKET_PREFIX}${name}"
  create_bucket_if_missing "$bucket"
  run aws s3api put-public-access-block --region "$REGION" --bucket "$bucket" \
    --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false
  run aws s3api put-bucket-policy --region "$REGION" --bucket "$bucket" \
    --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PublicReadGetObject\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${bucket}/*\"}]}"
done
echo

echo "--- private buckets (fully blocked public access) ---"
for name in "${PRIVATE_BUCKETS[@]}"; do
  bucket="${BUCKET_PREFIX}${name}"
  create_bucket_if_missing "$bucket"
  run aws s3api put-public-access-block --region "$REGION" --bucket "$bucket" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
done
echo

echo "Done. Next: scripts/aws/migrate-storage-to-s3.sh to copy the actual object data."

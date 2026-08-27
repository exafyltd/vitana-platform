#!/usr/bin/env bash
#
# VTID-03765 — copy Supabase Storage object data into the S3 buckets
# scripts/aws/setup-storage-buckets.sh provisions.
#
# WHY THIS EXISTS
#
# Provisioning the S3 buckets (setup-storage-buckets.sh) gives the target
# an empty shell — the actual objects still only exist on Supabase until
# this runs. This is a one-time backfill; once STORAGE_PROVIDER=s3 is
# flipped on the gateway, new writes land on S3 directly and this script
# is not part of the steady-state path.
#
# HOW IT WORKS
#
# Public buckets need no credentials at all — every object is downloaded
# from Supabase's public object URL
# (https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>)
# and re-uploaded to S3 with its original Content-Type preserved (curl's
# response header, not re-guessed — losing this makes images/audio render
# as a forced download in a browser instead of inline).
#
# Private buckets need SUPABASE_SERVICE_ROLE (the same key
# services/gateway already uses) to read
# .../storage/v1/object/<bucket>/<path> with an Authorization header —
# Supabase's public object path 403s on a private bucket regardless of
# any key, by design.
#
# WHAT THIS DOES NOT DO
#
# It does not delete anything from Supabase — this is additive-only. It
# does not verify byte-for-byte content past size (each upload logs
# source vs. destination size; a mismatch is flagged, not silently
# accepted) — a full checksum pass is a separate, heavier verification
# step for whoever signs off on the cutover, not this backfill.
#
# USAGE
#
#   SUPABASE_URL=https://<ref>.supabase.co \
#   SUPABASE_SERVICE_ROLE=<key> \
#     scripts/aws/migrate-storage-to-s3.sh [--buckets bucket1,bucket2,...]
#
# Without --buckets, migrates every bucket listed in BUCKET_MANIFEST
# below (built from the live storage.objects table per B6's inventory —
# regenerate the manifest yourself if the object set has moved on:
#
#   SELECT bucket_id, name FROM storage.objects ORDER BY bucket_id;
#
# piped into a bucket<TAB>name manifest file, see MANIFEST_FILE).
#
# SUPABASE_SERVICE_ROLE is only required if any bucket being migrated is
# private (see PRIVATE_BUCKETS in setup-storage-buckets.sh) — public
# buckets migrate with zero credentials.

set -uo pipefail

: "${SUPABASE_URL:?Set SUPABASE_URL, e.g. https://inmkhvwdcuyhnxkgfvsb.supabase.co}"
REGION="${AWS_REGION:-eu-central-1}"
MANIFEST_FILE="${MANIFEST_FILE:-/tmp/storage_manifest.tsv}"
LOG="${LOG:-/tmp/migrate_storage_to_s3.log}"
: > "$LOG"

BUCKETS_FILTER=""
if [ "${1:-}" = "--buckets" ]; then
  BUCKETS_FILTER="$2"
fi

if [ ! -f "$MANIFEST_FILE" ]; then
  echo "ERROR: manifest file $MANIFEST_FILE not found." >&2
  echo "Generate it first: SELECT bucket_id, name FROM storage.objects ORDER BY bucket_id;" >&2
  echo "and write bucket<TAB>name rows to $MANIFEST_FILE." >&2
  exit 1
fi

# Private buckets need an Authorization header; public ones must NOT send
# one (a bad/expired key on a public bucket request still works, but
# there is no reason to depend on the key's validity for objects that
# don't need it at all).
is_private_bucket() {
  case "$1" in
    feedback-attachments|chat-attachments|health-reports|voucher-pdfs) return 0 ;;
    *) return 1 ;;
  esac
}

total=0
ok=0
fail=0
skipped_private_no_key=0

while IFS=$'\t' read -r bucket name; do
  [ -n "$BUCKETS_FILTER" ] && [[ ",$BUCKETS_FILTER," != *",$bucket,"* ]] && continue
  total=$((total+1))
  s3bucket="vitana-storage-${bucket}"

  if is_private_bucket "$bucket"; then
    if [ -z "${SUPABASE_SERVICE_ROLE:-}" ]; then
      echo "SKIP_PRIVATE_NO_KEY $bucket/$name" >> "$LOG"
      skipped_private_no_key=$((skipped_private_no_key+1))
      continue
    fi
    src="${SUPABASE_URL}/storage/v1/object/${bucket}/${name}"
    auth_args=(-H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE}" -H "apikey: ${SUPABASE_SERVICE_ROLE}")
  else
    src="${SUPABASE_URL}/storage/v1/object/public/${bucket}/${name}"
    auth_args=()
  fi

  tmpfile=$(mktemp)
  headerfile=$(mktemp)
  http_code=$(curl -sS "${auth_args[@]}" -D "$headerfile" -o "$tmpfile" -w "%{http_code}" "$src")
  if [ "$http_code" != "200" ]; then
    echo "DOWNLOAD_FAIL $bucket/$name http=$http_code" >> "$LOG"
    fail=$((fail+1))
    rm -f "$tmpfile" "$headerfile"
    continue
  fi

  ctype=$(grep -i '^content-type:' "$headerfile" | tail -1 | cut -d: -f2- | tr -d '\r\n' | sed 's/^ *//')
  rm -f "$headerfile"
  [ -z "$ctype" ] && ctype="application/octet-stream"
  src_size=$(wc -c < "$tmpfile")

  if aws s3 cp "$tmpfile" "s3://${s3bucket}/${name}" --region "$REGION" --content-type "$ctype" --only-show-errors 2>>"$LOG"; then
    dst_size=$(aws s3api head-object --region "$REGION" --bucket "$s3bucket" --key "$name" --query ContentLength --output text 2>>"$LOG")
    if [ "$src_size" = "$dst_size" ]; then
      ok=$((ok+1))
    else
      echo "SIZE_MISMATCH $bucket/$name src=$src_size dst=$dst_size" >> "$LOG"
      fail=$((fail+1))
    fi
  else
    echo "UPLOAD_FAIL $bucket/$name" >> "$LOG"
    fail=$((fail+1))
  fi
  rm -f "$tmpfile"

  if [ $((total % 50)) -eq 0 ]; then
    echo "progress: $total processed, $ok ok, $fail failed, $skipped_private_no_key skipped (no key)"
  fi
done < "$MANIFEST_FILE"

echo "DONE: total=$total ok=$ok fail=$fail skipped_private_no_key=$skipped_private_no_key"
[ "$fail" -gt 0 ] && echo "See $LOG for the specific failures."
[ "$skipped_private_no_key" -gt 0 ] && echo "Re-run with SUPABASE_SERVICE_ROLE set to migrate the skipped private-bucket objects."

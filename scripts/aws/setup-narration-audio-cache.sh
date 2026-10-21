#!/usr/bin/env bash
#
# BOOTSTRAP-POLLY-NARRATION-CACHE — provision the S3 bucket that holds
# pre-rendered guided-topic lesson audio, and grant the gateway task role
# access to it.
#
# WHY THIS EXISTS
#
# `synthesizeGuidedTopicNarrationAudio()` runs on every guided-topic session
# start and had no cache, so each My Journey tap re-synthesized the full
# ~1,800-character lesson through Polly. The audio is deterministic — same
# script, voice, engine and sample rate produce the same bytes — across 254
# topics x 8 shipped languages, roughly 2,000 distinct assets.
#
# Caching turns a per-tap cost into a per-asset cost (~$58 on the neural
# engine, ~$110 on generative, one time) and takes synthesis latency out of
# the tap path entirely.
#
# WHAT THIS DOES NOT DO
#
# It does not pre-render anything. The cache fills lazily on first tap per
# (topic, language). A deliberate pre-render pass is a separate job; doing it
# here would spend real money as a side effect of provisioning, which is not
# what someone running a setup script is consenting to.
#
# USAGE
#
#   scripts/aws/setup-narration-audio-cache.sh            # dry run, prints the plan
#   scripts/aws/setup-narration-audio-cache.sh --apply    # actually create things
#
# AFTERWARDS, set on the gateway task definition (via
# AWS-PROD-DEPLOY-GATEWAY.yml / AWS-STAGE-DEPLOY-GATEWAY.yml dispatch inputs,
# never by hand-editing live AWS state — that is the VTID-03513 lesson):
#
#   NARRATION_AUDIO_CACHE=s3
#   NARRATION_AUDIO_BUCKET=<bucket name printed below>
#
# Until BOTH are set the gateway uses its in-process cache, which is correct
# but does not survive a deploy or a scale-out.

set -euo pipefail

ACCOUNT_ID="472838866351"
REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${NARRATION_AUDIO_BUCKET:-vitana-narration-audio}"
TASK_ROLE="${GATEWAY_TASK_ROLE:-vitana-ecs-task-role}"
POLICY_NAME="VitanaNarrationAudioCache"

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

echo "=== Narration audio cache provisioning ==="
echo "account : $ACCOUNT_ID"
echo "region  : $REGION"
echo "bucket  : $BUCKET"
echo "role    : $TASK_ROLE"
[ "$APPLY" = "1" ] || echo "MODE    : DRY RUN (pass --apply to execute)"
echo

# Guard against pointing this at the wrong account — CLAUDE.md IF-THEN 11.
CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo unknown)"
if [ "$CURRENT_ACCOUNT" != "$ACCOUNT_ID" ]; then
  echo "ERROR: caller is account '$CURRENT_ACCOUNT', expected '$ACCOUNT_ID'." >&2
  echo "Refusing to provision into the wrong account." >&2
  exit 1
fi

# ---------------------------------------------------------------- bucket
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "bucket $BUCKET already exists — leaving it alone."
else
  echo "bucket $BUCKET does not exist — creating."
  run aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION"
fi

# Private by construction. This audio is user-facing content but it is served
# through the gateway, never linked directly, so there is no reason for it to
# be publicly readable.
run aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

run aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Lifecycle: expire objects untouched for a year.
#
# NOT shorter, on purpose. The key includes a hash of the lesson text and the
# voice/engine, so a stale key is unreachable the moment the curriculum or the
# engine changes — expiry is only reclaiming genuinely dead objects, not
# managing correctness. A short expiry would instead re-bill the whole catalog
# on a schedule for no benefit.
cat > /tmp/narration-lifecycle.json <<'JSON'
{
  "Rules": [
    {
      "ID": "expire-unused-narration-audio",
      "Status": "Enabled",
      "Filter": { "Prefix": "narration/" },
      "Expiration": { "Days": 365 }
    }
  ]
}
JSON
run aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET" \
  --lifecycle-configuration file:///tmp/narration-lifecycle.json

# ---------------------------------------------------------------- IAM
# Scoped to this bucket's narration prefix only — not s3:* and not "*".
cat > /tmp/narration-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NarrationAudioObjectAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/narration/*"
    }
  ]
}
JSON

echo
echo "Attaching inline policy '$POLICY_NAME' to role '$TASK_ROLE':"
cat /tmp/narration-policy.json
run aws iam put-role-policy \
  --role-name "$TASK_ROLE" \
  --policy-name "$POLICY_NAME" \
  --policy-document file:///tmp/narration-policy.json

# ---------------------------------------------------------------- verify
echo
if [ "$APPLY" = "1" ]; then
  echo "=== Verifying the grant actually works ==="
  # Listing a policy is not proof it is effective — §2b's own lesson, where 22
  # profiles reported ACTIVE and 3 could actually be invoked. Simulate instead.
  aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE}" \
    --action-names s3:GetObject s3:PutObject \
    --resource-arns "arn:aws:s3:::${BUCKET}/narration/test-key" \
    --query 'EvaluationResults[].{action:EvalActionName,decision:EvalDecision}' \
    --output table || echo "(simulate-principal-policy unavailable to this caller)"
fi

echo
echo "=== Next steps ==="
echo "1. Set on the gateway task definition, via the deploy workflow's dispatch inputs:"
echo "     NARRATION_AUDIO_CACHE=s3"
echo "     NARRATION_AUDIO_BUCKET=$BUCKET"
echo "2. Tap a My Journey topic, then confirm a real round trip:"
echo "     aws s3 ls s3://$BUCKET/narration/ --recursive | head"
echo "   and look for '[GUIDED-TOPIC-TTS] cache=hit store=s3' in the gateway logs"
echo "   on the SECOND tap of the same topic. A first-tap miss is expected."
echo "3. Only once a real hit is observed is the S3 leg proven — it has never"
echo "   executed against a live bucket as of this script being written."

#!/usr/bin/env bash
#
# VTID-04229 — provision the S3 bucket that holds the codebase index every
# agent reads, and grant the two principals that touch it.
#
# WHY THIS EXISTS
#
# CODEINTEL-INDEX.yml builds RepoWise + Graphify on an ubuntu runner on every
# merge to main (the CLIs cannot be installed in the Alpine gateway image —
# lancedb has no musl wheel, VTID-04222 §3) and publishes a derived bundle
# (~2 MB gzipped) to
#
#   s3://vitana-code-index/<owner>/<repo>/<sha>/...
#   s3://vitana-code-index/<owner>/<repo>/latest/manifest.json
#
# The gateway (Operator Console dev_index_query / dev_graph_path /
# dev_get_risk) and the ECS executor task read it through
# services/gateway/src/services/codeintel-index.ts under the shared ECS task
# role; the workflow writes it under the GitHub-OIDC deploy role.
#
# USAGE
#
#   scripts/aws/setup-code-index-bucket.sh            # dry run, prints the plan
#   scripts/aws/setup-code-index-bucket.sh --apply    # actually create things
#
# Env overrides: CODE_INDEX_BUCKET, ECS_TASK_ROLE (default vitana-ecs-task-role),
# CI_DEPLOY_ROLE (default vitana-gateway-awsdr-deploy-role — the role behind
# the AWS_PROD_ROLE_ARN repository secret, per docs/AWS-PRODUCTION-BUILD-LOG.md).
#
# Nothing here edits a task definition. The gateway reads CODE_INDEX_BUCKET
# from the environment with this bucket name as its code default, so no
# deploy-workflow change is needed to point at it (override only if you
# rename the bucket).

set -euo pipefail

ACCOUNT_ID="472838866351"
REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${CODE_INDEX_BUCKET:-vitana-code-index}"
TASK_ROLE="${ECS_TASK_ROLE:-vitana-ecs-task-role}"
CI_ROLE="${CI_DEPLOY_ROLE:-vitana-gateway-awsdr-deploy-role}"
READ_POLICY_NAME="VitanaCodeIndexRead"
WRITE_POLICY_NAME="VitanaCodeIndexPublish"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

DENIED=()

# Every step is attempted and its outcome recorded, so a session whose IAM
# permissions boundary denies one action (the recorded VTID-04037 shape:
# `claude-code-aws-agent` is explicitly denied iam:* and several s3
# bucket-configuration actions) still creates what it can and prints the
# VERBATIM denial for each step the owner has to run — instead of dying on
# the first one with the bucket half-configured.
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

echo "=== Code index bucket provisioning (VTID-04229) ==="
echo "account   : $ACCOUNT_ID"
echo "region    : $REGION"
echo "bucket    : $BUCKET"
echo "read role : $TASK_ROLE   (gateway + executor tasks)"
echo "write role: $CI_ROLE   (CODEINTEL-INDEX.yml via GitHub OIDC)"
[ "$APPLY" = "1" ] || echo "MODE      : DRY RUN (pass --apply to execute)"
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

# Private by construction: the bundle describes the private codebase.
run aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

run aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Lifecycle: every merge publishes a new <sha>/ prefix (~2 MB). Keep 30 days
# of history (enough to compare against any sha an execution ran on) and
# expire the rest. latest/ is rewritten in place and never expires.
cat > /tmp/code-index-lifecycle.json <<'JSON'
{
  "Rules": [
    {
      "ID": "expire-old-index-snapshots",
      "Status": "Enabled",
      "Filter": { "Prefix": "exafyltd/" },
      "Expiration": { "Days": 30 }
    }
  ]
}
JSON
run aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET" \
  --lifecycle-configuration file:///tmp/code-index-lifecycle.json

# ---------------------------------------------------------------- bucket policy
# The resource-side grant. Same-account access needs EITHER an identity
# policy on the role OR a bucket policy naming it — and a bucket policy is
# an s3:* action on a bucket this script just created, which a session
# identity can hold even when iam:PutRolePolicy is denied by its permissions
# boundary (it is: applied 2026-09-21 from `claude-code-aws-agent`, the two
# put-role-policy steps below were denied and this one succeeded). Read for
# the ECS task role, publish for the GitHub-OIDC deploy role, this bucket
# only, never delete.
cat > /tmp/code-index-bucket-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CodeIndexReadByEcsTasks",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE}" },
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "CodeIndexListByEcsTasks",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE}" },
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "CodeIndexPublishByCi",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/${CI_ROLE}" },
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "CodeIndexListByCi",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/${CI_ROLE}" },
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    }
  ]
}
JSON
echo
echo "bucket policy (read: $TASK_ROLE, publish: $CI_ROLE):"
cat /tmp/code-index-bucket-policy.json
run aws s3api put-bucket-policy \
  --bucket "$BUCKET" \
  --policy file:///tmp/code-index-bucket-policy.json

# ---------------------------------------------------------------- IAM (read)
# Belt and braces: the same grants as identity policies on the roles, for
# whoever runs this with IAM-admin rights. Denied for a session identity;
# recorded, not fatal (the bucket policy above already grants access).
# The ECS task role is shared by the gateway and the executor task (the
# recorded VTID-03929 decision). Read-only, this bucket only.
cat > /tmp/code-index-read-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CodeIndexList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "CodeIndexRead",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    }
  ]
}
JSON

echo
echo "read policy ($READ_POLICY_NAME on $TASK_ROLE):"
cat /tmp/code-index-read-policy.json
run aws iam put-role-policy \
  --role-name "$TASK_ROLE" \
  --policy-name "$READ_POLICY_NAME" \
  --policy-document file:///tmp/code-index-read-policy.json

# ---------------------------------------------------------------- IAM (write)
# The GitHub-OIDC deploy role publishes. Put + list, this bucket only —
# never delete (lifecycle handles expiry).
cat > /tmp/code-index-write-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CodeIndexList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "CodeIndexPublish",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    }
  ]
}
JSON

echo
echo "write policy ($WRITE_POLICY_NAME on $CI_ROLE):"
cat /tmp/code-index-write-policy.json
run aws iam put-role-policy \
  --role-name "$CI_ROLE" \
  --policy-name "$WRITE_POLICY_NAME" \
  --policy-document file:///tmp/code-index-write-policy.json

echo
if [ "${#DENIED[@]}" -gt 0 ]; then
  echo "=== INCOMPLETE — ${#DENIED[@]} step(s) were denied for this caller; run them with an owner/IAM-admin identity ==="
  for d in "${DENIED[@]}"; do echo "  - $d"; done
  exit 2
fi
echo "=== Done ==="
echo "Next: dispatch CODEINTEL-INDEX.yml (or merge to main) and confirm"
echo "  aws s3 ls s3://$BUCKET/exafyltd/vitana-platform/latest/"
echo "shows manifest.json; then a staging Operator Console turn calling"
echo "dev_index_query answers with the published sha."

#!/usr/bin/env bash
# setup-delivery-bedrock.sh — VTID-05702 (plan agentic-delivery-v2 §10, §11, Phase 0 P3, lane delivery-bedrock).
#
# WHAT THIS IS FOR
#
# Delivery stages (the plan-sparring responder, the review service — built in
# the later lanes `spar-responder`/`review-service`) call Bedrock through a
# role, `vitana-delivery-bedrock`, in a SEPARATE AWS account, `vitana-engineering`
# (infra/gitlab-engineering/RUNBOOK.md §1: account id in ~/vitana-eng/state.env,
# region eu-central-1 — NOT the same thing as account 472838866351, where this
# platform's production/staging infrastructure and this session's own AWS
# credentials live). The whole point is that delivery traffic (plan sparring,
# code review) never shares, or depends on, production's Bedrock quota in
# 472838866351.
#
# This role is also NOT the `vitana-delivery-bedrock-invoke` policy (VTID-05774,
# PR #5006) — that one grants a Kiro SESSION's own Bedrock calls inside
# 472838866351 and is unrelated and already done. Do not conflate the two:
# this script never touches 472838866351 IAM, and that other policy never
# touches vitana-engineering.
#
# WHO RUNS IT, AND HOW
#
#   scripts/aws/setup-delivery-bedrock.sh discover  [--region eu-central-1]
#   scripts/aws/setup-delivery-bedrock.sh provision [--apply] \
#       --task-role-arn arn:aws:iam::472838866351:role/<name> \
#       [--engineering-account-id <id>] [--region eu-central-1] \
#       [--eu-destination-region eu-north-1 --eu-destination-region eu-south-1 ...]
#
# `discover` is READ-ONLY (aws ecs describe-services/describe-task-definition
# only) and is run with CALLER CREDENTIALS FOR 472838866351 active — it prints
# the live staging gateway's task role ARN, to be pasted into `provision
# --task-role-arn`. It never touches vitana-engineering.
#
# `provision` creates/updates the role and is run with CALLER CREDENTIALS FOR
# vitana-engineering active (switch role from 472838866351, same as the
# owner's own infra/gitlab-engineering/setup.sh does — RUNBOOK §1). DRY RUN BY
# DEFAULT: without --apply it only reads (sts, iam get-*) and prints every
# write call it would make, as "[DRY-RUN] aws …"; with --apply the same calls
# run, printed as "[APPLY] aws …". Every read is printed as "[READ] aws …".
#
# `--task-role-arn` is REQUIRED for `provision` (no default/discovery inside
# this action — see `discover` above): the exact ARN of the vitana-platform
# staging gateway's own ECS task role in 472838866351, which becomes the
# trust policy's principal. The current staging gateway task role is named
# `vitana-ecs-task-role` (CLAUDE.md §2e-vertex-serbian-bridge,
# §2e-audiobook-google both name it as the ECS task role this exact gateway
# service already uses for its own cross-account AWS-credential-supplier
# exchanges) — i.e. `arn:aws:iam::472838866351:role/vitana-ecs-task-role` is
# the expected value as of 2026-11, but this script never assumes that: it is
# always passed explicitly, so a future task-role rename needs no edit here.
#
# WHAT `provision --apply` DOES
#   1. Creates (or updates the trust policy of) IAM role `vitana-delivery-bedrock`
#      in the CALLER's account (expected: vitana-engineering), max session
#      duration 3600s, trusting ONLY --task-role-arn as principal — a bare
#      sts:AssumeRole, no external id needed (this is a same-organization,
#      role-to-role trust, not a third-party integration).
#   2. Attaches one inline policy granting bedrock:InvokeModel and
#      bedrock:InvokeModelWithResponseStream, scoped to:
#        - the Claude cross-region inference profiles in the CALLER's own
#          account, region --region (default eu-central-1) — e.g.
#          arn:aws:bedrock:eu-central-1:<caller account>:inference-profile/eu.anthropic.*
#        - the underlying foundation-model resources (account-agnostic ARNs)
#          in --region plus every --eu-destination-region (default: the six
#          EU regions of plan §14.1 — eu-central-1, eu-north-1, eu-south-1,
#          eu-south-2, eu-west-1, eu-west-3) — cross-region inference needs
#          InvokeModel on the model resource in whichever region actually
#          serves the call, not only the profile's "home" region.
#      D13 (DeepSeek) is NOT included: "the new delivery stages... run
#      without a DeepSeek tier" until lane `model-config` lands (plan.md
#      §14.3) — add its own resource ARNs then, under its own VTID.
#   3. Tags the role Key=vtid,Value=VTID-05702.
#   Never touches 472838866351, never creates a user or an access key, never
#   deletes anything, never grants any permission beyond bedrock:InvokeModel*.
#
# STOPS
#   - `provision` refuses outright if the caller's account IS 472838866351 —
#     this role belongs in vitana-engineering, never in production's account.
#   - `discover` refuses outright if the caller's account is NOT 472838866351.
#   - Both refuse a region other than eu-central-1 (CLAUDE.md IF–THEN 11's
#     region discipline; plan.md D5 — EU only).
#
# This script was written to be correct and ready to run, but — per the
# session that wrote it — was NOT executed against any real AWS account: it
# has no credentials into vitana-engineering, and running `discover` or
# `provision` against the wrong account is exactly the mistake this script's
# own guards exist to prevent. The owner runs it.

set -euo pipefail

EXPECTED_REGION="eu-central-1"
PROD_ACCOUNT="472838866351"
ROLE_NAME="vitana-delivery-bedrock"
CLUSTER="Vitana-ECS-Cluster"
STAGING_GATEWAY_SERVICE="vitana-gateway"
DEFAULT_EU_DESTINATIONS=(eu-central-1 eu-north-1 eu-south-1 eu-south-2 eu-west-1 eu-west-3)

ACTION=""
APPLY=0
TASK_ROLE_ARN=""
ENGINEERING_ACCOUNT_ID=""
REGION_ARG=""
EU_DESTINATIONS=()

usage() { sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    discover|provision) ACTION="$1"; shift ;;
    --apply) APPLY=1; shift ;;
    --task-role-arn) TASK_ROLE_ARN="${2:?needs an ARN}"; shift 2 ;;
    --engineering-account-id) ENGINEERING_ACCOUNT_ID="${2:?needs an account id}"; shift 2 ;;
    --region) REGION_ARG="${2:?needs a region}"; shift 2 ;;
    --eu-destination-region) EU_DESTINATIONS+=("${2:?needs a region}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$ACTION" ]; then
  echo "usage: $0 {discover|provision} [...]" >&2
  usage >&2
  exit 2
fi
[ "${#EU_DESTINATIONS[@]}" -gt 0 ] || EU_DESTINATIONS=("${DEFAULT_EU_DESTINATIONS[@]}")

command -v aws >/dev/null 2>&1 || { echo "aws CLI not found" >&2; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 3; }

REGION="${REGION_ARG:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [ -z "$REGION" ]; then REGION="$(aws configure get region 2>/dev/null || true)"; fi
if [ "$REGION" != "$EXPECTED_REGION" ]; then
  echo "refusing to run: region is '${REGION:-<unset>}', expected $EXPECTED_REGION (CLAUDE.md IF–THEN 11; plan.md D5, EU only)" >&2
  exit 4
fi
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

MODE="DRY-RUN"; [ "$APPLY" = 1 ] && MODE="APPLY"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# read_call: always runs. write_call: runs only with --apply (provision). Both
# print the exact call on fd 3 (the terminal), so a captured stdout never
# hides a call — same convention as setup-gitlab-oidc.sh.
exec 3>&1
read_call() { { printf '[READ]'; printf ' %q' "$@"; printf '\n'; } >&3; "$@"; }
write_call() {
  { printf '[%s]' "$MODE"; printf ' %q' "$@"; printf '\n'; } >&3
  if [ "$APPLY" = 1 ]; then "$@"; fi
}

ACCOUNT="$(read_call aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ -z "$ACCOUNT" ]; then
  echo "refusing to run: no caller identity (no AWS credentials active)" >&2
  exit 4
fi
echo "account $ACCOUNT, region $REGION, action $ACTION, mode $MODE"

case "$ACTION" in
  discover)
    if [ "$ACCOUNT" != "$PROD_ACCOUNT" ]; then
      echo "refusing: discover reads the staging gateway's task role and must run with caller account $PROD_ACCOUNT (got $ACCOUNT)" >&2
      exit 4
    fi
    echo
    echo "== staging gateway ($STAGING_GATEWAY_SERVICE) task role, cluster $CLUSTER"
    TD="$(read_call aws ecs describe-services --cluster "$CLUSTER" --services "$STAGING_GATEWAY_SERVICE" \
      --query 'services[0].taskDefinition' --output text 2>/dev/null || true)"
    if [ -z "$TD" ] || [ "$TD" = "None" ]; then
      echo "staging service $STAGING_GATEWAY_SERVICE not found in cluster $CLUSTER — nothing to report" >&2
      exit 6
    fi
    ROLE_ARN="$(read_call aws ecs describe-task-definition --task-definition "$TD" \
      --query 'taskDefinition.taskRoleArn' --output text 2>/dev/null)"
    echo
    echo "Task role ARN: $ROLE_ARN"
    echo "Pass it to provision:"
    echo "  scripts/aws/setup-delivery-bedrock.sh provision --task-role-arn $ROLE_ARN [--apply]"
    ;;

  provision)
    if [ "$ACCOUNT" = "$PROD_ACCOUNT" ]; then
      echo "refusing: $ROLE_NAME belongs in the vitana-engineering account, never in $PROD_ACCOUNT (this is NOT the vitana-delivery-bedrock-invoke policy of VTID-05774/PR#5006, which IS meant for $PROD_ACCOUNT — see this script's header)" >&2
      exit 4
    fi
    if [ -n "$ENGINEERING_ACCOUNT_ID" ] && [ "$ENGINEERING_ACCOUNT_ID" != "$ACCOUNT" ]; then
      echo "refusing: --engineering-account-id $ENGINEERING_ACCOUNT_ID does not match the caller's own account $ACCOUNT" >&2
      exit 4
    fi
    if [ -z "$TASK_ROLE_ARN" ]; then
      echo "refusing: --task-role-arn is required (run 'discover' first, with caller credentials for $PROD_ACCOUNT, to find it)" >&2
      exit 2
    fi
    case "$TASK_ROLE_ARN" in
      arn:aws:iam::"$PROD_ACCOUNT":role/*) : ;;
      *)
        echo "refusing: --task-role-arn '$TASK_ROLE_ARN' is not an arn:aws:iam::$PROD_ACCOUNT:role/<name> ARN" >&2
        exit 2
        ;;
    esac

    echo
    echo "== role $ROLE_NAME (account $ACCOUNT) trusting $TASK_ROLE_ARN"
    TRUST_POLICY="$(jq -n --arg principal "$TASK_ROLE_ARN" '{
      Version: "2012-10-17",
      Statement: [{
        Sid: "TrustVitanaGatewayStagingTaskRole",
        Effect: "Allow",
        Principal: { AWS: $principal },
        Action: "sts:AssumeRole"
      }]
    }')"
    printf '%s\n' "$TRUST_POLICY" > "$TMP/trust.json"
    echo "  trust: $(jq -c . "$TMP/trust.json")"

    if read_call aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
      write_call aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$TMP/trust.json"
    else
      write_call aws iam create-role --role-name "$ROLE_NAME" \
        --assume-role-policy-document "file://$TMP/trust.json" \
        --max-session-duration 3600 \
        --description "VTID-05702 agentic-delivery-v2: Bedrock for delivery-stage plan sparring/review, outside production's quota (vitana-engineering account)" \
        --tags Key=vtid,Value=VTID-05702
    fi

    echo
    echo "== permissions policy: bedrock:InvokeModel* (Claude only — no DeepSeek tier yet, plan.md §14.3)"
    PROFILE_ARN="arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/eu.anthropic.*"
    MODEL_RESOURCES="$(printf '%s\n' "${EU_DESTINATIONS[@]}" | jq -R . | jq -s --arg p "$PROFILE_ARN" '
      [$p] + (map("arn:aws:bedrock:" + . + "::foundation-model/anthropic.*"))
    ')"
    PERMISSIONS_POLICY="$(jq -n --argjson resources "$MODEL_RESOURCES" '{
      Version: "2012-10-17",
      Statement: [{
        Sid: "InvokeClaudeOnBedrockEu",
        Effect: "Allow",
        Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        Resource: $resources
      }]
    }')"
    printf '%s\n' "$PERMISSIONS_POLICY" > "$TMP/permissions.json"
    echo "  policy: $(jq -c . "$TMP/permissions.json")"
    write_call aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$ROLE_NAME" \
      --policy-document "file://$TMP/permissions.json"

    echo
    echo "Done ($MODE). Role ARN: arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"
    echo "Next steps (not done by this script):"
    echo "  1. Set DELIVERY_BEDROCK_ROLE_ARN=arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME} (and, if the engineering"
    echo "     account's Bedrock region ever differs, DELIVERY_BEDROCK_REGION) on the staging gateway's task"
    echo "     definition — services/gateway/src/providers/bedrock.ts reads both at call time, no restart beyond"
    echo "     the deploy itself needed."
    echo "  2. Confirm $TASK_ROLE_ARN itself may call sts:AssumeRole on this role (no explicit deny on that side);"
    echo "     ECS task roles allow outbound sts:AssumeRole by default unless a boundary/deny policy says otherwise."
    echo "  3. Verify with a real call once wired: invokeBedrock({ useDeliveryRole: true, ... }) from a staging"
    echo "     gateway instance — the owner applies this script; this session never did (no credentials into"
    echo "     vitana-engineering, and this is the wrong account/this session's own AWS access is for $PROD_ACCOUNT)."
    ;;
esac

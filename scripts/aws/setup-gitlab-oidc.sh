#!/usr/bin/env bash
# setup-gitlab-oidc.sh — GitLab sign-in to AWS for the delivery jobs (plan agentic-delivery §7, owner step A1;
# VTID-05546, lane deploy-path).
#
# WHO RUNS IT: the owner, in AWS CloudShell, with IAM admin rights in account 472838866351, region eu-central-1.
# No agent session runs --apply.
#
# DRY RUN BY DEFAULT: without --apply the script only reads (sts, iam get-*, ecs describe-*, secretsmanager
# describe-secret, elbv2 describe-*) and prints every call it would make, exactly, as "[DRY-RUN] aws …". With --apply
# the same calls run and are printed as "[APPLY] aws …". Every read is printed as "[READ] aws …".
#
# WHAT IT DOES (files in scripts/aws/iam/gitlab-oidc-*.json):
#   1. The IAM OIDC provider https://gitlab.vitanaland.com with the six audiences (gitlab-oidc-provider.json). AWS
#      checks only the sub and aud claims for a self-managed GitLab, so every trust policy pins both (StringEquals on
#      aud; sub pinned to the project path and ref of plan §7). No thumbprint is passed: IAM verifies the certificate
#      of the provider against its trusted root CAs (CreateOpenIDConnectProvider, ThumbprintList optional).
#   2. The six roles of plan §7: gl-v1-staging, gl-platform-staging, gl-v1-preview, gl-verify, gl-record, gl-assist.
#      Each gets its trust policy and one inline policy named after the role. PassRole of the two staging roles is
#      limited to the task and execution roles the staging services run with now, read from their live task
#      definitions. gl-v1-preview needs --preview-distribution-id (the preview CloudFront distribution).
#   3. The Secrets Manager secrets the jobs read: lists which exist and which need a value; --apply creates a missing
#      one empty (no value), and the owner fills it with the printed put-secret-value command.
#   4. scripts/eng/deploy/staging-tg-setup.sh in the same mode: the staging target groups' deregistration delay to 30 s.
#
# STOPS unless the caller's account is 472838866351 and the region is eu-central-1 (CLAUDE.md IF–THEN 11).
# NEVER: creates an access key or a user, touches a production role, service or target group, or deletes anything.
#
# USAGE:
#   scripts/aws/setup-gitlab-oidc.sh [--apply] [--preview-distribution-id ID] [--region eu-central-1]

set -euo pipefail

EXPECTED_ACCOUNT="472838866351"
EXPECTED_REGION="eu-central-1"
GITLAB_HOST="gitlab.vitanaland.com"
CLUSTER="Vitana-ECS-Cluster"
APPLY=0
PREVIEW_DIST=""
REGION_ARG=""
HERE="$(cd "$(dirname "$0")" && pwd)"
IAM_DIR="$HERE/iam"
TG_SCRIPT="$HERE/../eng/deploy/staging-tg-setup.sh"

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --preview-distribution-id) PREVIEW_DIST="${2:?needs an id}"; shift 2 ;;
    --region) REGION_ARG="${2:?needs a region}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI not found" >&2; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 3; }

REGION="${REGION_ARG:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [ -z "$REGION" ]; then REGION="$(aws configure get region 2>/dev/null || true)"; fi
if [ "$REGION" != "$EXPECTED_REGION" ]; then
  echo "refusing to run: region is '${REGION:-<unset>}', expected $EXPECTED_REGION (CLAUDE.md IF–THEN 11)" >&2
  exit 4
fi
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

MODE="DRY-RUN"; [ "$APPLY" = 1 ] && MODE="APPLY"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# read_call: always runs. write_call: runs only with --apply. Both print the exact call on fd 3 (the terminal), so a
# captured output never hides a call.
exec 3>&1
read_call() { { printf '[READ]'; printf ' %q' "$@"; printf '\n'; } >&3; "$@"; }
write_call() {
  { printf '[%s]' "$MODE"; printf ' %q' "$@"; printf '\n'; } >&3
  if [ "$APPLY" = 1 ]; then "$@"; fi
}

ACCOUNT="$(read_call aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  echo "refusing to run: caller account is '${ACCOUNT:-<no credentials>}', expected $EXPECTED_ACCOUNT (CLAUDE.md IF–THEN 11)" >&2
  exit 4
fi
echo "account $ACCOUNT, region $REGION, mode $MODE"

# --- 1. OIDC provider -------------------------------------------------------------------------------------------------
PROVIDER_ARN="arn:aws:iam::$EXPECTED_ACCOUNT:oidc-provider/$GITLAB_HOST"
PROVIDER_FILE="$IAM_DIR/gitlab-oidc-provider.json"
echo
echo "== 1. OIDC provider $PROVIDER_ARN"
if read_call aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" > "$TMP/provider.json" 2>/dev/null; then
  for aud in $(jq -r '.ClientIDList[]' "$PROVIDER_FILE"); do
    if jq -e --arg a "$aud" '.ClientIDList // [] | index($a)' "$TMP/provider.json" >/dev/null; then
      echo "  audience $aud present"
    else
      write_call aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" --client-id "$aud"
    fi
  done
else
  echo "  provider missing: create it with audiences $(jq -c '.ClientIDList' "$PROVIDER_FILE")"
  write_call aws iam create-open-id-connect-provider --cli-input-json "file://$PROVIDER_FILE"
fi

# --- 2. Roles ---------------------------------------------------------------------------------------------------------
# task_role_arns <service>… → JSON array of the task and execution roles those staging services run with now.
task_role_arns() {
  local arns="[]" svc td roles
  for svc in "$@"; do
    td="$(read_call aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --query 'services[0].taskDefinition' --output text 2>/dev/null || true)"
    if [ -z "$td" ] || [ "$td" = "None" ]; then echo "  staging service $svc not found: no task role read for it" >&2; continue; fi
    roles="$(read_call aws ecs describe-task-definition --task-definition "$td" --query 'taskDefinition.[taskRoleArn,executionRoleArn]' --output json 2>/dev/null)"
    arns="$(jq -c --argjson r "$roles" '. + ($r | map(select(. != null))) | unique' <<<"$arns")"
  done
  echo "$arns"
}

ensure_role() {
  local name="$1" trust="$2" policy_doc="$3"
  echo
  echo "== role $name (trust $(basename "$trust"))"
  echo "  trust: $(jq -c '.Statement[0].Condition' "$trust")"
  if read_call aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    write_call aws iam update-assume-role-policy --role-name "$name" --policy-document "file://$trust"
  else
    write_call aws iam create-role --role-name "$name" --assume-role-policy-document "file://$trust" \
      --max-session-duration 3600 --description "agentic-delivery GitLab delivery role (plan section 7)"
  fi
  printf '%s\n' "$policy_doc" > "$TMP/$name-policy.json"
  echo "  policy $name: $(jq -c . "$TMP/$name-policy.json")"
  write_call aws iam put-role-policy --role-name "$name" --policy-name "$name" --policy-document "file://$TMP/$name-policy.json"
}

with_pass_roles() { # <policy file> <role arns json>
  jq -c --argjson r "$2" '(.Statement[] | select(.Sid == "PassTaskRolesToEcsOnly") | .Resource) = $r' "$1"
}

refuse_prod_roles() { # <role arns json>
  case "$1" in *awsdr*|*-prod-*|*prod-*|*-prod\"*) echo "refusing: a staging service runs with a prod-named role: $1" >&2; exit 7 ;; esac
}

V1_ROLES="$(task_role_arns vitana-community-app-staging)"
if [ "$V1_ROLES" = "[]" ]; then echo "refusing: no task role of vitana-community-app-staging could be read" >&2; exit 6; fi
refuse_prod_roles "$V1_ROLES"
ensure_role gl-v1-staging "$IAM_DIR/gitlab-oidc-v1-staging-trust.json" \
  "$(with_pass_roles "$IAM_DIR/gitlab-oidc-v1-staging-policy.json" "$V1_ROLES")"

PF_ROLES="$(task_role_arns vitana-gateway vitana-erp-bridge vitana-kiro-runner vitana-postgrest-aurora-proxy)"
if [ "$PF_ROLES" = "[]" ]; then echo "refusing: no task role of the platform staging services could be read" >&2; exit 6; fi
refuse_prod_roles "$PF_ROLES"
ensure_role gl-platform-staging "$IAM_DIR/gitlab-oidc-platform-staging-trust.json" \
  "$(with_pass_roles "$IAM_DIR/gitlab-oidc-platform-staging-policy.json" "$PF_ROLES")"

if [ -z "$PREVIEW_DIST" ]; then
  echo
  echo "== role gl-v1-preview: SKIPPED. Pass --preview-distribution-id (the value of vitana-v1 secret PREVIEW_CF_DISTRIBUTION_ID)."
else
  case "$PREVIEW_DIST" in *[!A-Z0-9]*|"") echo "refusing: --preview-distribution-id '$PREVIEW_DIST' is not a CloudFront id" >&2; exit 2 ;; esac
  ensure_role gl-v1-preview "$IAM_DIR/gitlab-oidc-v1-preview-trust.json" \
    "$(sed "s/\${PREVIEW_CF_DISTRIBUTION_ID}/$PREVIEW_DIST/" "$IAM_DIR/gitlab-oidc-v1-preview-policy.json" | jq -c .)"
fi

for r in verify record assist; do
  ensure_role "gl-$r" "$IAM_DIR/gitlab-oidc-$r-trust.json" "$(jq -c . "$IAM_DIR/gitlab-oidc-$r-policy.json")"
done

# --- 3. Secrets -------------------------------------------------------------------------------------------------------
echo
echo "== 3. secrets (Secrets Manager, $REGION)"
NEEDS=()
for s in vitana/ci/test-user vitana/ci/oasis-recorder vitana/ci/gateway-service-token vitana/ci/llm-keys; do
  if read_call aws secretsmanager describe-secret --secret-id "$s" > "$TMP/secret.json" 2>/dev/null; then
    if jq -e '(.VersionIdsToStages // {}) | to_entries | map(.value[]) | index("AWSCURRENT")' "$TMP/secret.json" >/dev/null; then
      echo "  $s: exists, has a value"
    else
      echo "  $s: exists, NEEDS A VALUE"; NEEDS+=("$s")
    fi
  else
    echo "  $s: missing, NEEDS A VALUE"
    write_call aws secretsmanager create-secret --name "$s" --description "agentic-delivery GitLab CI secret (plan section 7); JSON keyed by the GitHub secret names it replaces"
    NEEDS+=("$s")
  fi
done
if [ "${#NEEDS[@]}" -gt 0 ]; then
  echo "  fill each secret that needs a value (JSON keyed by the GitHub secret names it replaces; RUNBOOK-delivery-aws.md):"
  for s in "${NEEDS[@]}"; do
    echo "    aws secretsmanager put-secret-value --region $REGION --secret-id $s --secret-string file://<json file>"
  done
fi

# --- 4. Staging target groups -----------------------------------------------------------------------------------------
echo
echo "== 4. staging target groups: deregistration delay 30 s"
if [ "$APPLY" = 1 ]; then bash "$TG_SCRIPT" --apply --region "$REGION"; else bash "$TG_SCRIPT" --region "$REGION"; fi

echo
echo "Done ($MODE). GitLab CI variables for the preview jobs (not secrets; set them on both projects, or let the M2 settings sync set them):"
echo "  PREVIEW_CF_DISTRIBUTION_ID=${PREVIEW_DIST:-<the preview distribution id>}   PREVIEW_CF_DOMAIN=<the preview CloudFront domain>"
echo "Role ARNs are fixed: arn:aws:iam::$EXPECTED_ACCOUNT:role/<gl-v1-staging|gl-platform-staging|gl-v1-preview|gl-verify|gl-record|gl-assist>."

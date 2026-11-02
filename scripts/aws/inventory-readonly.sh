#!/usr/bin/env bash
# inventory-readonly.sh — read-only inventory of the Vitana AWS estate (plan eng-platform-p01, lane aws-inventory).
#
# WHO RUNS IT: the owner (or anyone the owner hands a read-only identity to), e.g. with the AWS managed policy
# ReadOnlyAccess. No agent session has AWS credentials for this.
#
# WHAT IT DOES: calls only describe-*, list-* and get-* APIs and writes JSON files plus summary.md into a LOCAL output
# directory. It never writes to AWS, never uploads anything, and never reads a secret value or a decrypted parameter
# (Secrets Manager: names and metadata only).
#
# GUARDS: refuses to run unless `aws sts get-caller-identity` returns the expected account (CLAUDE.md IF-THEN 11: wrong
# account or region is a hard stop). A denied or failing call is recorded in summary.md and skipped; the run goes on.
#
# USAGE:
#   scripts/aws/inventory-readonly.sh [--out DIR] [--region REGION] [--account ID]
#     --out      output directory (default ./aws-inventory-<UTC date>)
#     --region   default eu-central-1
#     --account  default 472838866351
#   Exit 0 when the run completed (denied calls included); non-zero when a guard failed.
#
# OUTPUT LAYOUT: <out>/<area>/<name>.json for each call, <out>/summary.md (counts, denied calls, key findings:
# IAM users with access keys and their age, groups and permissions boundary, OIDC providers and role trusts, ECR repos with MUTABLE tags).

set -euo pipefail

EXPECTED_ACCOUNT="472838866351"
REGION="eu-central-1"
OUT=""

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --account) EXPECTED_ACCOUNT="${2:?--account needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI not found" >&2; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 3; }

# --- guard: account -------------------------------------------------------------------------------------------------
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  echo "refusing to run: caller account is '${ACCOUNT:-<no credentials>}', expected $EXPECTED_ACCOUNT" >&2
  exit 4
fi
CALLER="$(aws sts get-caller-identity --query Arn --output text)"

OUT="${OUT:-./aws-inventory-$(date -u +%Y%m%d)}"
mkdir -p "$OUT"
DENIED="$OUT/.denied"; : > "$DENIED"

# run <area> <name> <aws args...> — one read-only call, output to <out>/<area>/<name>.json
run() {
  local area="$1" name="$2"; shift 2
  mkdir -p "$OUT/$area"
  if ! aws --region "$REGION" --output json "$@" > "$OUT/$area/$name.json" 2> "$OUT/$area/$name.err"; then
    echo "- \`aws $*\`: $(head -c 300 "$OUT/$area/$name.err" | tr '\n' ' ')" >> "$DENIED"
    rm -f "$OUT/$area/$name.json"
  fi
  rm -f "$OUT/$area/$name.err"
}

# --- organization and account ---------------------------------------------------------------------------------------
run org describe-organization organizations describe-organization
run org list-accounts organizations list-accounts

# --- network --------------------------------------------------------------------------------------------------------
run network describe-vpcs ec2 describe-vpcs
run network describe-subnets ec2 describe-subnets
run network describe-security-groups ec2 describe-security-groups
run network describe-vpc-endpoints ec2 describe-vpc-endpoints
run network describe-nat-gateways ec2 describe-nat-gateways
run network describe-instances ec2 describe-instances

# --- IAM (global) ---------------------------------------------------------------------------------------------------
run iam list-open-id-connect-providers iam list-open-id-connect-providers
run iam list-roles iam list-roles
run iam list-users iam list-users
if [ -f "$OUT/iam/list-users.json" ]; then
  for u in $(jq -r '.Users[].UserName' "$OUT/iam/list-users.json"); do
    run iam/users "$u-access-keys" iam list-access-keys --user-name "$u"
    run iam/users "$u-attached-policies" iam list-attached-user-policies --user-name "$u"
    run iam/users "$u-inline-policies" iam list-user-policies --user-name "$u"
    run iam/users "$u-groups" iam list-groups-for-user --user-name "$u"
    run iam/users "$u-user" iam get-user --user-name "$u"
    if [ -f "$OUT/iam/users/$u-groups.json" ]; then
      for g in $(jq -r '.Groups[].GroupName' "$OUT/iam/users/$u-groups.json"); do
        run iam/groups "$g-attached-policies" iam list-attached-group-policies --group-name "$g"
        run iam/groups "$g-inline-policies" iam list-group-policies --group-name "$g"
      done
    fi
  done
fi

# --- containers -----------------------------------------------------------------------------------------------------
run ecr describe-repositories ecr describe-repositories
run ecs list-clusters ecs list-clusters
if [ -f "$OUT/ecs/list-clusters.json" ]; then
  for c in $(jq -r '.clusterArns[]' "$OUT/ecs/list-clusters.json"); do
    cn="${c##*/}"
    run "ecs/$cn" list-services ecs list-services --cluster "$c"
    if [ -f "$OUT/ecs/$cn/list-services.json" ]; then
      jq -r '.serviceArns[]' "$OUT/ecs/$cn/list-services.json" | split -l 10 - "$OUT/ecs/$cn/.batch-"
      i=0
      for b in "$OUT/ecs/$cn"/.batch-*; do
        [ -f "$b" ] || continue
        # shellcheck disable=SC2046
        run "ecs/$cn" "describe-services-$i" ecs describe-services --cluster "$c" --services $(cat "$b")
        rm -f "$b"; i=$((i + 1))
      done
    fi
  done
fi
run ecs list-task-definition-families ecs list-task-definition-families --status ACTIVE

# --- data stores ----------------------------------------------------------------------------------------------------
run data describe-db-clusters rds describe-db-clusters
run data describe-db-instances rds describe-db-instances
run data describe-cache-clusters elasticache describe-cache-clusters
run data describe-replication-groups elasticache describe-replication-groups

# --- load balancing -------------------------------------------------------------------------------------------------
run elb describe-load-balancers elbv2 describe-load-balancers
if [ -f "$OUT/elb/describe-load-balancers.json" ]; then
  for lb in $(jq -r '.LoadBalancers[].LoadBalancerArn' "$OUT/elb/describe-load-balancers.json"); do
    ln="$(echo "$lb" | awk -F/ '{print $(NF-1)}')"
    run "elb/$ln" describe-listeners elbv2 describe-listeners --load-balancer-arn "$lb"
    if [ -f "$OUT/elb/$ln/describe-listeners.json" ]; then
      for l in $(jq -r '.Listeners[].ListenerArn' "$OUT/elb/$ln/describe-listeners.json"); do
        run "elb/$ln" "describe-rules-${l##*/}" elbv2 describe-rules --listener-arn "$l"
      done
    fi
  done
fi
run elb describe-target-groups elbv2 describe-target-groups

# --- storage --------------------------------------------------------------------------------------------------------
run s3 list-buckets s3api list-buckets
if [ -f "$OUT/s3/list-buckets.json" ]; then
  for bk in $(jq -r '.Buckets[].Name' "$OUT/s3/list-buckets.json"); do
    run "s3/$bk" get-bucket-location s3api get-bucket-location --bucket "$bk"
    run "s3/$bk" get-bucket-encryption s3api get-bucket-encryption --bucket "$bk"
    run "s3/$bk" get-public-access-block s3api get-public-access-block --bucket "$bk"
  done
fi

# --- secrets (names and metadata only, never values) ----------------------------------------------------------------
run secrets list-secrets secretsmanager list-secrets

# --- security services ----------------------------------------------------------------------------------------------
run security describe-trails cloudtrail describe-trails
run security describe-configuration-recorders configservice describe-configuration-recorders
run security get-enabled-standards securityhub get-enabled-standards
run security list-detectors guardduty list-detectors

# --- cost (last 30 days by service; needs ce:GetCostAndUsage) -------------------------------------------------------
START="$(date -u -d '30 days ago' +%Y-%m-%d 2>/dev/null || date -u -v-30d +%Y-%m-%d)"
END="$(date -u +%Y-%m-%d)"
run cost get-cost-and-usage ce get-cost-and-usage --time-period "Start=$START,End=$END" \
  --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE

# --- summary --------------------------------------------------------------------------------------------------------
count() { [ -f "$1" ] && jq -r "$2" "$1" 2>/dev/null || echo "n/a"; }
{
  echo "# AWS inventory — account $ACCOUNT, region $REGION"
  echo
  echo "Run $(date -u +%Y-%m-%dT%H:%MZ) as \`$CALLER\`. Read-only; secret values were not read."
  echo
  echo "## Counts"
  echo "- VPCs: $(count "$OUT/network/describe-vpcs.json" '.Vpcs | length')"
  echo "- EC2 instances: $(count "$OUT/network/describe-instances.json" '[.Reservations[].Instances[]] | length')"
  echo "- IAM roles: $(count "$OUT/iam/list-roles.json" '.Roles | length')"
  echo "- IAM users: $(count "$OUT/iam/list-users.json" '.Users | length')"
  echo "- OIDC providers: $(count "$OUT/iam/list-open-id-connect-providers.json" '.OpenIDConnectProviderList | length')"
  echo "- ECR repositories: $(count "$OUT/ecr/describe-repositories.json" '.repositories | length')"
  echo "- ECS clusters: $(count "$OUT/ecs/list-clusters.json" '.clusterArns | length')"
  echo "- RDS clusters: $(count "$OUT/data/describe-db-clusters.json" '.DBClusters | length')"
  echo "- S3 buckets: $(count "$OUT/s3/list-buckets.json" '.Buckets | length')"
  echo "- Secrets: $(count "$OUT/secrets/list-secrets.json" '.SecretList | length')"
  echo
  echo "## IAM users with access keys"
  for f in "$OUT"/iam/users/*-access-keys.json; do
    [ -f "$f" ] || continue
    jq -r '.AccessKeyMetadata[] | "- \(.UserName): key …\(.AccessKeyId[-4:]) \(.Status), created \(.CreateDate)"' "$f"
  done
  echo
  echo "## Roles trusting a web identity (OIDC)"
  count "$OUT/iam/list-roles.json" '.Roles[] | select(.AssumeRolePolicyDocument | tostring | test("Federated")) |
    "- \(.RoleName): \(.AssumeRolePolicyDocument.Statement | map(.Condition // {} | tostring) | join(" | "))"'
  echo
  echo "## ECR repositories with mutable tags"
  count "$OUT/ecr/describe-repositories.json" '.repositories[] | select(.imageTagMutability == "MUTABLE") | "- \(.repositoryName)"'
  echo
  echo "## Denied or failed calls"
  if [ -s "$DENIED" ]; then cat "$DENIED"; else echo "none"; fi
} > "$OUT/summary.md"
rm -f "$DENIED"

echo "inventory written to $OUT (summary: $OUT/summary.md)"

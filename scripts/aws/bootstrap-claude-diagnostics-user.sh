#!/usr/bin/env bash
#
# ONE-TIME SETUP — run this in AWS CloudShell (eu-central-1), once.
#
# Creates a scoped IAM user whose access keys are pasted into the Claude Code
# environment settings, so every future session can inspect AWS directly
# instead of reporting "no AWS access".
#
# Idempotent: safe to re-run. Re-running rotates the access key (the old one is
# deleted) — which is also how you rotate on a schedule.
#
# WHAT IT GRANTS: read/describe across the services that have actually blocked
# work — DMS (Phase 0 reconciliation), ECS (task definitions, services), RDS
# (Aurora), ELB (ALB rules), CloudWatch Logs, EC2 describe (security groups),
# plus sts/iam self-inspection.
#
# WHAT IT DELIBERATELY DOES NOT GRANT:
#   - secretsmanager:GetSecretValue  (can list names, cannot read values)
#   - any Create/Update/Delete/Put/Run on anything
#   - iam write of any kind
# Diagnosis needs reads. If a specific write turns out to be needed, add that
# one action explicitly rather than widening to a managed admin policy.

set -euo pipefail

USER_NAME="claude-code-diagnostics"
POLICY_NAME="ClaudeCodeDiagnosticsRead"
REGION="eu-central-1"

echo "==> account: $(aws sts get-caller-identity --query Account --output text)"

# 1. User
if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "==> user $USER_NAME already exists"
else
  aws iam create-user --user-name "$USER_NAME" \
    --tags Key=purpose,Value=claude-code-diagnostics Key=managed-by,Value=bootstrap-script >/dev/null
  echo "==> created user $USER_NAME"
fi

# 2. Policy — read/describe only, scoped to what has actually blocked work.
cat > /tmp/claude-diag-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Identity",
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity", "iam:GetUser", "iam:ListAttachedUserPolicies", "iam:GetUserPolicy", "iam:ListUserPolicies"],
      "Resource": "*"
    },
    {
      "Sid": "DmsReadForPhase0",
      "Effect": "Allow",
      "Action": [
        "dms:Describe*",
        "dms:List*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EcsRead",
      "Effect": "Allow",
      "Action": ["ecs:Describe*", "ecs:List*"],
      "Resource": "*"
    },
    {
      "Sid": "RdsRead",
      "Effect": "Allow",
      "Action": ["rds:Describe*", "rds:List*"],
      "Resource": "*"
    },
    {
      "Sid": "LoadBalancerRead",
      "Effect": "Allow",
      "Action": ["elasticloadbalancing:Describe*"],
      "Resource": "*"
    },
    {
      "Sid": "LogsAndMetrics",
      "Effect": "Allow",
      "Action": [
        "logs:Describe*", "logs:Get*", "logs:FilterLogEvents", "logs:StartQuery", "logs:GetQueryResults",
        "cloudwatch:Describe*", "cloudwatch:Get*", "cloudwatch:List*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NetworkRead",
      "Effect": "Allow",
      "Action": ["ec2:DescribeSecurityGroups", "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeNetworkInterfaces"],
      "Resource": "*"
    },
    {
      "Sid": "EcrAndEventsRead",
      "Effect": "Allow",
      "Action": ["ecr:Describe*", "ecr:List*", "ecr:GetAuthorizationToken", "events:Describe*", "events:List*", "application-autoscaling:Describe*"],
      "Resource": "*"
    },
    {
      "Sid": "SecretNamesOnlyNoValues",
      "Effect": "Allow",
      "Action": ["secretsmanager:ListSecrets", "secretsmanager:DescribeSecret"],
      "Resource": "*"
    }
  ]
}
JSON

aws iam put-user-policy \
  --user-name "$USER_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document file:///tmp/claude-diag-policy.json
echo "==> policy $POLICY_NAME attached (read/describe only)"

# 3. Rotate: delete existing keys, mint one fresh
for k in $(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$k"
  echo "==> deleted old access key $k"
done

CREDS=$(aws iam create-access-key --user-name "$USER_NAME" --output json)
AK=$(echo "$CREDS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessKey"]["AccessKeyId"])')
SK=$(echo "$CREDS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessKey"]["SecretAccessKey"])')

cat <<EOF

=====================================================================
 DONE. Add these THREE environment variables to the Claude Code
 environment (claude.ai/code -> your environment -> Environment
 variables), then every future session has AWS access automatically.

   AWS_ACCESS_KEY_ID       = $AK
   AWS_SECRET_ACCESS_KEY   = $SK
   AWS_DEFAULT_REGION      = $REGION

 Also add this to the environment's SETUP SCRIPT, because the AWS CLI
 is not installed in the session container by default:

   curl -sS "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \\
     && unzip -q /tmp/awscli.zip -d /tmp && sudo /tmp/aws/install --update

 Verify from a new session with:  aws sts get-caller-identity
=====================================================================

 Note: this key is read/describe only — it cannot read secret VALUES
 and cannot create, modify or delete anything. Re-run this script any
 time to rotate (it deletes the old key first).

EOF

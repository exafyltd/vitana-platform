#!/usr/bin/env bash
#
# VTID-04999 / VTID-05003 — provision the kiro-runner on AWS (staging or
# production) and link a user's own Kiro API key.
#
#   --env staging     (default) names below, as VTID-04999 shipped them
#   --env production  vitana-kiro-runner-awsdr, its own token, key prefix,
#                     task role and Cloud Map name (VTID-05003)
#
# Staging and production gateways share one VPC, subnets and security group
# (read live 2026-10-09), so the network does not separate them: each runner
# has its OWN token, and each gateway is only ever given its own environment's
# token and URL. Keys are per environment too (link once per environment).
#
# WHY THIS EXISTS
#
# `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` refuses to run until the ECR repo, the ECS
# service and the runner token secret exist (its preflight). Creating them needs
# AWS admin rights no Claude Code session has, so the owner runs this instead —
# the same arrangement as scripts/aws/setup-erp-bridge-staging.sh, whose pinned
# network facts (VPC, subnets, the shared private-services security group, the
# `vitana.internal` Cloud Map namespace) this script reuses.
#
# WHAT IT DOES
#
#   provision   ECR repo `vitana/kiro-runner`, log group, the runner token
#               secret (generated once, never overwritten, never printed), the
#               runner's OWN task role `vitana-kiro-runner-task-role` with
#               access to `vitana/kiro/staging/users/*` only, read access for
#               the execution role to the token secret, the security-group rule
#               (private services SG -> runner :8080), Cloud Map service
#               `kiro-runner.vitana.internal`, a placeholder task definition and
#               the ECS service with desiredCount 0. The deploy workflow's next
#               run builds the real image and scales it to 1. The gateway staging
#               deploy wires KIRO_RUNNER_URL / KIRO_RUNNER_TOKEN /
#               KIRO_ENGINE_ENABLED once the token secret exists.
#
#   link-user   Stores one user's own Kiro API key as
#               `vitana/kiro/staging/users/<user_id>`. The key is read with a
#               hidden prompt (never argv, never shell history), passed to the
#               AWS CLI through a 0600 temp file that is removed straight after,
#               and the secret gets the same "only the runner may read it"
#               resource policy the runner applies itself. The Command Hub's
#               Kiro workspace card does the same thing from the browser.
#
#   status      Prints what exists, and whether a user's key is linked.
#
#   VTID-05070 (the kiro-browser screenshot sidecar, a second container of the runner task):
#   provision also creates the ECR repo `vitana/kiro-browser`, the registry token secret
#   `vitana/kiro-runner/<env>/browser-registry-token` (generated once, never printed; the
#   runner and the sidecar share it) and lets the execution role read
#   `vitana/kiro-runner/<env>/browser-*`.
#
#   set-browser-password  Stores the E2E test user's password as
#               `vitana/kiro-runner/<env>/browser-test-user-password` (hidden prompt, 0600 temp
#               file, never argv). Only the kiro-browser container gets it, as an ECS secret;
#               the runner and kiro-cli never do. Without it, screenshots are signed out.
#
# WHAT IT DOES NOT DO
#
#   - --env staging never touches production names (no *-awsdr); --env production
#     asks for confirmation (or KIRO_PROD_CONFIRM=yes) and only touches *-awsdr / production names.
#   - It never builds or pushes an image (the workflow does, CLAUDE.md ALWAYS 17).
#   - It never prints a key or the runner token.
#
# USAGE
#
#   scripts/aws/setup-kiro-runner.sh [--env staging|production] provision            # dry run
#   scripts/aws/setup-kiro-runner.sh [--env staging|production] provision --apply
#   scripts/aws/setup-kiro-runner.sh [--env staging|production] link-user --user-id <uuid> --apply
#   scripts/aws/setup-kiro-runner.sh [--env staging|production] status [--user-id <uuid>]
#   scripts/aws/setup-kiro-runner.sh [--env staging|production] set-browser-password --apply
#   (scripts/aws/setup-kiro-runner-staging.sh is the staging shortcut.)
#
# Requires: aws CLI v2 (admin on 472838866351), jq, openssl.
set -euo pipefail

# ---- pinned facts (network facts shared with setup-erp-bridge-staging.sh) ----
REGION="eu-central-1"
ACCOUNT_ID="472838866351"
CLUSTER="Vitana-ECS-Cluster"
ENV_NAME="staging"
if [ "${1:-}" = "--env" ]; then ENV_NAME="${2:-}"; shift 2; fi
case "$ENV_NAME" in
  staging)
    SERVICE="vitana-kiro-runner"; FAMILY="vitana-kiro-runner"; LOG_GROUP="/vitana/kiro-runner"
    DNS_SERVICE="kiro-runner"; TASK_ROLE_NAME="vitana-kiro-runner-task-role" ;;
  production)
    SERVICE="vitana-kiro-runner-awsdr"; FAMILY="vitana-kiro-runner-awsdr"; LOG_GROUP="/vitana/kiro-runner-prod"
    DNS_SERVICE="kiro-runner-prod"; TASK_ROLE_NAME="vitana-kiro-runner-prod-task-role" ;;
  *) printf 'ERROR: --env must be staging or production\n' >&2; exit 2 ;;
esac
CONTAINER="kiro-runner"
ECR_REPO="vitana/kiro-runner"                 # one repo: production promotes the staging-verified image
ECR_BROWSER_REPO="vitana/kiro-browser"        # VTID-05070 sidecar; promoted the same way
SECRET_BROWSER_REGISTRY="vitana/kiro-runner/${ENV_NAME}/browser-registry-token"
SECRET_BROWSER_PASSWORD="vitana/kiro-runner/${ENV_NAME}/browser-test-user-password"
SECRET_TOKEN="vitana/kiro-runner/${ENV_NAME}/runner-token"
KEY_PREFIX="vitana/kiro/${ENV_NAME}/users"
NAMESPACE="vitana.internal"
VPC_ID="vpc-05958f035e596fe64"
SUBNETS="subnet-0ff45a2051c5e5482,subnet-0c786864a28a5a821"   # same as vitana-gateway and vitana-gateway-awsdr
SG_SERVICES="sg-0fbcf7b59b1f0d685"           # both gateways + every private service (read live 2026-10-09)
EXEC_ROLE_NAME="vitana-ecs-task-execution-role"
EXEC_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"
TASK_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE_NAME}"
PLACEHOLDER_IMAGE="public.ecr.aws/docker/library/node:20-bookworm-slim"
CPU="1024"; MEMORY="2048"
PORT="8080"

APPLY=0
CMD="${1:-}"; shift || true

say()  { printf '%s\n' "$*"; }
plan() { printf '  [plan] %s\n' "$*"; }
run()  { if [ "$APPLY" = 1 ]; then printf '  [apply] %s\n' "$*"; "$@"; else plan "$*"; fi; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { type -P "$1" >/dev/null 2>&1 || die "missing tool: $1"; }
aws()  { command aws --region "$REGION" "$@"; }

case "$CMD" in provision|link-user|status|set-browser-password) ;; *) sed -n '2,75p' "$0" | sed 's/^# \{0,1\}//'; exit 2;; esac
need aws; need jq; need openssl
if [ "$ENV_NAME" = "staging" ]; then
  [[ "$SERVICE" == *awsdr* || "$SERVICE" == *prod* ]] && die "refusing a prod-looking service name for staging"
else
  [[ "$SERVICE" == *awsdr ]] || die "production service must be the -awsdr one"
  if [ "${KIRO_PROD_CONFIRM:-}" != "yes" ] && [ -t 0 ]; then
    read -r -p "This changes PRODUCTION AWS resources ($SERVICE). Type 'production' to continue: " ANSWER
    [ "$ANSWER" = "production" ] || die "aborted"
  fi
fi
ACCT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCT" = "$ACCOUNT_ID" ] || die "wrong AWS account: $ACCT (want $ACCOUNT_ID)"

only_runner_reads_policy() {
  jq -nc --arg r "$TASK_ROLE" '{Version:"2012-10-17",Statement:[{Sid:"OnlyKiroRunnerReadsTheKey",Effect:"Deny",Principal:"*",
    Action:"secretsmanager:GetSecretValue",Resource:"*",Condition:{StringNotEquals:{"aws:PrincipalArn":$r}}}]}'
}

# ----------------------------------------------------------------------------
provision() {
  say "== kiro-runner ${ENV_NAME} provision (apply=$APPLY) =="

  say "-- 1. ECR repository $ECR_REPO"
  if aws ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1; then say "   exists"
  else run aws ecr create-repository --repository-name "$ECR_REPO" \
         --image-scanning-configuration scanOnPush=true --image-tag-mutability MUTABLE \
         --tags Key=vtid,Value=VTID-04999 Key=env,Value=${ENV_NAME} >/dev/null; fi

  say "-- 2. CloudWatch log group $LOG_GROUP"
  if aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --query "logGroups[?logGroupName=='$LOG_GROUP']" --output text | grep -q .; then say "   exists"
  else run aws logs create-log-group --log-group-name "$LOG_GROUP"
       run aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30; fi

  say "-- 3. Runner token secret $SECRET_TOKEN"
  if aws secretsmanager describe-secret --secret-id "$SECRET_TOKEN" >/dev/null 2>&1; then say "   exists (never rotated by this script)"
  elif [ "$APPLY" = 1 ]; then
    TOKEN=$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48)
    aws secretsmanager create-secret --name "$SECRET_TOKEN" --description "VTID-04999 gateway -> kiro-runner token (${ENV_NAME})" \
      --secret-string "$TOKEN" --tags Key=vtid,Value=VTID-04999 >/dev/null
    unset TOKEN
    say "   [apply] created $SECRET_TOKEN (48 random chars; value not printed)"
  else plan "create $SECRET_TOKEN with a 48-char random value"; fi

  say "-- 4. Runner task role $TASK_ROLE_NAME (its own; the gateway's role gets nothing)"
  if aws iam get-role --role-name "$TASK_ROLE_NAME" >/dev/null 2>&1; then say "   exists"
  else
    TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole",
      "Condition":{"StringEquals":{"aws:SourceAccount":"'"$ACCOUNT_ID"'"}}}]}'
    run aws iam create-role --role-name "$TASK_ROLE_NAME" --assume-role-policy-document "$TRUST" \
      --description "VTID-04999 kiro-runner: per-user Kiro keys under $KEY_PREFIX only" --tags Key=vtid,Value=VTID-04999 >/dev/null
  fi
  KEYS_POLICY=$(jq -nc --arg arn "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${KEY_PREFIX}/*" '{Version:"2012-10-17",Statement:[
    {Sid:"KiroUserKeys",Effect:"Allow",Action:["secretsmanager:CreateSecret","secretsmanager:PutSecretValue","secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret","secretsmanager:DeleteSecret","secretsmanager:PutResourcePolicy","secretsmanager:TagResource"],Resource:$arn}]}')
  run aws iam put-role-policy --role-name "$TASK_ROLE_NAME" --policy-name kiro-user-keys --policy-document "$KEYS_POLICY"

  say "-- 5. Execution role may read the runner token (injected as KIRO_RUNNER_TOKEN)"
  TOKEN_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_TOKEN" --query ARN --output text 2>/dev/null || echo "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${SECRET_TOKEN}-*")
  EXEC_POLICY=$(jq -nc --arg a "$TOKEN_ARN" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["secretsmanager:GetSecretValue"],Resource:[$a]}]}')
  run aws iam put-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name "kiro-runner-token-${ENV_NAME}" --policy-document "$EXEC_POLICY"

  say "-- 5b. VTID-05070 kiro-browser sidecar: ECR repo $ECR_BROWSER_REPO, registry token, execution-role read"
  if aws ecr describe-repositories --repository-names "$ECR_BROWSER_REPO" >/dev/null 2>&1; then say "   ECR repo exists"
  else run aws ecr create-repository --repository-name "$ECR_BROWSER_REPO" \
         --image-scanning-configuration scanOnPush=true --image-tag-mutability MUTABLE \
         --tags Key=vtid,Value=VTID-05070 Key=env,Value=${ENV_NAME} >/dev/null; fi
  if aws secretsmanager describe-secret --secret-id "$SECRET_BROWSER_REGISTRY" >/dev/null 2>&1; then say "   registry token exists (never rotated by this script)"
  elif [ "$APPLY" = 1 ]; then
    BTOKEN=$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48)
    aws secretsmanager create-secret --name "$SECRET_BROWSER_REGISTRY" --description "VTID-05070 kiro-runner -> kiro-browser registry token (${ENV_NAME})" \
      --secret-string "$BTOKEN" --tags Key=vtid,Value=VTID-05070 >/dev/null
    unset BTOKEN
    say "   [apply] created $SECRET_BROWSER_REGISTRY (48 random chars; value not printed)"
  else plan "create $SECRET_BROWSER_REGISTRY with a 48-char random value"; fi
  BROWSER_POLICY=$(jq -nc --arg a "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:vitana/kiro-runner/${ENV_NAME}/browser-*" \
    '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["secretsmanager:GetSecretValue"],Resource:[$a]}]}')
  run aws iam put-role-policy --role-name "$EXEC_ROLE_NAME" --policy-name "kiro-browser-secrets-${ENV_NAME}" --policy-document "$BROWSER_POLICY"

  say "-- 6. Security group: $SG_SERVICES :$PORT from itself (gateway -> runner)"
  if aws ec2 describe-security-group-rules --filters "Name=group-id,Values=$SG_SERVICES" \
       --query "SecurityGroupRules[?IsEgress==\`false\` && FromPort==\`$PORT\` && ReferencedGroupInfo.GroupId=='$SG_SERVICES']" --output text | grep -q .; then
    say "   rule exists (shared with erp-bridge)"
  else run aws ec2 authorize-security-group-ingress --group-id "$SG_SERVICES" --ip-permissions \
         "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,UserIdGroupPairs=[{GroupId=$SG_SERVICES,Description=VTID-04999 kiro-runner}]" >/dev/null; fi

  say "-- 7. Cloud Map: $DNS_SERVICE.$NAMESPACE"
  NS_ID=$(aws servicediscovery list-namespaces --query "Namespaces[?Name=='$NAMESPACE'].Id" --output text)
  if [ -n "$NS_ID" ] && [ "$NS_ID" != "None" ]; then say "   namespace exists: $NS_ID"
  elif [ "$APPLY" = 1 ]; then
    OP=$(aws servicediscovery create-private-dns-namespace --name "$NAMESPACE" --vpc "$VPC_ID" \
           --description "private service DNS" --query OperationId --output text)
    say "   [apply] creating namespace (operation $OP)…"
    for _ in $(seq 1 30); do
      ST=$(aws servicediscovery get-operation --operation-id "$OP" --query Operation.Status --output text)
      [ "$ST" = "SUCCESS" ] && break; [ "$ST" = "FAIL" ] && die "namespace creation failed"; sleep 5
    done
    NS_ID=$(aws servicediscovery get-operation --operation-id "$OP" --query 'Operation.Targets.NAMESPACE' --output text)
  else plan "create-private-dns-namespace $NAMESPACE in $VPC_ID"; NS_ID="<pending>"; fi
  REG_ARN=""
  if [ "$NS_ID" != "<pending>" ]; then
    REG_ARN=$(aws servicediscovery list-services --filters "Name=NAMESPACE_ID,Values=$NS_ID" \
                --query "Services[?Name=='$DNS_SERVICE'].Arn" --output text)
  fi
  if [ -n "$REG_ARN" ] && [ "$REG_ARN" != "None" ]; then say "   dns service exists: $REG_ARN"
  elif [ "$APPLY" = 1 ]; then
    REG_ARN=$(aws servicediscovery create-service --name "$DNS_SERVICE" --namespace-id "$NS_ID" \
                --dns-config "RoutingPolicy=MULTIVALUE,DnsRecords=[{Type=A,TTL=10}]" \
                --health-check-custom-config FailureThreshold=1 --query Service.Arn --output text)
    say "   [apply] dns service $REG_ARN"
  else plan "create-service $DNS_SERVICE (A, TTL 10) in $NAMESPACE"; fi

  say "-- 8. Placeholder task definition $FAMILY"
  if aws ecs describe-task-definition --task-definition "$FAMILY" >/dev/null 2>&1; then say "   family has an ACTIVE revision; not re-registering"
  else
    TD=$(jq -n --arg fam "$FAMILY" --arg img "$PLACEHOLDER_IMAGE" --arg name "$CONTAINER" \
           --arg exec "$EXEC_ROLE" --arg task "$TASK_ROLE" --arg cpu "$CPU" --arg mem "$MEMORY" \
           --arg lg "$LOG_GROUP" --arg region "$REGION" --arg st "$TOKEN_ARN" --arg prefix "$KEY_PREFIX" --arg envname "$ENV_NAME" \
           --argjson port "$PORT" '{
      family:$fam, networkMode:"awsvpc", requiresCompatibilities:["FARGATE"], cpu:$cpu, memory:$mem,
      executionRoleArn:$exec, taskRoleArn:$task,
      runtimePlatform:{cpuArchitecture:"X86_64", operatingSystemFamily:"LINUX"},
      containerDefinitions:[{
        name:$name, image:$img, essential:true,
        portMappings:[{containerPort:$port, protocol:"tcp"}],
        environment:[{name:"KIRO_KEY_SECRET_PREFIX", value:$prefix}, {name:"KIRO_KEY_READER_ROLE_ARN", value:$task}, {name:"AWS_REGION", value:$region}],
        secrets:[{name:"KIRO_RUNNER_TOKEN", valueFrom:$st}],
        logConfiguration:{logDriver:"awslogs", options:{"awslogs-group":$lg, "awslogs-region":$region, "awslogs-stream-prefix":"ecs"}},
        healthCheck:{command:["CMD","node","/app/dist/healthcheck.js"],
                     interval:30, timeout:5, retries:3, startPeriod:20}
      }],
      tags:[{key:"vtid", value:"VTID-04999"}, {key:"env", value:$envname}]}')
    if [ "$APPLY" = 1 ]; then
      aws ecs register-task-definition --cli-input-json "$TD" --query taskDefinition.taskDefinitionArn --output text
    else plan "register-task-definition $FAMILY (placeholder image; the workflow swaps the image and keeps the rest)"; fi
  fi

  say "-- 9. ECS service $SERVICE (desiredCount 0 until the workflow rolls the real image)"
  ST=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].status' --output text 2>/dev/null || echo MISSING)
  if [ "$ST" = "ACTIVE" ]; then say "   exists (ACTIVE)"
  elif [ "$APPLY" = 1 ]; then
    [ -n "$REG_ARN" ] && [ "$REG_ARN" != "None" ] || die "Cloud Map service ARN unknown; re-run provision --apply"
    aws ecs create-service --cluster "$CLUSTER" --service-name "$SERVICE" --task-definition "$FAMILY" \
      --desired-count 0 --launch-type FARGATE --platform-version LATEST \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG_SERVICES}],assignPublicIp=DISABLED}" \
      --service-registries "registryArn=$REG_ARN" \
      --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
      --propagate-tags TASK_DEFINITION --tags key=vtid,value=VTID-04999 key=env,value=${ENV_NAME} \
      --query 'service.serviceArn' --output text
  else plan "create-service $SERVICE (FARGATE, private, Cloud Map registry, desiredCount 0)"; fi

  if [ "$ENV_NAME" = "production" ]; then
    PARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_TOKEN" --query ARN --output text 2>/dev/null || echo "<after-apply>")
    say ""
    say "Production gateway wiring: set the repository variable (the prod deploy role cannot look up secrets):"
    say "   gh variable set KIRO_RUNNER_PROD_TOKEN_ARN --repo exafyltd/vitana-platform --body '$PARN'"
    BARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_BROWSER_REGISTRY" --query ARN --output text 2>/dev/null || echo "<after-apply>")
    say "VTID-05070 (only when the owner enables the screenshot sidecar in production):"
    say "   gh variable set KIRO_BROWSER_PROD_REGISTRY_TOKEN_ARN --repo exafyltd/vitana-platform --body '$BARN'"
  fi
  say ""
  say "Next: dispatch AWS-STAGE-DEPLOY-KIRO-RUNNER.yml (or push under services/kiro-runner/**) to build and roll the runner,"
  say "      (production: AWS-PROD-DEPLOY-KIRO-RUNNER.yml with the staging-verified commit), then the next gateway deploy of this environment wires it in. Link your key in the Kiro workspace card or with link-user."
}

# ----------------------------------------------------------------------------
link_user() {
  local USER_ID=""
  while [ $# -gt 0 ]; do case "$1" in
    --user-id) USER_ID="$2"; shift 2;; --apply) APPLY=1; shift;; *) die "unknown flag $1";; esac; done
  [[ "$USER_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "--user-id must be the Command Hub user's UUID (lowercase)"
  local NAME="$KEY_PREFIX/$USER_ID"
  say "== link Kiro API key for $USER_ID -> $NAME (apply=$APPLY) =="
  if [ "$APPLY" != 1 ]; then plan "read the key with a hidden prompt, store it as $NAME, apply the only-the-runner-reads policy"; return 0; fi
  [ -t 0 ] || die "run this in an interactive terminal (the key is read with a hidden prompt)"
  local KEY=""
  read -rs -p "Kiro API key (input hidden): " KEY; printf '\n'
  [ -n "$KEY" ] || die "no key entered"
  [[ "$KEY" =~ ^[^[:space:]]+$ ]] || die "the key must not contain spaces"
  local TMP; TMP=$(umask 077; mktemp)
  trap 'rm -f "$TMP"' RETURN
  printf '%s' "$KEY" > "$TMP"; KEY=""
  if aws secretsmanager describe-secret --secret-id "$NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$NAME" --secret-string "file://$TMP" >/dev/null
    say "   replaced the key in $NAME"
  else
    aws secretsmanager create-secret --name "$NAME" --description "VTID-04999 Kiro API key of one Command Hub user" \
      --secret-string "file://$TMP" --tags Key=vtid,Value=VTID-04999 >/dev/null
    say "   created $NAME"
  fi
  rm -f "$TMP"
  aws secretsmanager put-resource-policy --secret-id "$NAME" --resource-policy "$(only_runner_reads_policy)" --block-public-policy >/dev/null
  say "   only $TASK_ROLE_NAME may read it. Key not printed. Open a Kiro thread in the ${ENV_NAME} Command Hub to use it."
}

# ----------------------------------------------------------------------------
# VTID-05070: the E2E test user's password, for the kiro-browser sidecar only.
set_browser_password() {
  while [ $# -gt 0 ]; do case "$1" in --apply) APPLY=1; shift;; *) die "unknown flag $1";; esac; done
  say "== kiro-browser test-user password -> $SECRET_BROWSER_PASSWORD (apply=$APPLY) =="
  if [ "$APPLY" != 1 ]; then plan "read the password with a hidden prompt and store it as $SECRET_BROWSER_PASSWORD"; return 0; fi
  [ -t 0 ] || die "run this in an interactive terminal (the password is read with a hidden prompt)"
  local PW=""
  read -rs -p "E2E test user password (input hidden): " PW; printf '\n'
  [ -n "$PW" ] || die "no password entered"
  local TMP; TMP=$(umask 077; mktemp)
  trap 'rm -f "$TMP"' RETURN
  printf '%s' "$PW" > "$TMP"; PW=""
  if aws secretsmanager describe-secret --secret-id "$SECRET_BROWSER_PASSWORD" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$SECRET_BROWSER_PASSWORD" --secret-string "file://$TMP" >/dev/null
    say "   replaced"
  else
    aws secretsmanager create-secret --name "$SECRET_BROWSER_PASSWORD" --description "VTID-05070 E2E test user password for the kiro-browser sidecar (${ENV_NAME})" \
      --secret-string "file://$TMP" --tags Key=vtid,Value=VTID-05070 >/dev/null
    say "   created"
  fi
  rm -f "$TMP"
  if [ "$ENV_NAME" = "production" ]; then
    say "   gh variable set KIRO_BROWSER_PROD_PASSWORD_ARN --repo exafyltd/vitana-platform --body '$(aws secretsmanager describe-secret --secret-id "$SECRET_BROWSER_PASSWORD" --query ARN --output text)'"
  fi
  say "   Value not printed. The next runner deploy gives it to the kiro-browser container only."
}

# ----------------------------------------------------------------------------
status() {
  local USER_ID=""
  while [ $# -gt 0 ]; do case "$1" in --user-id) USER_ID="$2"; shift 2;; *) die "unknown flag $1";; esac; done
  say "== kiro-runner ${ENV_NAME} status =="
  aws ecr describe-repositories --repository-names "$ECR_REPO" --query 'repositories[0].repositoryUri' --output text 2>/dev/null || say "ECR: missing"
  aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].{status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' --output table 2>/dev/null || say "ECS service: missing"
  aws secretsmanager describe-secret --secret-id "$SECRET_TOKEN" --query 'Name' --output text 2>/dev/null || say "secret missing: $SECRET_TOKEN"
  aws iam get-role --role-name "$TASK_ROLE_NAME" --query 'Role.Arn' --output text 2>/dev/null || say "role missing: $TASK_ROLE_NAME"
  aws ecr describe-repositories --repository-names "$ECR_BROWSER_REPO" --query 'repositories[0].repositoryUri' --output text 2>/dev/null || say "ECR (kiro-browser): missing"
  aws secretsmanager describe-secret --secret-id "$SECRET_BROWSER_REGISTRY" --query 'Name' --output text 2>/dev/null || say "secret missing: $SECRET_BROWSER_REGISTRY"
  aws secretsmanager describe-secret --secret-id "$SECRET_BROWSER_PASSWORD" --query 'Name' --output text 2>/dev/null || say "secret missing (screenshots signed out): $SECRET_BROWSER_PASSWORD"
  if [ -n "$USER_ID" ]; then
    aws secretsmanager describe-secret --secret-id "$KEY_PREFIX/$USER_ID" --query '{name:Name,changed:LastChangedDate}' --output table 2>/dev/null || say "no key linked for $USER_ID"
  fi
}

case "$CMD" in
  provision) [ "${1:-}" = "--apply" ] && APPLY=1; provision;;
  link-user) link_user "$@";;
  status) status "$@";;
  set-browser-password) set_browser_password "$@";;
esac

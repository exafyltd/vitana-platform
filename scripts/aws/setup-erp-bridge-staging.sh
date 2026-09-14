#!/usr/bin/env bash
#
# VTID-03840 — provision the erp-bridge on AWS STAGING and bootstrap a tenant.
#
# WHY THIS EXISTS
#
# `AWS-STAGE-DEPLOY-ERP-BRIDGE.yml` deliberately refuses to run until the ECR
# repo, the ECS service and the two Secrets Manager entries exist (its
# preflight). Those resources need AWS admin rights that no Claude Code
# session has (the session's IAM user is read-only for ECR/ECS/RDS/Secrets:
# `AccessDenied` on ecr:CreateRepository, secretsmanager:CreateSecret, …).
# This script is the exact, idempotent set of calls an operator runs instead.
# Every fact below (subnets, security groups, roles, RDS endpoint, VPC) was
# read from the live account on 2026-09-14, not guessed.
#
# WHAT IT DOES (three phases, each idempotent)
#
#   provision         ECR repo, log group, the two secrets (token generated
#                     once, never overwritten; tenants starts as {}), the
#                     security-group rules (gateway -> bridge :8080, bridge ->
#                     RDS :5432), a Cloud Map private DNS namespace
#                     `vitana.internal` + service `erp-bridge` (so the gateway
#                     reaches it at http://erp-bridge.vitana.internal:8080 with
#                     NO ALB rule — the bridge stays private), a placeholder
#                     task definition and the ECS service with desiredCount 0.
#                     After this the deploy workflow's preflight passes and its
#                     next run (push to main under services/erp-bridge/**, or a
#                     manual dispatch) builds the real image and rolls it.
#
#   bootstrap-tenant  Runs services/erp-bridge/scripts/bootstrap_tenant.py as a
#                     one-shot ECS task INSIDE the VPC using the deployed
#                     bridge image: creates the tenant's Postgres role +
#                     database on the staging RDS instance (a separate database
#                     on `vitana-postgres-staging`, never the app database),
#                     initialises ERPClaw, installs the vendored CRM module,
#                     creates the company, loads the CoA and seeds defaults.
#                     Then merges the tenant into the `tenants` secret and
#                     scales the service to 1. The Postgres MASTER password is
#                     read by the task from the RDS-managed secret and is never
#                     printed, stored or passed through this shell.
#
#   status            Prints what exists.
#
# WHAT IT DOES NOT DO
#
#   - It never touches production (`*-awsdr`, `AWS-PROD-*`). Names are pinned.
#   - It never builds or pushes an image: that is the workflow's job (CLAUDE.md
#     ALWAYS 17 — deploy via the canonical workflow, not by hand).
#   - It never runs DDL from the laptop: the RDS instance is private.
#   - It does not wire the gateway: `AWS-STAGE-DEPLOY-GATEWAY.yml` already
#     upserts ERP_BRIDGE_URL / ERP_BRIDGE_TOKEN on the gateway task definition
#     whenever the token secret exists (VTID-03840). The next gateway staging
#     deploy after `provision` picks it up.
#
# USAGE
#
#   scripts/aws/setup-erp-bridge-staging.sh provision                 # dry run
#   scripts/aws/setup-erp-bridge-staging.sh provision --apply
#   scripts/aws/setup-erp-bridge-staging.sh bootstrap-tenant \
#       --tenant-id <vitana tenant uuid> --db-name erpclaw_vitanaland \
#       --company-name "Vitanaland Trading LLC" --abbr VTL \
#       [--currency AED] [--country "United Arab Emirates"] [--coa uae_ifrs] --apply
#   scripts/aws/setup-erp-bridge-staging.sh status
#
# Requires: aws CLI v2 (admin on 472838866351), jq, python3, openssl.
set -euo pipefail

# ---- pinned facts (read live 2026-09-14; the ONLY place they live) ----------
REGION="eu-central-1"
ACCOUNT_ID="472838866351"
CLUSTER="Vitana-ECS-Cluster"
SERVICE="vitana-erp-bridge"                   # must never contain awsdr/prod
FAMILY="vitana-erp-bridge"
BOOTSTRAP_FAMILY="vitana-erp-bridge-bootstrap"
CONTAINER="erp-bridge"
ECR_REPO="vitana/erp-bridge"
LOG_GROUP="/vitana/erp-bridge"
SECRET_TOKEN="vitana/erp-bridge/staging/bridge-token"
SECRET_TENANTS="vitana/erp-bridge/staging/tenants"
SECRET_TENANT_DB_PREFIX="vitana/erp-bridge/staging/tenant-db"
NAMESPACE="vitana.internal"
DNS_SERVICE="erp-bridge"
VPC_ID="vpc-05958f035e596fe64"
SUBNETS="subnet-0ff45a2051c5e5482,subnet-0c786864a28a5a821"   # same as vitana-gateway (staging)
SG_SERVICES="sg-0fbcf7b59b1f0d685"           # gateway staging + every private service
SG_RDS="sg-0838b2f2dabe87971"                # vitana-postgres-staging
RDS_ID="vitana-postgres-staging"
EXEC_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/vitana-ecs-task-execution-role"
TASK_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/vitana-ecs-task-role"
PLACEHOLDER_IMAGE="public.ecr.aws/docker/library/python:3.11-slim"
CPU="512"; MEMORY="1024"
BRIDGE_PORT="8080"

APPLY=0
CMD="${1:-}"; shift || true

say()  { printf '%s\n' "$*"; }
plan() { printf '  [plan] %s\n' "$*"; }
run()  { if [ "$APPLY" = 1 ]; then printf '  [apply] %s\n' "$*"; "$@"; else plan "$*"; fi; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { type -P "$1" >/dev/null 2>&1 || die "missing tool: $1"; }   # type -P: the real binary, not the aws() wrapper below
aws()  { command aws --region "$REGION" "$@"; }

case "$CMD" in provision|bootstrap-tenant|status) ;; *) sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit 2;; esac
need aws; need jq; need python3; need openssl
[[ "$SERVICE" == *awsdr* || "$SERVICE" == *prod* ]] && die "refusing a prod-looking service name"
ACCT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCT" = "$ACCOUNT_ID" ] || die "wrong AWS account: $ACCT (want $ACCOUNT_ID)"

# ----------------------------------------------------------------------------
provision() {
  say "== erp-bridge STAGING provision (apply=$APPLY) =="

  say "-- 1. ECR repository $ECR_REPO"
  if aws ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1; then say "   exists"
  else run aws ecr create-repository --repository-name "$ECR_REPO" \
         --image-scanning-configuration scanOnPush=true --image-tag-mutability MUTABLE \
         --tags Key=vtid,Value=VTID-03840 Key=env,Value=staging >/dev/null; fi

  say "-- 2. CloudWatch log group $LOG_GROUP"
  if aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --query "logGroups[?logGroupName=='$LOG_GROUP']" --output text | grep -q .; then say "   exists"
  else run aws logs create-log-group --log-group-name "$LOG_GROUP"
       run aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30; fi

  say "-- 3. Secrets Manager"
  if aws secretsmanager describe-secret --secret-id "$SECRET_TOKEN" >/dev/null 2>&1; then say "   $SECRET_TOKEN exists (never rotated by this script)"
  else
    if [ "$APPLY" = 1 ]; then
      TOKEN=$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48)
      aws secretsmanager create-secret --name "$SECRET_TOKEN" --description "VTID-03840 erp-bridge shared token (staging)" \
        --secret-string "$TOKEN" --tags Key=vtid,Value=VTID-03840 >/dev/null
      say "   [apply] created $SECRET_TOKEN (48 random chars; value not printed)"
    else plan "create $SECRET_TOKEN with a 48-char random value"; fi
  fi
  if aws secretsmanager describe-secret --secret-id "$SECRET_TENANTS" >/dev/null 2>&1; then say "   $SECRET_TENANTS exists"
  else run aws secretsmanager create-secret --name "$SECRET_TENANTS" --description "VTID-03840 erp-bridge tenant map (staging)" \
         --secret-string '{}' --tags Key=vtid,Value=VTID-03840 >/dev/null; fi

  say "-- 4. Security-group rules"
  sg_rule() { # sg port source-sg
    if aws ec2 describe-security-group-rules --filters "Name=group-id,Values=$1" \
         --query "SecurityGroupRules[?IsEgress==\`false\` && FromPort==\`$2\` && ReferencedGroupInfo.GroupId=='$3']" --output text | grep -q .; then
      say "   $1 :$2 from $3 exists"
    else run aws ec2 authorize-security-group-ingress --group-id "$1" --ip-permissions \
           "IpProtocol=tcp,FromPort=$2,ToPort=$2,UserIdGroupPairs=[{GroupId=$3,Description=VTID-03840 erp-bridge}]" >/dev/null; fi
  }
  sg_rule "$SG_SERVICES" "$BRIDGE_PORT" "$SG_SERVICES"   # gateway (same SG) -> bridge
  sg_rule "$SG_RDS" 5432 "$SG_SERVICES"                  # bridge -> staging RDS

  say "-- 5. Cloud Map private DNS: $DNS_SERVICE.$NAMESPACE (VPC $VPC_ID)"
  NS_ID=$(aws servicediscovery list-namespaces --query "Namespaces[?Name=='$NAMESPACE'].Id" --output text)
  if [ -n "$NS_ID" ] && [ "$NS_ID" != "None" ]; then say "   namespace exists: $NS_ID"
  elif [ "$APPLY" = 1 ]; then
    OP=$(aws servicediscovery create-private-dns-namespace --name "$NAMESPACE" --vpc "$VPC_ID" \
           --description "VTID-03840 private service DNS (staging)" --query OperationId --output text)
    say "   [apply] creating namespace (operation $OP)…"
    for _ in $(seq 1 30); do
      ST=$(aws servicediscovery get-operation --operation-id "$OP" --query Operation.Status --output text)
      [ "$ST" = "SUCCESS" ] && break; [ "$ST" = "FAIL" ] && die "namespace creation failed"; sleep 5
    done
    NS_ID=$(aws servicediscovery get-operation --operation-id "$OP" --query 'Operation.Targets.NAMESPACE' --output text)
    say "   namespace $NS_ID"
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

  say "-- 6. Placeholder task definition $FAMILY"
  if aws ecs describe-task-definition --task-definition "$FAMILY" >/dev/null 2>&1; then say "   family has an ACTIVE revision; not re-registering"
  else
    SEC_TOKEN_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_TOKEN" --query ARN --output text 2>/dev/null || echo "<after-apply>")
    SEC_TENANTS_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_TENANTS" --query ARN --output text 2>/dev/null || echo "<after-apply>")
    TD=$(jq -n --arg fam "$FAMILY" --arg img "$PLACEHOLDER_IMAGE" --arg name "$CONTAINER" \
           --arg exec "$EXEC_ROLE" --arg task "$TASK_ROLE" --arg cpu "$CPU" --arg mem "$MEMORY" \
           --arg lg "$LOG_GROUP" --arg region "$REGION" --arg st "$SEC_TOKEN_ARN" --arg stn "$SEC_TENANTS_ARN" \
           --argjson port "$BRIDGE_PORT" '{
      family:$fam, networkMode:"awsvpc", requiresCompatibilities:["FARGATE"], cpu:$cpu, memory:$mem,
      executionRoleArn:$exec, taskRoleArn:$task,
      runtimePlatform:{cpuArchitecture:"X86_64", operatingSystemFamily:"LINUX"},
      containerDefinitions:[{
        name:$name, image:$img, essential:true,
        portMappings:[{containerPort:$port, protocol:"tcp"}],
        environment:[{name:"ERP_BRIDGE_ENV", value:"staging"}, {name:"ERP_BRIDGE_MODULE_ALLOWLIST", value:"erpclaw-growth"}],
        secrets:[{name:"ERP_BRIDGE_TOKEN", valueFrom:$st}, {name:"ERP_TENANTS", valueFrom:$stn}],
        logConfiguration:{logDriver:"awslogs", options:{"awslogs-group":$lg, "awslogs-region":$region, "awslogs-stream-prefix":"ecs"}},
        healthCheck:{command:["CMD-SHELL","python3 -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen(\\\"http://127.0.0.1:8080/alive\\\",timeout=3).status==200 else 1)\""],
                     interval:30, timeout:5, retries:3, startPeriod:20}
      }],
      tags:[{key:"vtid", value:"VTID-03840"}, {key:"env", value:"staging"}]}')
    if [ "$APPLY" = 1 ]; then
      aws ecs register-task-definition --cli-input-json "$TD" --query taskDefinition.taskDefinitionArn --output text
    else plan "register-task-definition $FAMILY (placeholder image $PLACEHOLDER_IMAGE; the workflow swaps the image and keeps the rest)"; fi
  fi

  say "-- 7. ECS service $SERVICE (desiredCount 0 until a tenant is bootstrapped)"
  ST=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].status' --output text 2>/dev/null || echo MISSING)
  if [ "$ST" = "ACTIVE" ]; then say "   exists (ACTIVE)"
  elif [ "$APPLY" = 1 ]; then
    [ -n "$REG_ARN" ] && [ "$REG_ARN" != "None" ] || die "Cloud Map service ARN unknown; re-run provision --apply"
    aws ecs create-service --cluster "$CLUSTER" --service-name "$SERVICE" --task-definition "$FAMILY" \
      --desired-count 0 --launch-type FARGATE --platform-version LATEST \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG_SERVICES}],assignPublicIp=DISABLED}" \
      --service-registries "registryArn=$REG_ARN" \
      --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
      --propagate-tags TASK_DEFINITION --tags key=vtid,value=VTID-03840 key=env,value=staging \
      --query 'service.serviceArn' --output text
  else plan "create-service $SERVICE (FARGATE, private, Cloud Map registry, desiredCount 0)"; fi

  say ""
  say "Next: let AWS-STAGE-DEPLOY-ERP-BRIDGE.yml build+roll the real image (push to main under services/erp-bridge/** or dispatch it with a reason),"
  say "      then run: $0 bootstrap-tenant --tenant-id <uuid> --db-name erpclaw_<slug> --company-name … --abbr … --apply"
}

# ----------------------------------------------------------------------------
bootstrap_tenant() {
  local TENANT_ID="" DB_NAME="" COMPANY="" ABBR="" CURRENCY="AED" COUNTRY="United Arab Emirates" COA="uae_ifrs" FY="1"
  while [ $# -gt 0 ]; do case "$1" in
    --tenant-id) TENANT_ID="$2"; shift 2;; --db-name) DB_NAME="$2"; shift 2;;
    --company-name) COMPANY="$2"; shift 2;; --abbr) ABBR="$2"; shift 2;;
    --currency) CURRENCY="$2"; shift 2;; --country) COUNTRY="$2"; shift 2;;
    --coa) COA="$2"; shift 2;; --fy-start-month) FY="$2"; shift 2;;
    --apply) APPLY=1; shift;; *) die "unknown flag $1";; esac; done
  [[ "$TENANT_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "--tenant-id must be a UUID"
  [[ "$DB_NAME" =~ ^[a-z][a-z0-9_]{0,39}$ ]] || die "--db-name must match ^[a-z][a-z0-9_]{0,39}$"
  [ -n "$COMPANY" ] && [ -n "$ABBR" ] || die "--company-name and --abbr are required"
  say "== bootstrap tenant $TENANT_ID -> db $DB_NAME (apply=$APPLY) =="

  # the deployed image (refuse the placeholder: it has no ERPClaw in it)
  TD_ARN=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
  IMG=$(aws ecs describe-task-definition --task-definition "$TD_ARN" --query 'taskDefinition.containerDefinitions[0].image' --output text)
  case "$IMG" in *"$ECR_REPO"*) say "   image: $IMG";; *) die "service still runs the placeholder ($IMG); let the deploy workflow roll the real image first";; esac

  # RDS endpoint + master secret (RDS-managed; the task reads only the password key)
  RDS_JSON=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]')
  DB_HOST=$(jq -r .Endpoint.Address <<<"$RDS_JSON"); DB_PORT=$(jq -r .Endpoint.Port <<<"$RDS_JSON")
  ADMIN_USER=$(jq -r .MasterUsername <<<"$RDS_JSON"); MASTER_SECRET=$(jq -r .MasterUserSecret.SecretArn <<<"$RDS_JSON")
  [ "$MASTER_SECRET" != "null" ] || die "$RDS_ID has no RDS-managed master secret"
  say "   rds: $DB_HOST:$DB_PORT master=$ADMIN_USER"

  # per-tenant DB password, generated once, kept in its own secret
  TSECRET="$SECRET_TENANT_DB_PREFIX/$TENANT_ID"
  if aws secretsmanager describe-secret --secret-id "$TSECRET" >/dev/null 2>&1; then say "   $TSECRET exists"
  elif [ "$APPLY" = 1 ]; then
    PW=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
    aws secretsmanager create-secret --name "$TSECRET" --description "VTID-03840 ERPClaw tenant DB password" \
      --secret-string "$PW" --tags Key=vtid,Value=VTID-03840 Key=tenant,Value="$TENANT_ID" >/dev/null
    say "   [apply] created $TSECRET"
  else plan "create $TSECRET (40 random chars)"; fi
  TSECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$TSECRET" --query ARN --output text 2>/dev/null || echo "<after-apply>")

  # the execution role must be allowed to read both secrets for this task
  POLICY=$(jq -n --arg a "$MASTER_SECRET" --arg b "$TSECRET_ARN" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["secretsmanager:GetSecretValue"],Resource:[$a,$b]}]}')
  run aws iam put-role-policy --role-name "${EXEC_ROLE##*/}" --policy-name "erp-bridge-bootstrap-$TENANT_ID" --policy-document "$POLICY"

  # bootstrap task definition: same image, command = the bootstrap script
  BOOT_TD=$(aws ecs describe-task-definition --task-definition "$TD_ARN" --query taskDefinition \
    | jq --arg fam "$BOOTSTRAP_FAMILY" --arg ms "$MASTER_SECRET" --arg ts "$TSECRET_ARN" '
        .family = $fam
        | .containerDefinitions[0].command = ["python3", "/app/scripts/bootstrap_tenant.py"]
        | .containerDefinitions[0].portMappings = []
        | del(.containerDefinitions[0].healthCheck)
        | .containerDefinitions[0].secrets = [
            {name:"ERP_BOOTSTRAP_ADMIN_PASSWORD", valueFrom:($ms + ":password::")},
            {name:"ERP_BOOTSTRAP_DB_PASSWORD",    valueFrom:$ts} ]
        | .containerDefinitions[0].environment = [ .containerDefinitions[0].environment[] | select(.name | startswith("ERP_BRIDGE_") | not) ]
        | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)')
  if [ "$APPLY" = 1 ]; then
    BOOT_ARN=$(aws ecs register-task-definition --cli-input-json "$BOOT_TD" --query taskDefinition.taskDefinitionArn --output text)
  else plan "register-task-definition $BOOTSTRAP_FAMILY (image $IMG, command bootstrap_tenant.py)"; BOOT_ARN="<after-apply>"; fi

  OVERRIDES=$(jq -n --arg c "$CONTAINER" --arg t "$TENANT_ID" --arg h "$DB_HOST" --arg p "$DB_PORT" --arg u "$ADMIN_USER" \
                 --arg d "$DB_NAME" --arg cn "$COMPANY" --arg ab "$ABBR" --arg cu "$CURRENCY" --arg co "$COUNTRY" --arg coa "$COA" --arg fy "$FY" '{
    containerOverrides:[{name:$c, environment:[
      {name:"ERP_BOOTSTRAP_TENANT_ID",value:$t},{name:"ERP_BOOTSTRAP_DB_HOST",value:$h},{name:"ERP_BOOTSTRAP_DB_PORT",value:$p},
      {name:"ERP_BOOTSTRAP_ADMIN_USER",value:$u},{name:"ERP_BOOTSTRAP_DB_NAME",value:$d},
      {name:"ERP_BOOTSTRAP_COMPANY_NAME",value:$cn},{name:"ERP_BOOTSTRAP_COMPANY_ABBR",value:$ab},
      {name:"ERP_BOOTSTRAP_COMPANY_CURRENCY",value:$cu},{name:"ERP_BOOTSTRAP_COMPANY_COUNTRY",value:$co},
      {name:"ERP_BOOTSTRAP_COA_TEMPLATE",value:$coa},{name:"ERP_BOOTSTRAP_FY_START_MONTH",value:$fy}]}]}')
  if [ "$APPLY" != 1 ]; then plan "run-task $BOOTSTRAP_FAMILY with the tenant overrides, wait, read BOOTSTRAP_RESULT from $LOG_GROUP"; plan "merge tenant into $SECRET_TENANTS and scale $SERVICE to 1"; return 0; fi

  TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$BOOT_ARN" --launch-type FARGATE --platform-version LATEST \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG_SERVICES}],assignPublicIp=DISABLED}" \
      --overrides "$OVERRIDES" --started-by "setup-erp-bridge-staging" --query 'tasks[0].taskArn' --output text)
  say "   task $TASK_ARN — waiting (initialize-database + module install ≈ 1–3 min)…"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
  EXIT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)
  STREAM="ecs/$CONTAINER/${TASK_ARN##*/}"
  LOGS=$(aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$STREAM" --start-from-head --query 'events[].message' --output text || true)
  printf '%s\n' "$LOGS" | sed 's/^/   | /' | tail -40
  [ "$EXIT" = "0" ] || die "bootstrap task exited $EXIT (see $LOG_GROUP/$STREAM)"
  RESULT=$(printf '%s\n' "$LOGS" | sed -n 's/^BOOTSTRAP_RESULT //p' | tail -1)
  [ -n "$RESULT" ] || die "no BOOTSTRAP_RESULT line in the task log"
  COMPANY_ID=$(jq -r .company_id <<<"$RESULT"); DB_ROLE=$(jq -r .db_role <<<"$RESULT")

  # compose the ERP_TENANTS entry (the only place the tenant DB URL lives)
  PW=$(aws secretsmanager get-secret-value --secret-id "$TSECRET" --query SecretString --output text)
  DB_URL=$(python3 -c 'import sys,urllib.parse as u; r,p,h,po,d=sys.argv[1:]; print(f"postgresql://{u.quote(r,safe=\"\")}:{u.quote(p,safe=\"\")}@{h}:{po}/{d}?sslmode=require")' "$DB_ROLE" "$PW" "$DB_HOST" "$DB_PORT" "$DB_NAME")
  CURRENT=$(aws secretsmanager get-secret-value --secret-id "$SECRET_TENANTS" --query SecretString --output text)
  NEW=$(jq -c --arg t "$TENANT_ID" --arg url "$DB_URL" --arg cid "$COMPANY_ID" '. + {($t): {db_url:$url, company_id:$cid}}' <<<"$CURRENT")
  aws secretsmanager put-secret-value --secret-id "$SECRET_TENANTS" --secret-string "$NEW" >/dev/null
  say "   tenants secret updated: $(jq -r 'keys|join(",")' <<<"$NEW") (company_id $COMPANY_ID)"
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 1 --force-new-deployment >/dev/null
  say "   $SERVICE -> desiredCount 1, new deployment (picks up the tenant map)"
  say "Done. Verify: the gateway's next staging deploy reports the bridge configured; GET /api/v1/backoffice/commands works for tenant $TENANT_ID."
}

# ----------------------------------------------------------------------------
status() {
  say "== erp-bridge STAGING status =="
  aws ecr describe-repositories --repository-names "$ECR_REPO" --query 'repositories[0].repositoryUri' --output text 2>/dev/null || say "ECR: missing"
  aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].{status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' --output table 2>/dev/null || say "ECS service: missing"
  for s in "$SECRET_TOKEN" "$SECRET_TENANTS"; do aws secretsmanager describe-secret --secret-id "$s" --query 'Name' --output text 2>/dev/null || say "secret missing: $s"; done
  aws servicediscovery list-namespaces --query "Namespaces[?Name=='$NAMESPACE'].Id" --output text
}

case "$CMD" in
  provision) [ "${1:-}" = "--apply" ] && APPLY=1; provision;;
  bootstrap-tenant) bootstrap_tenant "$@";;
  status) status;;
esac

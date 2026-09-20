#!/usr/bin/env bash
#
# VTID-04101 — provision the PostgREST-on-Aurora proxy on AWS STAGING.
#
# WHY THIS EXISTS
#
# `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml` deliberately refuses to run
# until the ECR repo and the ECS service exist (its preflight, same pattern
# as AWS-STAGE-DEPLOY-ERP-BRIDGE.yml). Those need AWS admin rights no Claude
# Code session has — confirmed live on 2026-09-19: this session's IAM user
# gets AccessDenied on ecr:CreateRepository, ecr:GetAuthorizationToken (i.e.
# it cannot even docker-login, let alone push), ecs:CreateService, and
# ecs:DeregisterTaskDefinition, while ecs:RegisterTaskDefinition (additive,
# versioned, never destructive) DID succeed. This script is the exact,
# idempotent set of calls an operator runs instead — the same shape as
# setup-erp-bridge-staging.sh, reusing facts that script already established
# live (subnets, the ECS app-tier security group, the `vitana.internal`
# Cloud Map namespace) rather than re-deriving them.
#
# WHAT'S ALREADY TRUE ON AURORA (verified live 2026-09-19, VTID-04084):
#   - 0 foreign keys on the public schema — the old fk-drop step this
#     service's README described in August is moot; nothing to drop.
#   - Full RLS parity: 606 tables with RLS enabled, 1,059 policies, matching
#     Supabase's live pg_policies snapshot exactly (a fresh full-load reload
#     was run and verified the same day — see docs/AURORA-MIGRATION-STATUS
#     and the VTID-04084 branch history).
#   - `authenticator` role exists, can login, and its password was just
#     re-synced to match the `vitana/aurora/prod/postgrest-authenticator-uri`
#     secret (the DMS target endpoint's OWN stored password for the same
#     account had drifted stale — a real, independently-confirmed defect —
#     so this role's password was reset defensively rather than assumed
#     correct).
#   - auth.uid()/auth.jwt()/auth.role()/auth.email() shim functions and the
#     anon/authenticated/service_role roles exist (PR #3087 groundwork).
#   - The ECS app-tier security group (sg-0fbcf7b59b1f0d685, same SG
#     vitana-gateway/erp-bridge run in) ALREADY has an ingress rule into
#     Aurora's SG (sg-0838b2f2dabe87971) on 5432 ("PostgreSQL from ECS app
#     tier") — no new security-group rule needed for the postgrest
#     container to reach Aurora.
#   - The `vitana.internal` Cloud Map private-DNS namespace already exists
#     (created for erp-bridge) — reused here, no new namespace needed.
#
# WHAT IT DOES (idempotent)
#
#   provision   ECR repo, log group, a new Cloud Map service `postgrest-aurora`
#               in the existing `vitana.internal` namespace (so the gateway
#               reaches it at http://postgrest-aurora.vitana.internal:8080 —
#               plain HTTP is fine, this is intra-VPC traffic, same posture
#               as erp-bridge; no ALB rule, so none of CLAUDE.md's ALB
#               priority-collision traps apply), a placeholder two-container
#               task definition (real `postgrest/postgrest:v12.2.3` image —
#               that one needs no build, it's pulled straight from Docker
#               Hub — plus a placeholder for OUR nginx proxy container until
#               CI builds and pushes the real one), and the ECS service at
#               desiredCount 1 (unlike erp-bridge, there is no bootstrap
#               step gating this — Aurora's data/RLS are already correct
#               today, so it can come up serving traffic on the very first
#               deploy once the real proxy image lands).
#
#   status      Prints what exists.
#
# WHAT IT DOES NOT DO
#
#   - It never touches production (`*-awsdr`, `AWS-PROD-*`). Names pinned.
#   - It never builds or pushes an image — CLAUDE.md ALWAYS 17: that's
#     AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml's job, on the next push to
#     `main` under `services/postgrest-aurora-proxy/**` (or a manual
#     dispatch) after this script's `provision --apply` has run.
#   - It does NOT repoint any gateway `SUPABASE_URL` at this proxy. That is
#     a deliberate, separate, later step — only after the proxy is deployed
#     and independently smoke-tested (real login through GoTrue passthrough,
#     a `.from()` read, an RLS-sensitive read confirming tenant isolation
#     still holds) does it make sense to consider redirecting the ~590
#     gateway files that talk to Supabase's REST API. Redirecting blind
#     would risk exactly what CLAUDE.md's "Never bypass RLS"/"Never mix
#     tenant data" rules exist to prevent.
#
# USAGE
#
#   scripts/aws/setup-postgrest-aurora-proxy-staging.sh provision            # dry run
#   scripts/aws/setup-postgrest-aurora-proxy-staging.sh provision --apply
#   scripts/aws/setup-postgrest-aurora-proxy-staging.sh status
#
# Requires: aws CLI v2 (admin on 472838866351), jq.
set -euo pipefail

# ---- pinned facts (read live 2026-09-19; the ONLY place they live) --------
REGION="eu-central-1"
ACCOUNT_ID="472838866351"
CLUSTER="Vitana-ECS-Cluster"
SERVICE="vitana-postgrest-aurora-proxy"        # must never contain awsdr/prod
FAMILY="vitana-postgrest-aurora-staging"
PROXY_CONTAINER="proxy"
POSTGREST_CONTAINER="postgrest"
ECR_REPO="vitana/postgrest-aurora-proxy"
LOG_GROUP="/ecs/vitana-postgrest-aurora-staging"
SECRET_DB_URI="vitana/aurora/prod/postgrest-authenticator-uri"
SECRET_JWT="vitana/gateway/staging/supabase-jwt-secret"   # sha256-identical to vitana/supabase/prod/jwt-secret (verified 2026-08-06)
NAMESPACE="vitana.internal"
DNS_SERVICE="postgrest-aurora"
SUBNETS="subnet-0ff45a2051c5e5482,subnet-0c786864a28a5a821"   # same as vitana-gateway (staging)
SG_SERVICES="sg-0fbcf7b59b1f0d685"           # gateway staging + every private service; already allowed into Aurora's SG on 5432
EXEC_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/vitana-ecs-task-execution-role"
TASK_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/vitana-ecs-task-role"
PLACEHOLDER_PROXY_IMAGE="public.ecr.aws/docker/library/nginx:1.27-alpine"
POSTGREST_IMAGE="postgrest/postgrest:v12.2.3"
AURORA_HOST="vitana-aurora-prod.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com"
SUPABASE_AUTH_HOST="inmkhvwdcuyhnxkgfvsb.supabase.co"
CPU="512"; MEMORY="1024"
PROXY_PORT="8080"

APPLY=0
CMD="${1:-}"; shift || true

say()  { printf '%s\n' "$*"; }
plan() { printf '  [plan] %s\n' "$*"; }
run()  { if [ "$APPLY" = 1 ]; then printf '  [apply] %s\n' "$*"; "$@"; else plan "$*"; fi; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { type -P "$1" >/dev/null 2>&1 || die "missing tool: $1"; }
aws()  { command aws --region "$REGION" "$@"; }

case "$CMD" in provision|status) ;; *) sed -n '2,90p' "$0" | sed 's/^# \{0,1\}//'; exit 2;; esac
need aws; need jq
[[ "$SERVICE" == *awsdr* || "$SERVICE" == *prod* ]] && die "refusing a prod-looking service name"
ACCT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCT" = "$ACCOUNT_ID" ] || die "wrong AWS account: $ACCT (want $ACCOUNT_ID)"

# ----------------------------------------------------------------------------
provision() {
  say "== postgrest-aurora-proxy STAGING provision (apply=$APPLY) =="

  say "-- 1. ECR repository $ECR_REPO"
  if aws ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1; then say "   exists"
  else run aws ecr create-repository --repository-name "$ECR_REPO" \
         --image-scanning-configuration scanOnPush=true --image-tag-mutability MUTABLE \
         --tags Key=vtid,Value=VTID-04101 Key=env,Value=staging >/dev/null; fi

  say "-- 2. CloudWatch log group $LOG_GROUP"
  if aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --query "logGroups[?logGroupName=='$LOG_GROUP']" --output text | grep -q .; then say "   exists"
  else run aws logs create-log-group --log-group-name "$LOG_GROUP"
       run aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30; fi

  say "-- 3. Secrets (must already exist — this script never creates DB/JWT secrets)"
  for NAME in "$SECRET_DB_URI" "$SECRET_JWT"; do
    aws secretsmanager describe-secret --secret-id "$NAME" >/dev/null 2>&1 \
      && say "   $NAME exists" \
      || die "secret '$NAME' missing — refusing to register a task definition that cannot start"
  done

  say "-- 4. Cloud Map private DNS: $DNS_SERVICE.$NAMESPACE"
  NS_ID=$(aws servicediscovery list-namespaces --query "Namespaces[?Name=='$NAMESPACE'].Id" --output text)
  [ -n "$NS_ID" ] && [ "$NS_ID" != "None" ] || die "namespace $NAMESPACE not found — expected it to already exist (created for erp-bridge)"
  say "   namespace: $NS_ID"
  REG_ARN=$(aws servicediscovery list-services --filters "Name=NAMESPACE_ID,Values=$NS_ID" \
              --query "Services[?Name=='$DNS_SERVICE'].Arn" --output text)
  if [ -n "$REG_ARN" ] && [ "$REG_ARN" != "None" ]; then say "   dns service exists: $REG_ARN"
  elif [ "$APPLY" = 1 ]; then
    REG_ARN=$(aws servicediscovery create-service --name "$DNS_SERVICE" --namespace-id "$NS_ID" \
                --dns-config "RoutingPolicy=MULTIVALUE,DnsRecords=[{Type=A,TTL=10}]" \
                --health-check-custom-config FailureThreshold=1 --query Service.Arn --output text)
    say "   [apply] dns service $REG_ARN"
  else plan "create-service $DNS_SERVICE (A, TTL 10) in $NAMESPACE"; fi

  say "-- 5. Task definition $FAMILY"
  DB_URI_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_DB_URI" --query ARN --output text)
  JWT_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_JWT" --query ARN --output text)
  TD=$(jq -n \
    --arg fam "$FAMILY" --arg exec "$EXEC_ROLE" --arg task "$TASK_ROLE" --arg cpu "$CPU" --arg mem "$MEMORY" \
    --arg proxy_name "$PROXY_CONTAINER" --arg proxy_img "$PLACEHOLDER_PROXY_IMAGE" \
    --arg pg_name "$POSTGREST_CONTAINER" --arg pg_img "$POSTGREST_IMAGE" \
    --arg lg "$LOG_GROUP" --arg region "$REGION" \
    --arg auth_host "$SUPABASE_AUTH_HOST" --arg db_host "$AURORA_HOST" \
    --arg db_uri_arn "$DB_URI_ARN" --arg jwt_arn "$JWT_ARN" \
    --argjson proxy_port "$PROXY_PORT" '{
    family:$fam, networkMode:"awsvpc", requiresCompatibilities:["FARGATE"], cpu:$cpu, memory:$mem,
    executionRoleArn:$exec, taskRoleArn:$task,
    runtimePlatform:{cpuArchitecture:"X86_64", operatingSystemFamily:"LINUX"},
    containerDefinitions:[
      {
        name:$proxy_name, image:$proxy_img, essential:true,
        portMappings:[{containerPort:$proxy_port, protocol:"tcp"}],
        environment:[{name:"SUPABASE_AUTH_HOST", value:$auth_host}],
        healthCheck:{command:["CMD-SHELL","wget -q -O- http://localhost:8080/alive || exit 1"], interval:15, timeout:5, retries:3, startPeriod:10},
        logConfiguration:{logDriver:"awslogs", options:{"awslogs-group":$lg, "awslogs-region":$region, "awslogs-stream-prefix":"proxy"}}
      },
      {
        name:$pg_name, image:$pg_img, essential:true,
        portMappings:[{containerPort:3000, protocol:"tcp"}],
        environment:[
          {name:"PGRST_DB_SCHEMA", value:"public"},
          {name:"PGRST_DB_ANON_ROLE", value:"anon"},
          {name:"PGRST_DB_USE_LEGACY_GUCS", value:"false"},
          {name:"PGRST_SERVER_PORT", value:"3000"},
          {name:"PGRST_DB_PORT", value:"5432"},
          {name:"PGRST_DB_HOST", value:$db_host},
          {name:"PGRST_DB_NAME", value:"vitana"}
        ],
        secrets:[
          {name:"PGRST_DB_URI", valueFrom:$db_uri_arn},
          {name:"PGRST_JWT_SECRET", valueFrom:$jwt_arn}
        ],
        logConfiguration:{logDriver:"awslogs", options:{"awslogs-group":$lg, "awslogs-region":$region, "awslogs-stream-prefix":"postgrest"}}
      }
    ],
    tags:[{key:"vtid", value:"VTID-04101"}, {key:"env", value:"staging"}]}')
  if [ "$APPLY" = 1 ]; then
    aws ecs register-task-definition --cli-input-json "$TD" --query taskDefinition.taskDefinitionArn --output text
  else plan "register-task-definition $FAMILY (placeholder nginx image for '$PROXY_CONTAINER'; the real image lands via CI)"; fi

  say "-- 6. ECS service $SERVICE (desiredCount 1 — Aurora's data/RLS are already correct, no bootstrap gate needed)"
  ST=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].status' --output text 2>/dev/null || echo MISSING)
  if [ "$ST" = "ACTIVE" ]; then say "   exists (ACTIVE)"
  elif [ "$APPLY" = 1 ]; then
    [ -n "$REG_ARN" ] && [ "$REG_ARN" != "None" ] || die "Cloud Map service ARN unknown; re-run provision --apply"
    aws ecs create-service --cluster "$CLUSTER" --service-name "$SERVICE" --task-definition "$FAMILY" \
      --desired-count 1 --launch-type FARGATE --platform-version LATEST \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG_SERVICES}],assignPublicIp=DISABLED}" \
      --service-registries "registryArn=$REG_ARN" \
      --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
      --propagate-tags TASK_DEFINITION --tags key=vtid,value=VTID-04101 key=env,value=staging \
      --query 'service.serviceArn' --output text
  else plan "create-service $SERVICE (FARGATE, private, Cloud Map registry, desiredCount 1)"; fi

  say ""
  say "Next: let AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml build+roll the real proxy image"
  say "      (push to main under services/postgrest-aurora-proxy/**, or dispatch it with a reason)."
  say "      Then smoke test from inside the VPC (e.g. an ecs execute-command session, or a"
  say "      throwaway task in the same SG) before anyone repoints a gateway's SUPABASE_URL:"
  say "        curl http://$DNS_SERVICE.$NAMESPACE:$PROXY_PORT/rest/v1/profiles?limit=1 -H 'apikey: <anon key>'"
}

# ----------------------------------------------------------------------------
status() {
  say "== postgrest-aurora-proxy STAGING status =="
  aws ecr describe-repositories --repository-names "$ECR_REPO" --query 'repositories[0].repositoryUri' --output text 2>/dev/null || say "ECR: missing"
  aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].{status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' --output table 2>/dev/null || say "ECS service: missing"
  for s in "$SECRET_DB_URI" "$SECRET_JWT"; do aws secretsmanager describe-secret --secret-id "$s" --query 'Name' --output text 2>/dev/null || say "secret missing: $s"; done
  NS_ID=$(aws servicediscovery list-namespaces --query "Namespaces[?Name=='$NAMESPACE'].Id" --output text)
  [ -n "$NS_ID" ] && say "namespace: $NS_ID" || say "namespace missing: $NAMESPACE"
}

case "$CMD" in
  provision) [ "${1:-}" = "--apply" ] && APPLY=1; provision;;
  status) status;;
esac

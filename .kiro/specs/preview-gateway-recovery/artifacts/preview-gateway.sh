#!/usr/bin/env bash
# preview-gateway.sh — one-time, owner-run restore of the ISOLATED staging preview gateway
# (ECS service vitana-gateway-preview behind preview-aws-gateway.vitanaland.com).
# Plan: .kiro/specs/preview-gateway-recovery/plan.md. Never touches production services.
#
#   plan     (default) read-only: build the new task definition from the LIVE one + the overlay,
#            print the env/secret diff (names only), run every refusal check. Writes nothing.
#   apply    register the task definition, add ONE listener rule at priority 8 (before the /api/* path rule
#            at 10): host == preview-aws-gateway.vitanaland.com AND path in the sparring paths only,
#            roll the service to desired 1, wait for steady state and a healthy target.
#            Existing rule 31 (host-only, priority 31) is left as it is. Every other /api path of the
#            hostname keeps going to the staging gateway target group, so the staging app, STAGING-VERIFY,
#            the deploy smoke, the crons and PUBLISH's staging build-info read never reach the isolated preview.
#   verify   read-only checks: target health, rule, /alive, deployed commit (ECS), staging token accepted
#            (JSON 404 on an unknown session = gateway -> PostgREST -> Aurora read), production key rejected,
#            no token rejected, allocator status disabled.
#   rollback service back on the recorded task definition and desired count; the added rule deleted.
#
# Usage: preview-gateway.sh <plan|apply|verify|rollback> --commit <40-char sha on origin/main>
#        [--repo <vitana-platform checkout>] [--state ./preview-gateway-state.json]
# Requires: aws CLI v2, jq, git, curl. Account 472838866351, region eu-central-1 only.
# Secret VALUES are never printed; only the preview token is read, by verify, into a variable.
set -euo pipefail

ACCOUNT=472838866351
REGION=eu-central-1
CLUSTER=Vitana-ECS-Cluster
SERVICE=vitana-gateway-preview
TG_NAME=vitana-tg-gateway-preview
ALB_NAME=vitana-alb-prod
HOST=preview-aws-gateway.vitanaland.com
NEW_PRIORITY=8             # must be < 10: path rules (/api/*, /ws/*) sit at 10 (infrastructure.md §1b)
SPAR_PATHS='["/api/v1/plans/spar","/api/v1/plans/spar/*","/api/v1/vtid/allocator/status"]' 
PROXY_SERVICE=vitana-postgrest-aurora-proxy
PROXY_FAMILY=vitana-postgrest-aurora-staging
ECR_REPO=vitana/gateway
HERE="$(cd "$(dirname "$0")" && pwd)"
OVERLAY="$HERE/preview-taskdef-overlay.json"

CMD="${1:-plan}"; shift || true
COMMIT=""; REPO="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || pwd)"; STATE="./preview-gateway-state.json"
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --state) STATE="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

die() { echo "REFUSED: $*" >&2; exit 1; }
say() { echo "== $*"; }

# --- guards common to every command -------------------------------------------------------
[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || die "wrong AWS account"
command -v jq >/dev/null || die "jq missing"

listener_arn() {
  local alb; alb=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  aws elbv2 describe-listeners --load-balancer-arn "$alb" --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text
}
spar_rule() {  # prints "<ruleArn> <priority>" of the rule host == $HOST AND path == $SPAR_PATHS, or NONE
  aws elbv2 describe-rules --listener-arn "$(listener_arn)" --output json \
    | jq -r --arg h "$HOST" --argjson p "$SPAR_PATHS" '[.Rules[] | select(.Conditions|length==2)
        | select(any(.Conditions[]; .Field=="host-header" and .HostHeaderConfig.Values==[$h]))
        | select(any(.Conditions[]; .Field=="path-pattern" and (.PathPatternConfig.Values|sort)==($p|sort)))]
        | if length==1 then "\(.[0].RuleArn) \(.[0].Priority)" else "NONE" end'
}
priority_taken() { [ -n "$(aws elbv2 describe-rules --listener-arn "$(listener_arn)" --query "Rules[?Priority=='$1'].RuleArn" --output text)" ]; }
tg_arn() { aws elbv2 describe-target-groups --names "$TG_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text; }

build_taskdef() {  # stdout: register-task-definition JSON
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--commit must be a full 40-char sha"
  git -C "$REPO" fetch -q origin main
  git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main || die "$COMMIT is not on origin/main"
  git -C "$REPO" cat-file -e "$COMMIT:services/gateway/src/runtime/runtime-profile.ts" 2>/dev/null \
    || die "$COMMIT has no GATEWAY_RUNTIME_PROFILE (PR #5110 not merged): background jobs could not be disabled"
  local tag="${COMMIT:0:12}"
  aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$tag" >/dev/null 2>&1 \
    || die "image $ECR_REPO:$tag not in ECR (the staging build of that commit must exist)"
  local image="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO:$tag"

  local live; live=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
  [ "$live" != "None" ] || die "service $SERVICE not found"
  local task_role exec_role
  task_role=$(aws iam get-role --role-name "$(jq -r .task_role "$OVERLAY")" --query Role.Arn --output text) || die "task role missing"
  exec_role=$(aws iam get-role --role-name "$(jq -r .execution_role "$OVERLAY")" --query Role.Arn --output text) || die "execution role missing"

  # resolve every secret NAME to its full ARN (describe only; values are never read)
  local secmap='{}' name ref arn
  for name in $(jq -r '.secrets_set | keys[]' "$OVERLAY"); do
    ref=$(jq -r --arg n "$name" '.secrets_set[$n]' "$OVERLAY")
    arn=$(aws secretsmanager describe-secret --secret-id "$ref" --query ARN --output text 2>/dev/null) || die "secret $ref does not exist (run setup-preview-secrets.sh first)"
    secmap=$(jq -c --arg n "$name" --arg a "$arn" '. + {($n): $a}' <<<"$secmap")
  done

  aws ecs describe-task-definition --task-definition "$live" --query taskDefinition \
  | jq --slurpfile O "$OVERLAY" --argjson S "$secmap" --arg IMG "$image" --arg SHA "$COMMIT" \
       --arg TR "$task_role" --arg ER "$exec_role" '
      ($O[0]) as $o
      | .taskRoleArn = $TR | .executionRoleArn = $ER
      | .containerDefinitions[0].image = $IMG
      | .containerDefinitions[0].environment |=
          ( [ .[] | select(.name as $n | ($o.env_remove | index($n) | not) and ($o.env_set | has($n) | not)
                     and ($n | IN("GIT_COMMIT_SHA","COMMIT_SHA","BUILD_INFO_MARKER") | not)) ]
            + [ $o.env_set | to_entries[] | {name:.key, value:(if .value=="@task_role_arn" then $TR else .value end)} ]
            + [ {name:"GIT_COMMIT_SHA", value:$SHA}, {name:"COMMIT_SHA", value:$SHA}, {name:"BUILD_INFO_MARKER", value:$SHA[0:12]} ] )
      | .containerDefinitions[0].secrets = [ $S | to_entries[] | {name:.key, valueFrom:.value} ]
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
            .registeredAt, .registeredBy, .deregisteredAt)'
}

check_taskdef() {  # stdin: task definition JSON; refuses anything production-shaped
  local td; td=$(cat)
  local pat bad
  pat=$(jq -r '.refuse_if_any_value_matches | join("|")' "$OVERLAY")
  bad=$(jq -r --arg p "$pat" '[ .containerDefinitions[] | ((.environment//[])[] | "\(.name)=\(.value)"), ((.secrets//[])[] | "\(.name)<-\(.valueFrom)") ]
          | map(select(test($p))) | .[]' <<<"$td")
  [ -z "$bad" ] || die "production-shaped binding(s): $(echo "$bad" | sed -E 's/=.{40,}/=<long value>/' | tr '\n' ' ')"
  for n in $(jq -r '.refuse_names_present[]' "$OVERLAY"); do
    jq -e --arg n "$n" '[.containerDefinitions[] | ((.environment//[])[], (.secrets//[])[]) | .name] | index($n)' <<<"$td" >/dev/null \
      && die "$n must not be bound on the preview"
  done
  jq -e '[.containerDefinitions[0].environment[] | select(.name=="GATEWAY_RUNTIME_PROFILE" and .value=="preview-sparring")] | length==1' <<<"$td" >/dev/null \
    || die "GATEWAY_RUNTIME_PROFILE=preview-sparring missing"
  jq -e '[.containerDefinitions[0].environment[] | select(.name=="VTID_ALLOCATOR_ENABLED" and .value=="false")] | length==1' <<<"$td" >/dev/null \
    || die "VTID_ALLOCATOR_ENABLED must be false"
  jq -e '.containerDefinitions | length==1' <<<"$td" >/dev/null || die "expected exactly one container"
  printf '%s' "$td"
}

proxy_check() {
  local td; td=$(aws ecs describe-services --cluster "$CLUSTER" --services "$PROXY_SERVICE" --query 'services[0].[taskDefinition,runningCount]' --output text)
  say "PostgREST proxy: $td"
  case "$td" in *"$PROXY_FAMILY:"*) ;; *) die "proxy is not on family $PROXY_FAMILY";; esac
  [ "$(awk '{print $2}' <<<"$td")" -ge 1 ] || die "proxy has no running task"
}

case "$CMD" in
  plan)
    proxy_check
    NEW=$(build_taskdef | check_taskdef)
    LIVE=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
    say "live task definition: $LIVE"
    say "env names added/changed:"; diff <(aws ecs describe-task-definition --task-definition "$LIVE" --query 'taskDefinition.containerDefinitions[0].environment' --output json | jq -r '.[] | "\(.name)=\(.value)"' | sort) \
                                       <(jq -r '.containerDefinitions[0].environment[] | "\(.name)=\(.value)"' <<<"$NEW" | sort) \
                                  | sed -E 's/^([<>] [A-Z0-9_]+)=.*/\1/' | grep -E '^[<>]' || true
    say "secrets (name <- secret name):"; jq -r '.containerDefinitions[0].secrets[] | "  \(.name) <- \(.valueFrom | sub(".*:secret:";"") )"' <<<"$NEW"
    say "roles: $(jq -r '.taskRoleArn + "  /  " + .executionRoleArn' <<<"$NEW")"
    read -r RULE PRIO <<<"$(spar_rule)"
    if [ "$RULE" = NONE ]; then
      priority_taken "$NEW_PRIORITY" && die "priority $NEW_PRIORITY is taken"
      say "will add rule priority $NEW_PRIORITY: host $HOST AND path in $SPAR_PATHS -> $TG_NAME (rule 31 unchanged)"
    else say "sparring rule already present at priority $PRIO"; fi
    say "plan OK — nothing written";;

  apply)
    [ ! -e "$STATE" ] || die "$STATE exists: an apply was already recorded (rollback first, or move it)"
    proxy_check
    NEW=$(build_taskdef | check_taskdef)
    read -r RULE PRIO <<<"$(spar_rule)"; [ "$RULE" = NONE ] || die "a sparring rule already exists ($RULE)"
    priority_taken "$NEW_PRIORITY" && die "priority $NEW_PRIORITY is taken"
    read -r PREV_TD PREV_DESIRED <<<"$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].[taskDefinition,desiredCount]' --output text)"
    jq -n --arg td "$PREV_TD" --arg d "$PREV_DESIRED" --arg c "$COMMIT" --arg at "$(date -u +%FT%TZ)" \
      '{prev_task_definition:$td, prev_desired:($d|tonumber), commit:$c, started_at:$at}' > "$STATE"
    NEW_ARN=$(aws ecs register-task-definition --cli-input-json "$NEW" --query taskDefinition.taskDefinitionArn --output text)
    jq --arg a "$NEW_ARN" '. + {new_task_definition:$a}' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    say "registered $NEW_ARN"
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW_ARN" --desired-count 1 >/dev/null
    say "waiting for steady state…"
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
    for i in $(seq 1 20); do
      H=$(aws elbv2 describe-target-health --target-group-arn "$(tg_arn)" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text)
      [ "$H" = healthy ] && break; sleep 15
    done
    [ "$H" = healthy ] || die "target not healthy ($H) — run: $0 rollback --state $STATE"
    # the route is added only once the target is healthy, so sparring never sees a half-started preview
    RULE=$(aws elbv2 create-rule --listener-arn "$(listener_arn)" --priority "$NEW_PRIORITY" \
      --conditions "$(jq -nc --arg h "$HOST" --argjson p "$SPAR_PATHS" '[{Field:"host-header",HostHeaderConfig:{Values:[$h]}},{Field:"path-pattern",PathPatternConfig:{Values:$p}}]')" \
      --actions "Type=forward,TargetGroupArn=$(tg_arn)" --tags Key=Environment,Value=staging Key=Purpose,Value=preview-sparring \
      --query 'Rules[0].RuleArn' --output text)
    jq --arg r "$RULE" '. + {added_rule_arn:$r}' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    say "rule $RULE added at priority $NEW_PRIORITY"
    say "apply OK — target healthy; next: $0 verify --commit $COMMIT";;

  verify)
    TGH=$(aws elbv2 describe-target-health --target-group-arn "$(tg_arn)" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text)
    say "target health: $TGH"; [ "$TGH" = healthy ] || die "target not healthy"
    read -r RULE PRIO <<<"$(spar_rule)"; [ "$RULE" != NONE ] && [ "$PRIO" -lt 10 ] || die "sparring rule missing or not before priority 10"
    say "sparring rule at priority $PRIO"
    TD=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
    LIVE_SHA=$(aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[0].environment[?name=='GIT_COMMIT_SHA'].value | [0]" --output text)
    say "deployed commit (ECS): $LIVE_SHA"; [ -z "$COMMIT" ] || [ "$LIVE_SHA" = "$COMMIT" ] || die "running $LIVE_SHA, expected $COMMIT"
    curl -fsS -m 20 -o /dev/null -w "alive: %{http_code} %{content_type}\n" "https://$HOST/alive"
    probe() { # probe <label> <expected http code> [token secret id]; prints code and JSON error only
      local tok="" code
      [ -n "${3:-}" ] && tok=$(aws secretsmanager get-secret-value --secret-id "$3" --query SecretString --output text)
      code=$(curl -sS -m 30 -o /tmp/pg-verify.json -w '%{http_code} %{content_type}' ${tok:+-H "Authorization: Bearer $tok"} \
        "https://$HOST/api/v1/plans/spar/00000000-0000-0000-0000-000000000000")
      tok=""
      echo "$1: $code $(jq -c '{ok,error}' /tmp/pg-verify.json 2>/dev/null)"
      case "$code" in "$2 application/json"*) ;; *) die "$1: expected $2 JSON";; esac
    }
    probe "staging preview token (gateway -> PostgREST -> Aurora staging read)" 404 vitana/gateway/staging/preview-sparring-token
    probe "production service-role key is rejected" 401 vitana/supabase/prod/service-role-key
    probe "no token is rejected" 401
    curl -fsS -m 20 "https://$HOST/api/v1/vtid/allocator/status" | jq -c '.' | tee /tmp/pg-alloc.json
    # routes/vtid.ts:437: {ok, enabled, env_var_enabled, db_control}
    jq -e '.ok == true and .enabled == false and .env_var_enabled == false and .db_control == null' /tmp/pg-alloc.json >/dev/null \
      || die "allocator status does not report disabled"
    say "verify done (sparring end-to-end is proven by a PLAN-SPAR run, not here)";;

  rollback)
    [ -f "$STATE" ] || die "no state file $STATE"
    PREV_TD=$(jq -r .prev_task_definition "$STATE"); PREV_DESIRED=$(jq -r .prev_desired "$STATE")
    RULE=$(jq -r '.added_rule_arn // empty' "$STATE")
    [ -z "$RULE" ] || { aws elbv2 delete-rule --rule-arn "$RULE"; say "deleted rule $RULE"; }
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$PREV_TD" --desired-count "$PREV_DESIRED" >/dev/null
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
    say "rolled back: $SERVICE on $PREV_TD at desired $PREV_DESIRED; sparring rule removed (rule 31 was never changed)"
    say "the registered revision $(jq -r '.new_task_definition // "n/a"' "$STATE") stays registered (inactive); deregister it if wanted"
    mv "$STATE" "$STATE.rolled-back.$(date -u +%Y%m%dT%H%M%SZ)";;

  *) echo "usage: $0 <plan|apply|verify|rollback> --commit <sha>" >&2; exit 2;;
esac

#!/usr/bin/env bash
# preview-gateway.sh — one-time, owner-run restore of the ISOLATED staging preview gateway
# (ECS service vitana-gateway-preview behind preview-aws-gateway.vitanaland.com).
# Plan: .kiro/specs/preview-gateway-recovery/plan.md. Never touches production services.
#
#   plan     (default) read-only: build the new task definition from the LIVE one + the overlay,
#            print the env/secret diff (names only), run every refusal check. Writes nothing.
#   apply    register the task definition, move the preview host rule below priority 10,
#            roll the service to desired 1, wait for steady state and a healthy target.
#   verify   read-only checks: target health, /alive, build-info, authenticated sparring read,
#            allocator status (expects disabled).
#   rollback put the service back on the recorded task definition and desired count, and the
#            rule back on its recorded priority (state file from apply).
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
host_rule() {  # prints "<ruleArn> <priority>" of the rule whose ONLY condition is host-header == $HOST
  aws elbv2 describe-rules --listener-arn "$(listener_arn)" --output json \
    | jq -r --arg h "$HOST" '[.Rules[] | select(.Conditions|length==1)
        | select(.Conditions[0].Field=="host-header" and (.Conditions[0].HostHeaderConfig.Values==[$h]))]
        | if length==1 then "\(.[0].RuleArn) \(.[0].Priority)" else "NONE" end'
}
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
    read -r RULE PRIO <<<"$(host_rule)"; [ "$RULE" != NONE ] || die "no single host-header rule for $HOST"
    say "host rule $HOST: priority $PRIO -> $NEW_PRIORITY (taken: $(aws elbv2 describe-rules --listener-arn "$(listener_arn)" --query "Rules[?Priority=='$NEW_PRIORITY'].RuleArn" --output text | wc -w))"
    say "plan OK — nothing written";;

  apply)
    [ ! -e "$STATE" ] || die "$STATE exists: an apply was already recorded (rollback first, or move it)"
    proxy_check
    NEW=$(build_taskdef | check_taskdef)
    read -r RULE PRIO <<<"$(host_rule)"; [ "$RULE" != NONE ] || die "no single host-header rule for $HOST"
    [ -z "$(aws elbv2 describe-rules --listener-arn "$(listener_arn)" --query "Rules[?Priority=='$NEW_PRIORITY'].RuleArn" --output text)" ] \
      || [ "$PRIO" = "$NEW_PRIORITY" ] || die "priority $NEW_PRIORITY is taken"
    read -r PREV_TD PREV_DESIRED <<<"$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].[taskDefinition,desiredCount]' --output text)"
    jq -n --arg td "$PREV_TD" --arg d "$PREV_DESIRED" --arg r "$RULE" --arg p "$PRIO" --arg c "$COMMIT" --arg at "$(date -u +%FT%TZ)" \
      '{prev_task_definition:$td, prev_desired:($d|tonumber), rule_arn:$r, prev_priority:($p|tonumber), commit:$c, started_at:$at}' > "$STATE"
    NEW_ARN=$(aws ecs register-task-definition --cli-input-json "$NEW" --query taskDefinition.taskDefinitionArn --output text)
    jq --arg a "$NEW_ARN" '. + {new_task_definition:$a}' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    say "registered $NEW_ARN"
    [ "$PRIO" = "$NEW_PRIORITY" ] || aws elbv2 set-rule-priorities --rule-priorities "RuleArn=$RULE,Priority=$NEW_PRIORITY" >/dev/null
    say "host rule now at priority $NEW_PRIORITY"
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW_ARN" --desired-count 1 >/dev/null
    say "waiting for steady state…"
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
    for i in $(seq 1 20); do
      H=$(aws elbv2 describe-target-health --target-group-arn "$(tg_arn)" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text)
      [ "$H" = healthy ] && break; sleep 15
    done
    [ "$H" = healthy ] || die "target not healthy ($H) — run: $0 rollback --state $STATE"
    say "apply OK — target healthy; next: $0 verify --commit $COMMIT";;

  verify)
    say "target health: $(aws elbv2 describe-target-health --target-group-arn "$(tg_arn)" --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output text | tr '\n' ' ')"
    read -r RULE PRIO <<<"$(host_rule)"; say "host rule priority: $PRIO (must be < 10)"; [ "$PRIO" -lt 10 ] || die "rule still behind the /api/* path rule"
    curl -fsS -m 20 -o /dev/null -w "alive: %{http_code} %{content_type}\n" "https://$HOST/alive"
    curl -fsS -m 20 "https://$HOST/api/v1/admin/build-info" | jq -c '{commit: (.commit // .git_commit // .sha), env: (.env // .environment)}'
    TOKEN=$(aws secretsmanager get-secret-value --secret-id vitana/gateway/staging/preview-sparring-token --query SecretString --output text)
    # authenticated read through gateway -> PostgREST rev N -> Aurora staging: an unknown session id must be a JSON 404,
    # not 401 (auth) and not 5xx (database).
    CODE=$(curl -sS -m 30 -o /tmp/pg-verify.json -w '%{http_code} %{content_type}' -H "Authorization: Bearer $TOKEN" \
      "https://$HOST/api/v1/plans/spar/00000000-0000-0000-0000-000000000000")
    unset TOKEN
    echo "authenticated sparring read: $CODE $(head -c 200 /tmp/pg-verify.json)"
    case "$CODE" in 404\ application/json*) ;; *) die "expected a JSON 404";; esac
    curl -fsS -m 20 "https://$HOST/api/v1/vtid/allocator/status" | jq -c '.'
    say "verify done (sparring end-to-end is proven by a PLAN-SPAR run, not here)";;

  rollback)
    [ -f "$STATE" ] || die "no state file $STATE"
    PREV_TD=$(jq -r .prev_task_definition "$STATE"); PREV_DESIRED=$(jq -r .prev_desired "$STATE")
    RULE=$(jq -r .rule_arn "$STATE"); PREV_PRIO=$(jq -r .prev_priority "$STATE")
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$PREV_TD" --desired-count "$PREV_DESIRED" >/dev/null
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
    aws elbv2 set-rule-priorities --rule-priorities "RuleArn=$RULE,Priority=$PREV_PRIO" >/dev/null
    say "rolled back: $SERVICE on $PREV_TD at desired $PREV_DESIRED; host rule at priority $PREV_PRIO"
    say "the registered revision $(jq -r '.new_task_definition // "n/a"' "$STATE") stays registered (inactive); deregister it if wanted"
    mv "$STATE" "$STATE.rolled-back.$(date -u +%Y%m%dT%H%M%SZ)";;

  *) echo "usage: $0 <plan|apply|verify|rollback> --commit <sha>" >&2; exit 2;;
esac

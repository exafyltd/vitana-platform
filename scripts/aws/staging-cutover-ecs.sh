#!/usr/bin/env bash
# VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover; design.md §8): the ECS side of the staging data-plane
# rehearsal and flip. Every ECS write goes through ecs_write(), which refuses any cluster but Vitana-ECS-Cluster and any
# service outside the allow list of the subcommand. A production service (*-awsdr, *prod*) is refused before any call.
#
# Live staging services (flip / rollback / verify only):  vitana-gateway, vitana-postgrest-aurora-proxy
# Candidate services (rehearsal only):                     vitana-gateway-iso, vitana-postgrest-aurora-staging-iso
#
#   record             --out <file>                      PRIMARY task definition + network configuration of both live services
#   flip               --record <file> --client-sg <sg>  isolated revisions of the recorded task definitions; both live
#                      [--out <file>]                    services rolled to them with the database client SG added
#   rollback           --record <file>                   both live services back to the recorded revision and network
#   verify             --record <file> [--flipped <file>] PRIMARY = recorded (or flipped) revision, rolloutState COMPLETED
#   candidate-register --candidate-url <url> --out <file> -iso revisions from the live PRIMARY task definitions (no service change)
#   candidate-start    --registered <file>               both -iso services on those revisions, desired count 1, stable
#   candidate-stop                                       both -iso services to desired count 0, stable (always run)
#   guard              <service> live|candidate|list <names>  the name check alone
#
# Needs: aws CLI v2, jq, node. STAGING_CUTOVER_APPROVED=yes for flip (passed to staging-cutover-select.sh).
# Exit: 0 ok, 1 AWS/ECS failure, 2 refused.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER="Vitana-ECS-Cluster"
REGION="eu-central-1"
ACCOUNT="472838866351"
LIVE_GATEWAY="vitana-gateway"
LIVE_PROXY="vitana-postgrest-aurora-proxy"
ISO_GATEWAY="vitana-gateway-iso"
ISO_PROXY="vitana-postgrest-aurora-staging-iso"
WAIT_TIMEOUT_S="${CUTOVER_WAIT_TIMEOUT_S:-900}"

die() { echo "::error::staging-cutover-ecs: $*" >&2; exit 2; }
fail() { echo "::error::staging-cutover-ecs: $*" >&2; exit 1; }
say() { echo "staging-cutover-ecs: $*" >&2; }
aws() { command aws --region "$REGION" "$@"; }

# Name guard: $1 = service, $2 = allowed list (space separated). Production-looking names are refused first.
guard_service() {
  case "$1" in *awsdr*|*prod*|*Prod*|*PROD*) die "refusing production-looking service '$1'" ;; esac
  case " $2 " in *" $1 "*) ;; *) die "service '$1' is not allowed here (allowed: $2)" ;; esac
}
guard_cluster() { [ "$1" = "$CLUSTER" ] || die "refusing cluster '$1' (only $CLUSTER)"; }

# The only ECS writer. $1 = allowed list, then: update-service|register-task-definition args...
ecs_write() {
  local allowed="$1"; shift
  local op="$1"; shift
  case "$op" in
    update-service)
      local c="" s="" a=("$@") i
      for ((i = 0; i < ${#a[@]}; i++)); do
        [ "${a[$i]}" = --cluster ] && c="${a[$((i + 1))]}"
        [ "${a[$i]}" = --service ] && s="${a[$((i + 1))]}"
      done
      guard_cluster "$c"; guard_service "$s" "$allowed"
      aws ecs update-service "$@" >/dev/null ;;
    register-task-definition) aws ecs register-task-definition "$@" ;;
    *) die "ecs_write: unknown operation $op" ;;
  esac
}

check_account() {
  local acct
  acct=$(aws sts get-caller-identity --query Account --output text) || fail "cannot read the caller identity"
  [ "$acct" = "$ACCOUNT" ] || die "wrong AWS account '$acct' (want $ACCOUNT)"
}

describe() { aws ecs describe-services --cluster "$CLUSTER" --services "$1" --output json; }

primary_td() { # service -> PRIMARY task-definition ARN, refusing anything but one PRIMARY deployment
  local j n
  j=$(describe "$1") || fail "describe-services $1 failed"
  [ "$(jq -r '.services[0].status // "MISSING"' <<<"$j")" = ACTIVE ] || fail "service $1 is not ACTIVE in $CLUSTER"
  n=$(jq '[.services[0].deployments[] | select(.status == "PRIMARY")] | length' <<<"$j")
  [ "$n" = 1 ] || fail "service $1 has $n PRIMARY deployments"
  jq -r '.services[0].deployments[] | select(.status == "PRIMARY") | .taskDefinition' <<<"$j"
}

wait_stable() { # service... ; bounded wait for one COMPLETED deployment with running = desired
  local deadline=$(( $(date +%s) + WAIT_TIMEOUT_S )) s j
  for s in "$@"; do
    while :; do
      j=$(describe "$s") || fail "describe-services $s failed"
      if [ "$(jq -r '[.services[0].deployments[]] | length' <<<"$j")" = 1 ] \
         && [ "$(jq -r '.services[0].deployments[0].rolloutState // ""' <<<"$j")" = COMPLETED ] \
         && [ "$(jq -r '.services[0].runningCount' <<<"$j")" = "$(jq -r '.services[0].desiredCount' <<<"$j")" ]; then break; fi
      [ "$(date +%s)" -lt "$deadline" ] || fail "service $s did not stabilize within ${WAIT_TIMEOUT_S}s"
      sleep "${CUTOVER_POLL_S:-15}"
    done
    say "$s stable"
  done
}

register_from() { # $1 td arn, $2 service key (gateway|postgrest), then extra select args -> new ARN
  local td="$1" svc="$2"; shift 2
  local def new
  def=$(aws ecs describe-task-definition --task-definition "$td" --query taskDefinition --output json \
        | jq -c 'del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)') \
        || fail "describe-task-definition $td failed"
  new=$(printf '%s' "$def" | STAGING_DATA_PLANE=isolated bash "$here/staging-cutover-select.sh" --service "$svc" "$@") || die "isolated switch refused for $td"
  ecs_write "" register-task-definition --cli-input-json "$new" --query taskDefinition.taskDefinitionArn --output text \
    || fail "register-task-definition failed for $svc"
}

cmd="${1:-}"; shift || true
if [ "$cmd" = guard ]; then # the name check alone (tests)
  case "${2:-}" in
    live) guard_service "${1:-}" "$LIVE_GATEWAY $LIVE_PROXY" ;;
    candidate) guard_service "${1:-}" "$ISO_GATEWAY $ISO_PROXY" ;;
    list) guard_service "${1:-}" "${3:-}" ;; # the production-name refusal holds even for a name put on a list
    *) die "guard <service> live|candidate|list <names>" ;;
  esac
  exit 0
fi
out=""; record=""; flipped=""; client_sg=""; candidate_url=""; registered=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:-}"; shift 2 ;;
    --record) record="${2:-}"; shift 2 ;;
    --flipped) flipped="${2:-}"; shift 2 ;;
    --client-sg) client_sg="${2:-}"; shift 2 ;;
    --candidate-url) candidate_url="${2:-}"; shift 2 ;;
    --registered) registered="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
read_record() {
  [ -n "$record" ] && [ -f "$record" ] || die "--record <file> is required"
  jq -e --arg c "$CLUSTER" '.cluster == $c and (.services | length == 2)' "$record" >/dev/null || die "record $record is not a cutover record"
}
recorded() { jq -r --arg s "$2" '.services[] | select(.service == $s) | .'"$3" "$1"; } # file service field

case "$cmd" in
  record)
    [ -n "$out" ] || die "--out is required"
    check_account
    jq -n --arg c "$CLUSTER" '{cluster:$c, recorded_at:(now|todate), services:[]}' > "$out"
    for s in "$LIVE_PROXY" "$LIVE_GATEWAY"; do
      guard_service "$s" "$LIVE_GATEWAY $LIVE_PROXY"
      td=$(primary_td "$s")
      net=$(describe "$s" | jq -c '.services[0].networkConfiguration')
      [ "$net" != null ] || fail "service $s has no networkConfiguration"
      jq --arg s "$s" --arg td "$td" --argjson net "$net" '.services += [{service:$s, taskDefinition:$td, networkConfiguration:$net}]' "$out" > "$out.tmp" && mv "$out.tmp" "$out"
      say "recorded $s -> $td"
    done ;;

  flip)
    read_record
    printf '%s' "$client_sg" | grep -Eq '^sg-[0-9a-f]{8,17}$' || die "--client-sg must be a security group id"
    [ "${STAGING_CUTOVER_APPROVED:-}" = yes ] || die "STAGING_CUTOVER_APPROVED is not 'yes'"
    check_account
    [ -n "$out" ] || out="$record.flipped.json"
    echo '{"services":[]}' > "$out"
    for s in "$LIVE_PROXY" "$LIVE_GATEWAY"; do
      guard_service "$s" "$LIVE_GATEWAY $LIVE_PROXY"
      td=$(recorded "$record" "$s" taskDefinition)
      [ -n "$td" ] || die "no recorded revision for $s"
      [ "$(primary_td "$s")" = "$td" ] || fail "$s moved since it was recorded; record again"
      key=gateway; [ "$s" = "$LIVE_PROXY" ] && key=postgrest
      new=$(register_from "$td" "$key")
      net=$(jq -c --arg s "$s" --arg sg "$client_sg" '.services[] | select(.service == $s) | .networkConfiguration
            | .awsvpcConfiguration.securityGroups = ((.awsvpcConfiguration.securityGroups + [$sg]) | unique)' "$record")
      ecs_write "$LIVE_GATEWAY $LIVE_PROXY" update-service --cluster "$CLUSTER" --service "$s" --task-definition "$new" --network-configuration "$net"
      jq --arg s "$s" --arg td "$new" '.services += [{service:$s, taskDefinition:$td}]' "$out" > "$out.tmp" && mv "$out.tmp" "$out"
      say "flipped $s -> $new"
      wait_stable "$s"
    done ;;

  rollback)
    read_record
    check_account
    for s in "$LIVE_GATEWAY" "$LIVE_PROXY"; do
      guard_service "$s" "$LIVE_GATEWAY $LIVE_PROXY"
      td=$(recorded "$record" "$s" taskDefinition)
      net=$(jq -c --arg s "$s" '.services[] | select(.service == $s) | .networkConfiguration' "$record")
      [ -n "$td" ] && [ "$net" != null ] || die "record has no revision/network for $s"
      ecs_write "$LIVE_GATEWAY $LIVE_PROXY" update-service --cluster "$CLUSTER" --service "$s" --task-definition "$td" --network-configuration "$net"
      say "rolling $s back to $td"
    done
    wait_stable "$LIVE_GATEWAY" "$LIVE_PROXY"
    bash "$0" verify --record "$record" ;;

  verify)
    read_record
    for s in "$LIVE_GATEWAY" "$LIVE_PROXY"; do
      want=$(recorded "${flipped:-$record}" "$s" taskDefinition)
      got=$(primary_td "$s")
      [ "$got" = "$want" ] || fail "$s PRIMARY is $got, expected $want"
      [ "$(describe "$s" | jq -r '.services[0].deployments[] | select(.status == "PRIMARY") | .rolloutState')" = COMPLETED ] || fail "$s rollout not COMPLETED"
      say "verified $s on $want"
    done ;;

  candidate-register)
    [ -n "$out" ] && [ -n "$candidate_url" ] || die "--candidate-url and --out are required"
    printf '%s' "$candidate_url" | grep -Eq '^https://preview-iso-[a-z0-9.-]+$' || die "candidate URL must be https://preview-iso-…"
    check_account
    echo '{"services":[]}' > "$out"
    for pair in "$LIVE_PROXY:$ISO_PROXY:postgrest" "$LIVE_GATEWAY:$ISO_GATEWAY:gateway"; do
      IFS=: read -r live iso key <<<"$pair"
      guard_service "$live" "$LIVE_GATEWAY $LIVE_PROXY"; guard_service "$iso" "$ISO_GATEWAY $ISO_PROXY"
      new=$(register_from "$(primary_td "$live")" "$key" --candidate-url "$candidate_url")
      case "$new" in *":task-definition/$iso:"*) ;; *) fail "registered $new is not of family $iso" ;; esac
      jq --arg s "$iso" --arg td "$new" '.services += [{service:$s, taskDefinition:$td}]' "$out" > "$out.tmp" && mv "$out.tmp" "$out"
      say "registered candidate $iso -> $new (no service changed)"
    done ;;

  candidate-start)
    [ -n "$registered" ] && [ -f "$registered" ] || die "--registered <file> is required"
    check_account
    for s in "$ISO_PROXY" "$ISO_GATEWAY"; do
      td=$(recorded "$registered" "$s" taskDefinition)
      case "$td" in *":task-definition/$s:"*) ;; *) die "registered revision for $s is '$td'" ;; esac
      ecs_write "$ISO_GATEWAY $ISO_PROXY" update-service --cluster "$CLUSTER" --service "$s" --task-definition "$td" --desired-count 1
      wait_stable "$s"
    done ;;

  candidate-stop)
    check_account
    rc=0
    for s in "$ISO_GATEWAY" "$ISO_PROXY"; do
      ecs_write "$ISO_GATEWAY $ISO_PROXY" update-service --cluster "$CLUSTER" --service "$s" --desired-count 0 || rc=1
    done
    wait_stable "$ISO_GATEWAY" "$ISO_PROXY"
    exit "$rc" ;;

  *) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

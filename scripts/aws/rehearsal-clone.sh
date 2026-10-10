#!/usr/bin/env bash
# VTID-05023 part 10 — the Aurora clone the staging rehearsal runs against.
#
#   rehearsal-clone.sh create [--dry-run] [--logical-replication]
#   rehearsal-clone.sh delete [--dry-run] [--identifier ID]
#   rehearsal-clone.sh status [--identifier ID]
#   rehearsal-clone.sh sql FILE [--dry-run]
#   rehearsal-clone.sh guard-check <service> <operation> [args...]   (test hook, no AWS call)
#
# create  copy-on-write clone of vitana-aurora-prod (latest restorable time) as
#         vitana-aurora-rehearsal: same subnet group, security groups and KMS key
#         as the source (read with describe-db-clusters), its OWN cluster
#         parameter group (a copy of the source's, so nothing done for the
#         rehearsal ever touches the production group), one writer instance of the
#         source writer's class and instance parameter group, Data API on, an
#         RDS-managed master secret of its own, deletion protection off. Waits
#         until the cluster and the writer are available. Re-running on an
#         existing clone changes nothing.
#         --logical-replication sets rds.logical_replication=1 in the clone's own
#         parameter group before the writer boots (part 7a / 12(i) rehearsal).
# delete  deletes the clone's instances, the clone (--skip-final-snapshot) and
#         its parameter group. Refuses any identifier other than exactly
#         vitana-aurora-rehearsal, and a cluster without the rehearsal tag.
# status  read-only describe.
# sql     runs a one-statement-per-line SQL file against the CLONE through the
#         Data API with the clone's own master secret (same contract as
#         aurora-run-sql.sh, which is hard-wired to vitana-aurora-prod).
#
# HARD GUARD: every mutating AWS call goes through mut(), which refuses unless
# the call is on an allowlist and every target argument names the rehearsal
# clone. The production cluster/writer/parameter group may appear ONLY as the
# --source-* argument of the restore and of the parameter-group copy. Tested by
# scripts/aws/test/rehearsal-clone.sh with a fake `aws` on PATH.
#
# Account/region guarded (472838866351 / eu-central-1). --dry-run prints every
# mutating call instead of running it; read-only describes still run.
set -euo pipefail
export AWS_PAGER=""

REGION=eu-central-1
ACCOUNT=472838866351
SOURCE_ID=vitana-aurora-prod
CLONE_ID=vitana-aurora-rehearsal
CLONE_WRITER=vitana-aurora-rehearsal-writer
CLONE_PG=vitana-aurora-rehearsal-cluster-params
TAG_KEY=Purpose
TAG_VALUE=vtid-05023-part10-rehearsal
CLONE_ARN="arn:aws:rds:$REGION:$ACCOUNT:cluster:$CLONE_ID"

die() { echo "rehearsal-clone: $*" >&2; exit 2; }
refuse() { echo "rehearsal-clone: REFUSED: $*" >&2; exit 3; }

ACTION="${1:-}"; [ -n "$ACTION" ] || die "usage: $0 create|delete|status|sql FILE [--dry-run] [--identifier ID] [--logical-replication]"
shift
SQL_FILE=""; GUARD_ARGS=()
if [ "$ACTION" = guard-check ]; then GUARD_ARGS=("$@"); set --; fi
if [ "$ACTION" = sql ]; then SQL_FILE="${1:-}"; [ -n "$SQL_FILE" ] || die "sql needs a file"; shift; fi
DRY_RUN=false; IDENT="$CLONE_ID"; LOGICAL_REPLICATION=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --identifier) IDENT="${2:-}"; shift 2 ;;
    --logical-replication) LOGICAL_REPLICATION=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

# The identifier is fixed. The option exists so a mistyped or malicious value is
# refused loudly instead of being silently replaced.
[ "$IDENT" = "$CLONE_ID" ] || refuse "identifier '$IDENT' is not exactly '$CLONE_ID' (the only cluster this script may create, change or delete)"
case "$ACTION" in create|delete|status|sql|guard-check) ;; *) die "unknown action: $ACTION" ;; esac

# ── mutation guard ────────────────────────────────────────────────────────────
is_clone_ref() {
  case "$1" in
    "$CLONE_ID"|"$CLONE_WRITER"|"$CLONE_PG"|"$CLONE_ARN") return 0 ;;
    *) return 1 ;;
  esac
}
SOURCE_SECRET_ARN="__unset__"   # filled from the source's describe below
is_prod_ref() {
  case "$1" in *vitana-aurora-prod*|*pg17-prod*) return 0 ;; esac
  [ "$1" = "$SOURCE_SECRET_ARN" ]
}

guard_mutation() {
  local svc="$1" op="$2"; shift 2
  case "$svc $op" in
    "rds restore-db-cluster-to-point-in-time"|"rds create-db-instance"|"rds enable-http-endpoint"|\
    "rds modify-db-cluster"|"rds copy-db-cluster-parameter-group"|"rds modify-db-cluster-parameter-group"|\
    "rds delete-db-instance"|"rds delete-db-cluster"|"rds delete-db-cluster-parameter-group"|\
    "rds-data execute-statement") ;;
    *) refuse "'aws $svc $op' is not an allowed mutation" ;;
  esac
  local targets=0 prev="" a
  for a in "$@"; do
    case "$prev" in
      --db-cluster-identifier|--db-instance-identifier|--resource-arn|--db-cluster-parameter-group-name|--target-db-cluster-parameter-group-identifier)
        is_clone_ref "$a" || refuse "'aws $svc $op' target $prev '$a' is not the rehearsal clone"
        targets=$((targets+1)) ;;
      --source-db-cluster-identifier)
        [ "$op" = restore-db-cluster-to-point-in-time ] && [ "$a" = "$SOURCE_ID" ] || refuse "unexpected $prev '$a' on $op" ;;
      --source-db-cluster-parameter-group-identifier)
        [ "$op" = copy-db-cluster-parameter-group ] || refuse "unexpected $prev on $op" ;;
      --secret-arn)
        [ "$a" != "$SOURCE_SECRET_ARN" ] || refuse "the production master secret is never used for a mutation" ;;
      *)
        # Any other appearance of a production name is refused outright.
        if is_prod_ref "$a" && [ "$prev" != --source-db-cluster-parameter-group-identifier ]; then
          refuse "'aws $svc $op' names a production resource ('$a') outside a --source-* argument"
        fi ;;
    esac
    prev="$a"
  done
  [ "$targets" -ge 1 ] || refuse "'aws $svc $op' has no rehearsal-clone target argument"
}

mut() {
  guard_mutation "$@"
  if $DRY_RUN; then echo "DRY-RUN (not executed): aws $*"; else aws "$@"; fi
}
wait_for() {
  if $DRY_RUN; then echo "DRY-RUN (not waited): aws rds wait $*"; return 0; fi
  local i
  for i in 1 2 3; do aws rds wait "$@" --region "$REGION" && return 0; echo "still waiting ($i/3): $*"; done
  return 1
}

# Test hook: run only the guard over one would-be call (no AWS call at all).
#   rehearsal-clone.sh guard-check rds delete-db-cluster --db-cluster-identifier X
if [ "$ACTION" = guard-check ]; then
  [ "${#GUARD_ARGS[@]}" -ge 2 ] || die "guard-check needs: <service> <operation> [args...]"
  guard_mutation "${GUARD_ARGS[@]}"; echo "ALLOWED: aws ${GUARD_ARGS[*]}"; exit 0
fi

# ── read-only helpers ─────────────────────────────────────────────────────────
ACT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACT_ACCOUNT" = "$ACCOUNT" ] || refuse "caller is in account $ACT_ACCOUNT, expected $ACCOUNT"

describe_cluster() {  # prints JSON of one cluster, or nothing when it does not exist
  aws rds describe-db-clusters --region "$REGION" --db-cluster-identifier "$1" --output json 2>/dev/null \
    | jq -c '.DBClusters[0] // empty' || true
}
pg_exists() {
  aws rds describe-db-cluster-parameter-groups --region "$REGION" --db-cluster-parameter-group-name "$1" >/dev/null 2>&1
}
summary() {  # $1 = cluster JSON
  jq -r '"cluster=\(.DBClusterIdentifier) status=\(.Status) engine=\(.Engine) \(.EngineVersion) endpoint=\(.Endpoint) clone_group=\(.CloneGroupId // "-") param_group=\(.DBClusterParameterGroup) data_api=\(.HttpEndpointEnabled // false) master_secret=\((.MasterUserSecret.SecretArn // "-") | sub(":secret:.*"; ":secret:<…>")) members=\([.DBClusterMembers[]?.DBInstanceIdentifier] | join(","))"' <<<"$1"
}

SRC_JSON=$(describe_cluster "$SOURCE_ID")
[ -n "$SRC_JSON" ] || die "source cluster $SOURCE_ID not found"
SOURCE_SECRET_ARN=$(jq -r '.MasterUserSecret.SecretArn // "__none__"' <<<"$SRC_JSON")

case "$ACTION" in
status)
  C=$(describe_cluster "$CLONE_ID")
  if [ -z "$C" ]; then echo "clone $CLONE_ID: absent"; exit 0; fi
  summary "$C"
  aws rds describe-db-instances --region "$REGION" --filters "Name=db-cluster-id,Values=$CLONE_ID" --output json \
    | jq -r '.DBInstances[]? | "instance=\(.DBInstanceIdentifier) class=\(.DBInstanceClass) status=\(.DBInstanceStatus)"'
  ;;

create)
  C=$(describe_cluster "$CLONE_ID")
  if [ -n "$C" ]; then
    echo "clone $CLONE_ID already exists — nothing created"; summary "$C"; exit 0
  fi
  [ "$(jq -r .Status <<<"$SRC_JSON")" = available ] || die "source $SOURCE_ID is not available"
  SUBNETS=$(jq -r .DBSubnetGroup <<<"$SRC_JSON")
  SGS=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$SRC_JSON")
  KMS=$(jq -r '.KmsKeyId // empty' <<<"$SRC_JSON")
  SRC_PG=$(jq -r .DBClusterParameterGroup <<<"$SRC_JSON")
  SRC_WRITER=$(jq -r '.DBClusterMembers[] | select(.IsClusterWriter) | .DBInstanceIdentifier' <<<"$SRC_JSON")
  [ -n "$SRC_WRITER" ] || die "source has no writer"
  W_JSON=$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$SRC_WRITER" --output json | jq -c '.DBInstances[0]')
  CLASS=$(jq -r .DBInstanceClass <<<"$W_JSON")
  INST_PG=$(jq -r '.DBParameterGroups[0].DBParameterGroupName' <<<"$W_JSON")
  ENGINE=$(jq -r .Engine <<<"$SRC_JSON")
  echo "source: $SOURCE_ID ($ENGINE $(jq -r .EngineVersion <<<"$SRC_JSON")) subnets=$SUBNETS sgs=$SGS pg=$SRC_PG writer=$SRC_WRITER class=$CLASS instance_pg=$INST_PG"

  # 1. The clone's own cluster parameter group (copy of the source's).
  if pg_exists "$CLONE_PG"; then echo "parameter group $CLONE_PG exists — reused"
  else
    mut rds copy-db-cluster-parameter-group --region "$REGION" \
      --source-db-cluster-parameter-group-identifier "$SRC_PG" \
      --target-db-cluster-parameter-group-identifier "$CLONE_PG" \
      --target-db-cluster-parameter-group-description "VTID-05023 part 10 rehearsal clone (copy of the source cluster group)" \
      --tags "Key=$TAG_KEY,Value=$TAG_VALUE"
  fi
  if $LOGICAL_REPLICATION; then
    mut rds modify-db-cluster-parameter-group --region "$REGION" --db-cluster-parameter-group-name "$CLONE_PG" \
      --parameters "ParameterName=rds.logical_replication,ParameterValue=1,ApplyMethod=pending-reboot"
  fi

  # 2. Copy-on-write clone.
  # shellcheck disable=SC2086
  mut rds restore-db-cluster-to-point-in-time --region "$REGION" \
    --restore-type copy-on-write --use-latest-restorable-time \
    --source-db-cluster-identifier "$SOURCE_ID" --db-cluster-identifier "$CLONE_ID" \
    --db-subnet-group-name "$SUBNETS" --vpc-security-group-ids $SGS \
    --db-cluster-parameter-group-name "$CLONE_PG" \
    ${KMS:+--kms-key-id "$KMS"} --no-deletion-protection \
    --tags "Key=$TAG_KEY,Value=$TAG_VALUE"
  wait_for db-cluster-available --db-cluster-identifier "$CLONE_ID"

  # 3. One writer, same class and instance parameter group as the source writer.
  mut rds create-db-instance --region "$REGION" --db-instance-identifier "$CLONE_WRITER" \
    --db-cluster-identifier "$CLONE_ID" --engine "$ENGINE" --db-instance-class "$CLASS" \
    --db-parameter-group-name "$INST_PG" --no-publicly-accessible \
    --tags "Key=$TAG_KEY,Value=$TAG_VALUE"
  wait_for db-instance-available --db-instance-identifier "$CLONE_WRITER"

  # 4. Data API + a master secret of the clone's own (the source's secret is never shared).
  mut rds enable-http-endpoint --region "$REGION" --resource-arn "$CLONE_ARN"
  mut rds modify-db-cluster --region "$REGION" --db-cluster-identifier "$CLONE_ID" \
    --manage-master-user-password --apply-immediately
  wait_for db-cluster-available --db-cluster-identifier "$CLONE_ID"
  if ! $DRY_RUN; then summary "$(describe_cluster "$CLONE_ID")"; fi
  echo "create: done"
  ;;

delete)
  C=$(describe_cluster "$CLONE_ID")
  if [ -z "$C" ]; then echo "clone $CLONE_ID: absent — nothing to delete"
  else
    [ "$(jq -r .DBClusterIdentifier <<<"$C")" = "$CLONE_ID" ] || refuse "describe returned another cluster"
    TAGGED=$(jq -r --arg k "$TAG_KEY" --arg v "$TAG_VALUE" '[.TagList[]? | select(.Key==$k and .Value==$v)] | length' <<<"$C")
    [ "$TAGGED" -ge 1 ] || refuse "$CLONE_ID does not carry $TAG_KEY=$TAG_VALUE — not created by this script, not deleted"
    for inst in $(jq -r '.DBClusterMembers[]?.DBInstanceIdentifier' <<<"$C"); do
      case "$inst" in "$CLONE_ID"-*) ;; *) refuse "member '$inst' is not a rehearsal instance" ;; esac
      [ "$inst" = "$CLONE_WRITER" ] || refuse "unexpected member '$inst' (only $CLONE_WRITER is ever created)"
      mut rds delete-db-instance --region "$REGION" --db-instance-identifier "$inst"
      wait_for db-instance-deleted --db-instance-identifier "$inst"
    done
    mut rds delete-db-cluster --region "$REGION" --db-cluster-identifier "$CLONE_ID" --skip-final-snapshot
    wait_for db-cluster-deleted --db-cluster-identifier "$CLONE_ID"
  fi
  if pg_exists "$CLONE_PG"; then
    mut rds delete-db-cluster-parameter-group --region "$REGION" --db-cluster-parameter-group-name "$CLONE_PG"
  fi
  echo "delete: done"
  ;;

sql)
  [ -f "$SQL_FILE" ] || die "no such file: $SQL_FILE"
  C=$(describe_cluster "$CLONE_ID"); [ -n "$C" ] || die "clone $CLONE_ID does not exist"
  SECRET=$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$C")
  [ -n "$SECRET" ] || die "clone has no managed master secret yet (create finishes that step)"
  [ "$SECRET" != "$SOURCE_SECRET_ARN" ] || refuse "clone reports the production master secret"
  n=0
  while IFS= read -r stmt || [ -n "$stmt" ]; do
    [[ -z "$stmt" || "$stmt" == --* ]] && continue
    n=$((n+1))
    if $DRY_RUN; then guard_mutation rds-data execute-statement --resource-arn "$CLONE_ARN" --secret-arn "$SECRET"; continue; fi
    if ! err=$(mut rds-data execute-statement --region "$REGION" --resource-arn "$CLONE_ARN" \
          --secret-arn "$SECRET" --database vitana --sql "$stmt" 2>&1 >/dev/null); then
      echo "FAILED at statement $n: ${stmt:0:200}" >&2; echo "$err" >&2; exit 1
    fi
  done < "$SQL_FILE"
  if $DRY_RUN; then echo "DRY-RUN: $n statements from $SQL_FILE would run on $CLONE_ID"; else echo "OK: $n statements from $SQL_FILE on $CLONE_ID"; fi
  ;;
esac

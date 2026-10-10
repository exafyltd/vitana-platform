#!/usr/bin/env bash
# VTID-05023 part 10: proves, with a fake `aws` on PATH (no network, no AWS), that
# scripts/aws/rehearsal-clone.sh can never create, change or delete anything but the
# rehearsal clone:
#   - create targets only vitana-aurora-rehearsal (+ its writer and parameter group);
#     vitana-aurora-prod appears only as the restore's --source-db-cluster-identifier
#     and its parameter group only as the copy's source;
#   - delete refuses vitana-aurora-prod and every other name, and an untagged cluster;
#   - --dry-run makes no mutating call; a wrong account makes no mutating call;
#   - the guard refuses every mutation aimed at production (equals-form included);
#   - sql runs only against the clone with the clone's own secret;
#   - AWS-REHEARSAL-AURORA-CLONE.yml is dispatch-only and makes no AWS call of its
#     own besides the identity check;
#   - every statement of rehearsal-clone-neutralize.sql refuses to run off the clone.
# Usage: bash scripts/aws/test/rehearsal-clone.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/aws/rehearsal-clone.sh"
WF="$ROOT/.github/workflows/AWS-REHEARSAL-AURORA-CLONE.yml"
NEUTRALIZE="$ROOT/scripts/aws/rehearsal-clone-neutralize.sql"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/state"
export FAKE_LOG="$WORK/aws.log" FAKE_STATE="$WORK/state"

cat > "$WORK/bin/aws" <<'FAKE'
#!/usr/bin/env bash
# Fake aws: logs every call, answers the describes, records state for the mutations.
echo "$*" >> "$FAKE_LOG"
S="$FAKE_STATE"
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
svc="$1"; op="$2"; shift 2
case "$svc $op" in
  "sts get-caller-identity") echo "${FAKE_ACCOUNT:-472838866351}" ;;
  "rds describe-db-clusters")
    id=$(arg --db-cluster-identifier "$@")
    if [ "$id" = vitana-aurora-prod ]; then
      cat <<'J'
{"DBClusters":[{"DBClusterIdentifier":"vitana-aurora-prod","Status":"available","Engine":"aurora-postgresql","EngineVersion":"17.4","Endpoint":"vitana-aurora-prod.cluster-x.eu-central-1.rds.amazonaws.com","DBClusterParameterGroup":"vitana-aurora-pg17-prod","DBSubnetGroup":"vitana-aurora-subnet-group","VpcSecurityGroups":[{"VpcSecurityGroupId":"sg-0838b2f2dabe87971"}],"KmsKeyId":"arn:aws:kms:eu-central-1:472838866351:key/1cd1f8d1","HttpEndpointEnabled":true,"MasterUserSecret":{"SecretArn":"arn:aws:secretsmanager:eu-central-1:472838866351:secret:rds!cluster-PROD"},"DBClusterMembers":[{"DBInstanceIdentifier":"vitana-aurora-prod-writer","IsClusterWriter":true}],"TagList":[]}]}
J
    elif [ "$id" = vitana-aurora-rehearsal ] && [ -f "$S/clone" ]; then
      secret='null'; [ -f "$S/secret" ] && secret='{"SecretArn":"arn:aws:secretsmanager:eu-central-1:472838866351:secret:rds!cluster-CLONE"}'
      [ -n "${FAKE_CLONE_SECRET:-}" ] && secret="{\"SecretArn\":\"$FAKE_CLONE_SECRET\"}"
      members='[]'; [ -f "$S/writer" ] && members='[{"DBInstanceIdentifier":"vitana-aurora-rehearsal-writer","IsClusterWriter":true}]'
      [ -n "${FAKE_EXTRA_MEMBER:-}" ] && members="[{\"DBInstanceIdentifier\":\"$FAKE_EXTRA_MEMBER\",\"IsClusterWriter\":false}]"
      tags='[{"Key":"Purpose","Value":"vtid-05023-part10-rehearsal"}]'; [ -n "${FAKE_UNTAGGED:-}" ] && tags='[]'
      echo "{\"DBClusters\":[{\"DBClusterIdentifier\":\"vitana-aurora-rehearsal\",\"Status\":\"available\",\"Engine\":\"aurora-postgresql\",\"EngineVersion\":\"17.4\",\"Endpoint\":\"vitana-aurora-rehearsal.cluster-x\",\"CloneGroupId\":\"cg-1\",\"DBClusterParameterGroup\":\"vitana-aurora-rehearsal-cluster-params\",\"HttpEndpointEnabled\":true,\"MasterUserSecret\":$secret,\"DBClusterMembers\":$members,\"TagList\":$tags}]}"
    else echo "An error occurred (DBClusterNotFoundFault)" >&2; exit 254; fi ;;
  "rds describe-db-instances")
    echo '{"DBInstances":[{"DBInstanceIdentifier":"vitana-aurora-prod-writer","DBInstanceClass":"db.r6g.large","DBInstanceStatus":"available","DBParameterGroups":[{"DBParameterGroupName":"default.aurora-postgresql17"}]}]}' ;;
  "rds describe-db-cluster-parameter-groups")
    n=$(arg --db-cluster-parameter-group-name "$@")
    if [ "$n" = vitana-aurora-pg17-prod ] || { [ "$n" = vitana-aurora-rehearsal-cluster-params ] && [ -f "$S/pg" ]; }; then echo '{}'; else exit 254; fi ;;
  "rds wait") : ;;
  "rds copy-db-cluster-parameter-group") touch "$S/pg" ;;
  "rds modify-db-cluster-parameter-group") : ;;
  "rds restore-db-cluster-to-point-in-time") touch "$S/clone" ;;
  "rds create-db-instance") touch "$S/writer" ;;
  "rds enable-http-endpoint") : ;;
  "rds modify-db-cluster") touch "$S/secret" ;;
  "rds delete-db-instance") rm -f "$S/writer" ;;
  "rds delete-db-cluster") rm -f "$S/clone" "$S/secret" ;;
  "rds delete-db-cluster-parameter-group") rm -f "$S/pg" ;;
  "rds-data execute-statement") echo '{}' ;;
  *) echo "fake aws: unexpected call: $svc $op $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$WORK/bin/aws"
export PATH="$WORK/bin:$PATH"

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
reset() { : > "$FAKE_LOG"; rm -f "$FAKE_STATE"/*; unset FAKE_ACCOUNT FAKE_UNTAGGED FAKE_CLONE_SECRET FAKE_EXTRA_MEMBER; }
MUTATING='(restore-db-cluster|create-db-instance|enable-http-endpoint|modify-db-|copy-db-cluster|delete-db-|reboot-db|execute-statement|failover|stop-db|start-db|add-tags|remove-tags)'
mutations() { grep -E "^(rds|rds-data) [a-z-]*$MUTATING" "$FAKE_LOG" || true; }
run() { set +e; OUT=$(bash "$SCRIPT" "$@" 2>&1); RC=$?; set -e; }

# Every mutating call must name only the clone; production only as a --source-* value.
check_targets() {
  local line bad_line=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # strip the two permitted source arguments, then nothing may mention production
    stripped=$(sed -E 's/--source-db-cluster-identifier vitana-aurora-prod( |$)/\1/; s/--source-db-cluster-parameter-group-identifier vitana-aurora-pg17-prod( |$)/\1/' <<<"$line")
    if grep -qE 'vitana-aurora-prod|pg17-prod|rds!cluster-PROD' <<<"$stripped"; then bad_line="$line"; break; fi
    grep -qE 'vitana-aurora-rehearsal' <<<"$line" || { bad_line="$line"; break; }
  done < <(mutations)
  [ -z "$bad_line" ] && ok "$1" || bad "$1: $bad_line"
}

echo "== guard: production targets are refused (no AWS call at all)"
reset
for call in \
  "rds delete-db-cluster --db-cluster-identifier vitana-aurora-prod --skip-final-snapshot" \
  "rds delete-db-cluster --db-cluster-identifier=vitana-aurora-prod" \
  "rds delete-db-instance --db-instance-identifier vitana-aurora-prod-writer" \
  "rds modify-db-cluster --db-cluster-identifier vitana-aurora-prod --manage-master-user-password" \
  "rds modify-db-cluster-parameter-group --db-cluster-parameter-group-name vitana-aurora-pg17-prod --parameters x" \
  "rds restore-db-cluster-to-point-in-time --source-db-cluster-identifier vitana-aurora-rehearsal --db-cluster-identifier vitana-aurora-prod" \
  "rds restore-db-cluster-to-point-in-time --source-db-cluster-identifier vitana-aurora-prod --db-cluster-identifier vitana-aurora-prod-2" \
  "rds enable-http-endpoint --resource-arn arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod" \
  "rds-data execute-statement --resource-arn arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod --sql x" \
  "rds reboot-db-instance --db-instance-identifier vitana-aurora-rehearsal-writer" \
  "rds failover-db-cluster --db-cluster-identifier vitana-aurora-rehearsal" \
  "rds delete-db-cluster --skip-final-snapshot" \
  "rds create-db-instance --db-instance-identifier vitana-aurora-rehearsal-writer --db-cluster-identifier vitana-aurora-prod" \
  "rds copy-db-cluster-parameter-group --source-db-cluster-parameter-group-identifier vitana-aurora-pg17-prod --target-db-cluster-parameter-group-identifier vitana-aurora-pg17-prod" \
  "rds delete-db-cluster --db-cluster-identifier vitana-aurora-rehearsal --tags Key=x,Value=vitana-aurora-prod" ; do
  # shellcheck disable=SC2086
  run guard-check $call
  if [ "$RC" = 3 ] && grep -q REFUSED <<<"$OUT"; then ok "refused: aws $call"; else bad "not refused (rc=$RC): aws $call — $OUT"; fi
done
for call in \
  "rds delete-db-cluster --db-cluster-identifier vitana-aurora-rehearsal --skip-final-snapshot" \
  "rds restore-db-cluster-to-point-in-time --source-db-cluster-identifier vitana-aurora-prod --db-cluster-identifier vitana-aurora-rehearsal" ; do
  # shellcheck disable=SC2086
  run guard-check $call
  [ "$RC" = 0 ] && ok "allowed: aws $call" || bad "wrongly refused: aws $call — $OUT"
done
[ ! -s "$FAKE_LOG" ] && ok "guard-check made no AWS call" || bad "guard-check called aws: $(cat "$FAKE_LOG")"

echo "== delete refuses every identifier but the clone (before any AWS call)"
for id in vitana-aurora-prod vitana-aurora-prod-writer vitana-aurora-rehearsal-2 vitana-aurora-rehearsa "" "vitana-aurora-rehearsal " VITANA-AURORA-REHEARSAL; do
  reset; run delete --identifier "$id"
  if [ "$RC" = 3 ] && [ ! -s "$FAKE_LOG" ]; then ok "delete --identifier '$id' refused, no AWS call"; else bad "delete --identifier '$id': rc=$RC log=$(cat "$FAKE_LOG")"; fi
done
reset; run create --identifier vitana-aurora-prod
[ "$RC" = 3 ] && [ ! -s "$FAKE_LOG" ] && ok "create --identifier vitana-aurora-prod refused" || bad "create --identifier prod: rc=$RC"

echo "== create --dry-run: no mutating call"
reset; run create --dry-run --logical-replication
[ "$RC" = 0 ] && ok "dry-run create exits 0" || bad "dry-run create rc=$RC: $OUT"
[ -z "$(mutations)" ] && ok "dry-run create made no mutating call" || bad "dry-run mutated: $(mutations)"
grep -q 'DRY-RUN (not executed): aws rds restore-db-cluster-to-point-in-time .*--restore-type copy-on-write --use-latest-restorable-time --source-db-cluster-identifier vitana-aurora-prod --db-cluster-identifier vitana-aurora-rehearsal' <<<"$OUT" \
  && ok "dry-run shows the copy-on-write restore from vitana-aurora-prod" || bad "restore line missing: $OUT"
grep -q -- '--db-cluster-parameter-group-name vitana-aurora-rehearsal-cluster-params' <<<"$OUT" && ok "clone gets its own parameter group" || bad "parameter group not the clone's"
grep -q -- '--db-subnet-group-name vitana-aurora-subnet-group --vpc-security-group-ids sg-0838b2f2dabe87971' <<<"$OUT" && ok "same subnet group and security groups as the source" || bad "network not copied"
grep -q -- '--kms-key-id arn:aws:kms:eu-central-1:472838866351:key/1cd1f8d1' <<<"$OUT" && ok "same KMS key as the source" || bad "KMS not copied"
grep -q -- 'create-db-instance .*--db-instance-class db.r6g.large --db-parameter-group-name default.aurora-postgresql17' <<<"$OUT" && ok "writer has the source writer's class and instance parameter group" || bad "writer class/pg"
grep -q -- 'rds.logical_replication,ParameterValue=1' <<<"$OUT" && grep -q -- 'modify-db-cluster-parameter-group .*--db-cluster-parameter-group-name vitana-aurora-rehearsal-cluster-params' <<<"$OUT" \
  && ok "--logical-replication changes only the clone's parameter group" || bad "logical replication line"

echo "== create (fake aws): only the clone is touched"
reset; run create
[ "$RC" = 0 ] && ok "create exits 0" || bad "create rc=$RC: $OUT"
check_targets "every mutating call of create names only the clone"
for op in copy-db-cluster-parameter-group restore-db-cluster-to-point-in-time create-db-instance enable-http-endpoint modify-db-cluster; do
  grep -qE "^rds $op " "$FAKE_LOG" && ok "create called $op" || bad "create did not call $op"
done
grep -q -- 'modify-db-cluster --region eu-central-1 --db-cluster-identifier vitana-aurora-rehearsal --manage-master-user-password' "$FAKE_LOG" && ok "clone gets its own managed master secret" || bad "master secret"
grep -q -- 'enable-http-endpoint --region eu-central-1 --resource-arn arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-rehearsal' "$FAKE_LOG" && ok "Data API enabled on the clone" || bad "data api"
grep -q -- '--no-deletion-protection' "$FAKE_LOG" && ok "clone has no deletion protection" || bad "deletion protection"
! grep -qE '^rds (modify|delete|reboot|failover|stop)[a-z-]* .*vitana-aurora-prod' "$FAKE_LOG" && ok "no modify/delete/reboot on vitana-aurora-prod" || bad "prod mutated"
: > "$FAKE_LOG"; run create
[ "$RC" = 0 ] && grep -q "already exists" <<<"$OUT" && [ -z "$(mutations)" ] && ok "create on an existing clone changes nothing" || bad "re-create: $OUT / $(mutations)"

echo "== sql: clone only, clone's own secret"
printf -- '-- comment\nSELECT 1;\n\nSELECT 2;\n' > "$WORK/t.sql"
: > "$FAKE_LOG"; run sql "$WORK/t.sql"
[ "$RC" = 0 ] && [ "$(grep -c '^rds-data execute-statement' "$FAKE_LOG")" = 2 ] && ok "sql ran 2 statements" || bad "sql: rc=$RC $OUT"
check_targets "sql targets only the clone with the clone's secret"
grep -q 'rds!cluster-CLONE' "$FAKE_LOG" && ok "sql used the clone's secret" || bad "secret"
: > "$FAKE_LOG"; run sql "$WORK/t.sql" --dry-run
[ "$RC" = 0 ] && [ -z "$(mutations)" ] && ok "sql --dry-run executes nothing" || bad "sql dry-run: $(mutations)"
: > "$FAKE_LOG"; FAKE_CLONE_SECRET='arn:aws:secretsmanager:eu-central-1:472838866351:secret:rds!cluster-PROD' run sql "$WORK/t.sql"
[ "$RC" = 3 ] && [ -z "$(mutations)" ] && ok "sql refuses when the clone reports the production secret" || bad "prod secret: rc=$RC"

echo "== delete"
: > "$FAKE_LOG"; run delete --dry-run
[ "$RC" = 0 ] && [ -z "$(mutations)" ] && ok "delete --dry-run makes no mutating call" || bad "delete dry-run: $(mutations)"
: > "$FAKE_LOG"; FAKE_UNTAGGED=1 run delete
[ "$RC" = 3 ] && [ -z "$(mutations)" ] && ok "delete refuses a cluster without the rehearsal tag" || bad "untagged: rc=$RC $(mutations)"
: > "$FAKE_LOG"; FAKE_EXTRA_MEMBER=vitana-aurora-prod-writer run delete
[ "$RC" = 3 ] && [ -z "$(mutations)" ] && ok "delete refuses a member that is not the rehearsal writer" || bad "extra member: rc=$RC $(mutations)"
: > "$FAKE_LOG"; run delete
[ "$RC" = 0 ] && ok "delete exits 0" || bad "delete rc=$RC: $OUT"
check_targets "every mutating call of delete names only the clone"
grep -q -- 'delete-db-cluster --region eu-central-1 --db-cluster-identifier vitana-aurora-rehearsal --skip-final-snapshot' "$FAKE_LOG" && ok "cluster deleted with --skip-final-snapshot" || bad "delete-db-cluster line"
grep -q -- 'delete-db-instance --region eu-central-1 --db-instance-identifier vitana-aurora-rehearsal-writer' "$FAKE_LOG" && ok "writer deleted first" || bad "delete-db-instance"
grep -q -- 'delete-db-cluster-parameter-group --region eu-central-1 --db-cluster-parameter-group-name vitana-aurora-rehearsal-cluster-params' "$FAKE_LOG" && ok "clone parameter group deleted" || bad "pg delete"
: > "$FAKE_LOG"; run delete
[ "$RC" = 0 ] && grep -q absent <<<"$OUT" && [ -z "$(mutations)" ] && ok "delete on an absent clone changes nothing" || bad "re-delete"

echo "== wrong account: no mutating call"
reset; FAKE_ACCOUNT=111111111111 run create
[ "$RC" = 3 ] && [ -z "$(mutations)" ] && ok "wrong account refused" || bad "wrong account rc=$RC"
reset

echo "== status is read-only"
run status
[ "$RC" = 0 ] && [ -z "$(mutations)" ] && grep -q absent <<<"$OUT" && ok "status (absent) read-only" || bad "status: $OUT"

echo "== workflow"
grep -qE '^on:' "$WF" && ok "workflow parses a trigger block" || bad "no on:"
python3 - "$WF" <<'PY' && ok "dispatch-only; reason required; action create|delete|status" || bad "workflow triggers/inputs"
import sys, re
t = open(sys.argv[1]).read()
on = t.split('\non:', 1)[1].split('\npermissions:', 1)[0]
assert re.search(r'^\s{2}workflow_dispatch:\s*$', on, re.M), 'no workflow_dispatch'
assert not re.search(r'^\s{2}(push|pull_request|schedule|workflow_run|repository_dispatch)\b', on, re.M), 'other trigger'
assert re.search(r'reason:\s*\n\s+description:[^\n]*\n\s+required: true', on), 'reason not required'
assert 'options: [status, create, delete]' in on, 'action choices'
assert 'secrets.AWS_PROD_ROLE_ARN' in t and 'id-token: write' in t, 'OIDC'
PY
AWS_LINES=$(grep -nE '(^|[^-a-z/])aws (rds|rds-data|ec2|ecs|secretsmanager|sts|s3|kms|iam)\b' "$WF" | grep -v '^\s*[0-9]*:\s*#' || true)
OTHER=$(grep -v 'aws sts get-caller-identity' <<<"$AWS_LINES" | sed '/^$/d' || true)
[ -z "$OTHER" ] && ok "workflow makes no AWS call besides the identity check (everything else via the guarded script)" || bad "direct aws calls in the workflow: $OTHER"
grep -q 'CONFIRM" != "$CLONE_ID"' "$WF" && ok "workflow delete needs confirm=vitana-aurora-rehearsal" || bad "confirm"

echo "== neutralize SQL refuses to run off the clone"
N=0; G=0
while IFS= read -r l; do
  [[ -z "$l" || "$l" == --* ]] && continue
  N=$((N+1))
  if [[ "$l" == "DO \$\$ BEGIN IF aurora_db_instance_identifier() NOT LIKE 'vitana-aurora-rehearsal%' THEN RAISE EXCEPTION"* && "$l" == *'END $$;' ]]; then G=$((G+1)); fi
done < "$NEUTRALIZE"
[ "$N" -ge 2 ] && [ "$N" = "$G" ] && ok "all $N statements start with the clone-identity guard" || bad "neutralize: $G/$N guarded"

echo
echo "rehearsal-clone: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]

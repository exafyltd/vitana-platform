#!/usr/bin/env bash
# VTID-05023 parts 8b + 12(i): Aurora -> Supabase DMS CDC tasks (one-way, change data only).
#
#   --scope storage-auth  the 5 tables Supabase Storage policies read after the flip
#                         (chat_messages, chat_group_members, thread_participants,
#                         global_thread_participants -> can_access_chat_attachment();
#                         voucher_orders -> "Users can download their own voucher PDFs").
#                         Runs for as long as Storage stays on Supabase.
#   --scope rollback      every other public table, for the T+2h rollback window (12 i);
#                         stopped and deleted when the window closes.
#
# Supabase's postgres role cannot SET session_replication_role (read live 2026-10-10), so the
# target is NOT in replica mode; supabase-cutover-reverse-cdc-triggers.sql disables every public
# user trigger on Supabase before these tasks start. Tasks are CDC-only (no full load: at the start
# both sides hold the same rows, Supabase frozen since the final load), apply transactionally in
# commit order, and upsert on conflict so a retried change converges.
#
# Dry run by default: prints the endpoint and task definitions, calls no mutating AWS API.
#   --apply   create the two reverse endpoints (if missing) and the task (if missing), NOT started.
#             Prompts for both database passwords (never echoed, never on a command line; they
#             pass through a 0600 temp file that is deleted on exit).
# Start (window, after the final load + after-load + backfill, BEFORE the gateway flip):
#   aws dms start-replication-task --region eu-central-1 --replication-task-arn <arn> \
#     --start-replication-task-type start-replication
# Needs rds.logical_replication=1 on Aurora (aurora-cluster-params-cutover.sh + reboot).
set -euo pipefail

REGION="eu-central-1"; ACCOUNT="472838866351"
REPLICATION_INSTANCE_ARN="arn:aws:dms:eu-central-1:472838866351:rep:PHZCRFHVT5ENVI4H4NMGWBXSEI"
AURORA_HOST="vitana-aurora-prod.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com"
AURORA_DB="vitana"; AURORA_USER="vitana_admin"
SUPABASE_HOST="aws-1-eu-north-1.pooler.supabase.com"
SUPABASE_DB="postgres"; SUPABASE_USER="postgres.inmkhvwdcuyhnxkgfvsb"
SRC_ID="vitana-src-aurora-reverse"; TGT_ID="vitana-tgt-supabase-reverse"
STORAGE_AUTH_TABLES="chat_messages chat_group_members thread_participants global_thread_participants voucher_orders"
# Aurora-only tables (they do not exist on Supabase) — never replicated.
AURORA_ONLY_TABLES="auth_user_fk_map auth_bridge_deleted_users outbound_http_requests"

SCOPE=""; APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$SCOPE" in
  storage-auth) TASK_ID="vitana-cdc-aurora-to-supabase-storage-auth" ;;
  rollback) TASK_ID="vitana-cdc-aurora-to-supabase-rollback" ;;
  *) echo "usage: $0 --scope storage-auth|rollback [--apply]" >&2; exit 2 ;;
esac

mappings() { # JSON table mappings for the scope
  python3 - "$SCOPE" "$STORAGE_AUTH_TABLES" "$AURORA_ONLY_TABLES" <<'PY'
import json, sys
scope, sa, only = sys.argv[1], sys.argv[2].split(), sys.argv[3].split()
rules, n = [], 0
def rule(action, table, name):
    global n
    n += 1
    rules.append({"rule-type": "selection", "rule-id": str(n), "rule-name": name,
                  "object-locator": {"schema-name": "public", "table-name": table},
                  "rule-action": action})
if scope == "storage-auth":
    for t in sa: rule("include", t, f"include-{t}")
else:
    rule("include", "%", "include-public")
    for t in sa: rule("exclude", t, f"exclude-storage-auth-{t}")
    for t in only: rule("exclude", t, f"exclude-aurora-only-{t}")
    rule("exclude", "awsdms%", "exclude-awsdms")
print(json.dumps({"rules": rules}))
PY
}

settings() {
  cat <<'JSON'
{"TargetMetadata":{"SupportLobs":true,"FullLobMode":false,"LobMaxSize":0,"InlineLobMaxSize":0,"LimitedSizeLobMode":true,"LobChunkSize":64},
 "FullLoadSettings":{"TargetTablePrepMode":"DO_NOTHING"},
 "ChangeProcessingTuning":{"BatchApplyEnabled":false},
 "ErrorBehavior":{"DataErrorPolicy":"LOG_ERROR","ApplyErrorInsertPolicy":"UPDATE_RECORD","ApplyErrorUpdatePolicy":"INSERT_RECORD","ApplyErrorDeletePolicy":"IGNORE_RECORD","ApplyErrorEscalationPolicy":"LOG_ERROR","TableErrorPolicy":"SUSPEND_TABLE","RecoverableErrorCount":-1},
 "Logging":{"EnableLogging":true}}
JSON
}

# LimitedSizeLobMode with LobMaxSize 0 is invalid; size it for pgvector/jsonb text.
SETTINGS="$(settings | python3 -c 'import json,sys; s=json.load(sys.stdin); s["TargetMetadata"]["LobMaxSize"]=1024; print(json.dumps(s))')"
MAPPINGS="$(mappings)"

echo "== scope: $SCOPE   task: $TASK_ID"
echo "== source endpoint $SRC_ID: aurora-postgresql $AURORA_HOST/$AURORA_DB as $AURORA_USER, ssl require, PluginName=test-decoding"
echo "== target endpoint $TGT_ID: postgres $SUPABASE_HOST/$SUPABASE_DB as $SUPABASE_USER, ssl require (no replica mode, see header)"
echo "== table mappings:"; echo "$MAPPINGS" | python3 -m json.tool
echo "== task settings:"; echo "$SETTINGS" | python3 -m json.tool

if [ "$APPLY" != 1 ]; then echo "dry run: nothing created (add --apply)"; exit 0; fi

acct=$(aws sts get-caller-identity --query Account --output text)
[ "$acct" = "$ACCOUNT" ] || { echo "refusing: AWS account $acct is not $ACCOUNT" >&2; exit 1; }

TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
pg_settings() { # file with the endpoint's PostgreSQLSettings; password from $PW in the environment
  ( umask 077; python3 -c 'import json,os,sys; d=json.loads(sys.argv[1]); d["Password"]=os.environ["PW"]; print(json.dumps(d))' "$1" > "$TMP/$2.json" )
  echo "file://$TMP/$2.json"
}
endpoint_arn() { aws dms describe-endpoints --region "$REGION" --filters "Name=endpoint-id,Values=$1" --query 'Endpoints[0].EndpointArn' --output text 2>/dev/null || true; }

SRC_ARN=$(endpoint_arn "$SRC_ID")
if [ -z "$SRC_ARN" ] || [ "$SRC_ARN" = "None" ]; then
  read -rsp "Aurora password for $AURORA_USER: " PW; echo; export PW
  SRC_ARN=$(aws dms create-endpoint --region "$REGION" --endpoint-identifier "$SRC_ID" --endpoint-type source \
    --engine-name aurora-postgresql --ssl-mode require \
    --postgre-sql-settings "$(pg_settings "{\"ServerName\":\"$AURORA_HOST\",\"Port\":5432,\"DatabaseName\":\"$AURORA_DB\",\"Username\":\"$AURORA_USER\",\"PluginName\":\"test-decoding\",\"CaptureDdls\":false,\"HeartbeatEnable\":false,\"MapBooleanAsBoolean\":true}" src)" \
    --query 'Endpoint.EndpointArn' --output text)
  unset PW; rm -f "$TMP/src.json"
fi
TGT_ARN=$(endpoint_arn "$TGT_ID")
if [ -z "$TGT_ARN" ] || [ "$TGT_ARN" = "None" ]; then
  read -rsp "Supabase password for $SUPABASE_USER: " PW; echo; export PW
  TGT_ARN=$(aws dms create-endpoint --region "$REGION" --endpoint-identifier "$TGT_ID" --endpoint-type target \
    --engine-name postgres --ssl-mode require \
    --postgre-sql-settings "$(pg_settings "{\"ServerName\":\"$SUPABASE_HOST\",\"Port\":5432,\"DatabaseName\":\"$SUPABASE_DB\",\"Username\":\"$SUPABASE_USER\",\"MapBooleanAsBoolean\":true}" tgt)" \
    --query 'Endpoint.EndpointArn' --output text)
  unset PW; rm -f "$TMP/tgt.json"
fi
echo "source endpoint: $SRC_ARN"; echo "target endpoint: $TGT_ARN"

TASK_ARN=$(aws dms describe-replication-tasks --region "$REGION" --filters "Name=replication-task-id,Values=$TASK_ID" --query 'ReplicationTasks[0].ReplicationTaskArn' --output text 2>/dev/null || true)
if [ -n "$TASK_ARN" ] && [ "$TASK_ARN" != "None" ]; then echo "task exists: $TASK_ARN (not changed)"; exit 0; fi
TASK_ARN=$(aws dms create-replication-task --region "$REGION" --replication-task-identifier "$TASK_ID" \
  --source-endpoint-arn "$SRC_ARN" --target-endpoint-arn "$TGT_ARN" --replication-instance-arn "$REPLICATION_INSTANCE_ARN" \
  --migration-type cdc --table-mappings "$MAPPINGS" --replication-task-settings "$SETTINGS" \
  --query 'ReplicationTask.ReplicationTaskArn' --output text)
echo "created (NOT started): $TASK_ARN"
echo "test both endpoints from the replication instance before the window:"
echo "  aws dms test-connection --region $REGION --replication-instance-arn $REPLICATION_INSTANCE_ARN --endpoint-arn <arn>"

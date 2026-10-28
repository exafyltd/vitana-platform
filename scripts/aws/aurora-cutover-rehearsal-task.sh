#!/usr/bin/env bash
#
# Aurora cutover rehearsal DMS task (VTID-04084)
#
# Creates a clone of the `vitana-fullload-only` DMS task
# (arn:aws:dms:eu-central-1:472838866351:task:76AG2CJIY5H6HODN7VOW6AQL74)
# with ONE change: FullLoadSettings.TargetTablePrepMode switched from
# DROP_AND_CREATE to TRUNCATE_BEFORE_LOAD.
#
# WHY: DROP_AND_CREATE rebuilds each target table from DMS's own
# column-only inferred DDL before loading -- this destroys any RLS
# policies (and any other custom constraint/trigger) already applied to
# that table on Aurora. Two tables (`conversation_messages`, `reminders`)
# already fail outright under DROP_AND_CREATE with Postgres error 2BP01
# ("cannot drop table because other objects depend on it") -- the
# dependent objects being their own RLS policies. Once
# aurora-restore-rls-parity.sql has been applied (see that script and
# docs/AURORA-MIGRATION-STATUS-2026-09-10.md), EVERY table that gets RLS
# would hit the same failure on the next DROP_AND_CREATE run, not just
# these two.
#
# TRUNCATE_BEFORE_LOAD never drops the table -- it empties existing rows
# and reloads, which is exactly what a full re-sync should do once the
# schema (including RLS/policies) is already correct on the target. It
# requires the target table to already exist with the right structure,
# which is true here: this task's source/target endpoints and table
# mappings are byte-identical to the live `vitana-fullload-only` task,
# which already created every one of these tables on a prior run.
#
# This is a REHEARSAL task, not the final cutover run -- it exists to (a)
# get a real timing measurement with RLS intact, (b) confirm
# TRUNCATE_BEFORE_LOAD actually clears the conversation_messages/reminders
# conflict, and (c) flush out any other target-side conflict before the
# real 2026-09-20 22:00 CET window. It targets the SAME Aurora database
# the real cutover run will use (Aurora is not yet serving production
# traffic, so this is safe) -- running it TRUNCATES and reloads every
# included table on Aurora. Do not run this against a database anyone is
# relying on for anything else.
#
# Usage:
#   ./aurora-cutover-rehearsal-task.sh          # dry-run: prints the exact
#                                                # aws dms create-replication-task
#                                                # command, does not call AWS
#   ./aurora-cutover-rehearsal-task.sh --apply   # actually creates the task
#                                                # (does NOT start it --
#                                                # starting is a separate,
#                                                # deliberate step, see below)
#
# After creation, start it explicitly and watch it:
#   aws dms start-replication-task --region eu-central-1 \
#     --replication-task-arn <arn-from-create-output> \
#     --start-replication-task-type reload-target
#   aws dms describe-replication-tasks --region eu-central-1 \
#     --filters Name=replication-task-id,Values=vitana-fullload-rehearsal \
#     --query 'ReplicationTasks[0].{Status:Status,Stats:ReplicationTaskStats}'
#
# Clean up when done rehearsing (does not affect the live vitana-fullload-only task):
#   aws dms delete-replication-task --region eu-central-1 \
#     --replication-task-arn <arn-from-create-output>

set -euo pipefail

REGION="eu-central-1"
TASK_ID="vitana-fullload-rehearsal"
SOURCE_ENDPOINT_ARN="arn:aws:dms:eu-central-1:472838866351:endpoint:M5KXPHGSEZHMDBXFLV5WVH3MAU"
TARGET_ENDPOINT_ARN="arn:aws:dms:eu-central-1:472838866351:endpoint:HYKKFCTTVRAYDNYH7MMUHOCUPI"
REPLICATION_INSTANCE_ARN="arn:aws:dms:eu-central-1:472838866351:rep:PHZCRFHVT5ENVI4H4NMGWBXSEI"
MIGRATION_TYPE="full-load"

# Byte-identical to vitana-fullload-only's live table mappings (16 rules:
# include public.%, exclude DMS control tables + the 13 separately-synced
# tables documented in docs/AURORA-MIGRATION-STATUS-2026-09-10.md, plus
# the lowercase-schema transformation).
TABLE_MAPPINGS='{"rules": [{"object-locator": {"schema-name": "public", "table-name": "%"}, "rule-action": "include", "rule-id": "1", "rule-name": "include-public-schema", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "awsdms_%"}, "rule-action": "exclude", "rule-id": "2", "rule-name": "exclude-dms-control-tables", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "memory_audit_log"}, "rule-action": "exclude", "rule-id": "3", "rule-name": "exclude-partition-parent", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "products"}, "rule-action": "exclude", "rule-id": "4", "rule-name": "exclude-products-known-broken", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "knowledge_docs"}, "rule-action": "exclude", "rule-id": "5", "rule-name": "exclude-knowledge_docs-known-broken", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "ai_memory"}, "rule-action": "exclude", "rule-id": "6", "rule-name": "exclude-done-ai_memory", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "memory_items"}, "rule-action": "exclude", "rule-id": "7", "rule-name": "exclude-done-memory_items", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "memory_facts"}, "rule-action": "exclude", "rule-id": "8", "rule-name": "exclude-done-memory_facts", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "mem_episodes"}, "rule-action": "exclude", "rule-id": "9", "rule-name": "exclude-done-mem_episodes", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "user_intents"}, "rule-action": "exclude", "rule-id": "10", "rule-name": "exclude-done-user_intents", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "memory_embeddings"}, "rule-action": "exclude", "rule-id": "11", "rule-name": "exclude-done-memory_embeddings", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "community_listings"}, "rule-action": "exclude", "rule-id": "12", "rule-name": "exclude-done-community_listings", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "calendar_events"}, "rule-action": "exclude", "rule-id": "13", "rule-name": "exclude-done-calendar_events", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "mem_facts"}, "rule-action": "exclude", "rule-id": "14", "rule-name": "exclude-done-mem_facts", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "feedback_tickets"}, "rule-action": "exclude", "rule-id": "15", "rule-name": "exclude-done-feedback_tickets", "rule-type": "selection"}, {"object-locator": {"schema-name": "%"}, "rule-action": "convert-lowercase", "rule-id": "20", "rule-name": "lowercase-schema", "rule-target": "schema", "rule-type": "transformation"}]}'

# Byte-identical to vitana-fullload-only's live ReplicationTaskSettings,
# with exactly one field changed: FullLoadSettings.TargetTablePrepMode
# DROP_AND_CREATE -> TRUNCATE_BEFORE_LOAD.
TASK_SETTINGS='{"Logging": {"EnableLogging": true, "EnableLogContext": false, "LogComponents": [{"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "TRANSFORMATION"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "SOURCE_UNLOAD"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "IO"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "TARGET_LOAD"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "PERFORMANCE"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "SOURCE_CAPTURE"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "SORTER"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "REST_SERVER"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "VALIDATOR_EXT"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "TARGET_APPLY"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "TASK_MANAGER"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "TABLES_MANAGER"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "METADATA_MANAGER"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "FILE_FACTORY"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "COMMON"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "ADDONS"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "DATA_STRUCTURE"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "COMMUNICATION"}, {"Severity": "LOGGER_SEVERITY_DEFAULT", "Id": "FILE_TRANSFER"}]}, "StreamBufferSettings": {"StreamBufferCount": 3, "CtrlStreamBufferSizeInMB": 5, "StreamBufferSizeInMB": 8}, "ErrorBehavior": {"FailOnNoTablesCaptured": true, "ApplyErrorUpdatePolicy": "LOG_ERROR", "FailOnTransactionConsistencyBreached": false, "RecoverableErrorThrottlingMax": 1800, "DataErrorEscalationPolicy": "SUSPEND_TABLE", "ApplyErrorEscalationCount": 0, "RecoverableErrorStopRetryAfterThrottlingMax": true, "RecoverableErrorThrottling": true, "ApplyErrorFailOnTruncationDdl": false, "DataMaskingErrorPolicy": "STOP_TASK", "DataTruncationErrorPolicy": "LOG_ERROR", "ApplyErrorInsertPolicy": "LOG_ERROR", "EventErrorPolicy": "IGNORE", "ApplyErrorEscalationPolicy": "LOG_ERROR", "RecoverableErrorCount": -1, "DataErrorEscalationCount": 0, "TableErrorEscalationPolicy": "STOP_TASK", "RecoverableErrorInterval": 5, "ApplyErrorDeletePolicy": "IGNORE_RECORD", "TableErrorEscalationCount": 0, "FullLoadIgnoreConflicts": true, "DataErrorPolicy": "LOG_ERROR", "TableErrorPolicy": "SUSPEND_TABLE"}, "TTSettings": null, "FullLoadSettings": {"CommitRate": 10000, "StopTaskCachedChangesApplied": false, "StopTaskCachedChangesNotApplied": false, "MaxFullLoadSubTasks": 3, "TransactionConsistencyTimeout": 600, "CreatePkAfterFullLoad": false, "TargetTablePrepMode": "TRUNCATE_BEFORE_LOAD"}, "TargetMetadata": {"ParallelApplyBufferSize": 0, "ParallelApplyQueuesPerThread": 0, "ParallelApplyThreads": 0, "TargetSchema": "", "InlineLobMaxSize": 0, "ParallelLoadQueuesPerThread": 0, "SupportLobs": true, "LobChunkSize": 64, "TaskRecoveryTableEnabled": false, "ParallelLoadThreads": 0, "LobMaxSize": 102400, "BatchApplyEnabled": false, "FullLobMode": false, "LimitedSizeLobMode": true, "LoadMaxFileSize": 0, "ParallelLoadBufferSize": 0}, "BeforeImageSettings": null, "ControlTablesSettings": {"historyTimeslotInMinutes": 5, "HistoryTimeslotInMinutes": 5, "StatusTableEnabled": false, "SuspendedTablesTableEnabled": false, "HistoryTableEnabled": false, "ControlSchema": "", "FullLoadExceptionTableEnabled": false}, "LoopbackPreventionSettings": null, "CharacterSetSettings": null, "FailTaskWhenCleanTaskResourceFailed": false, "ChangeProcessingTuning": {"StatementCacheSize": 50, "CommitTimeout": 1, "RecoveryTimeout": -1, "BatchApplyPreserveTransaction": true, "BatchApplyTimeoutMin": 1, "BatchSplitSize": 0, "BatchApplyTimeoutMax": 30, "MinTransactionSize": 1000, "MemoryKeepTime": 60, "BatchApplyMemoryLimit": 500, "MemoryLimitTotal": 1024}, "ChangeProcessingDdlHandlingPolicy": {"HandleSourceTableDropped": true, "HandleSourceTableTruncated": true, "HandleSourceTableAltered": true}, "PostProcessingRules": null}'

CMD=(aws dms create-replication-task
  --region "$REGION"
  --replication-task-identifier "$TASK_ID"
  --source-endpoint-arn "$SOURCE_ENDPOINT_ARN"
  --target-endpoint-arn "$TARGET_ENDPOINT_ARN"
  --replication-instance-arn "$REPLICATION_INSTANCE_ARN"
  --migration-type "$MIGRATION_TYPE"
  --table-mappings "$TABLE_MAPPINGS"
  --replication-task-settings "$TASK_SETTINGS"
)

if [[ "${1:-}" == "--apply" ]]; then
  echo "Creating DMS task '$TASK_ID' (TRUNCATE_BEFORE_LOAD)..."
  "${CMD[@]}"
  echo
  echo "Created. This task is NOT started yet. Review docs/AURORA-MIGRATION-STATUS-2026-09-10.md"
  echo "for the start/monitor/cleanup commands before starting it."
else
  echo "DRY RUN -- would run:"
  printf '%q ' "${CMD[@]}"
  echo
  echo
  echo "Pass --apply to actually create the task. It will NOT be started automatically."
fi

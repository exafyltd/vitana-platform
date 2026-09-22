#!/usr/bin/env bash
#
# Aurora cutover FINAL catch-up DMS task (VTID-04101 follow-up)
#
# Same shape as aurora-cutover-rehearsal-task.sh (byte-identical
# source/target/replication-instance ARNs, TRUNCATE_BEFORE_LOAD prep
# mode) with ONE deliberate difference: the 10 "exclude-done-*" table
# mapping rules are REMOVED, so this task's `include public.%` picks
# them up along with everything else.
#
# WHY THIS EXISTS: docs/AURORA-MIGRATION-STATUS-2026-09-10.md's
# "Addendum, 2026-09-12 continued (7)" found that these 10 tables --
# `ai_memory`, `memory_items`, `memory_facts`, `mem_episodes`,
# `user_intents`, `memory_embeddings`, `community_listings`,
# `calendar_events`, `mem_facts`, `feedback_tickets` -- were excluded
# from every full-load task on the theory that "a separate mechanism
# keeps them in sync" (their mapping rules are literally named
# `exclude-done-<table>`). Real row-count checks that same session found
# 4 of them had already drifted by ~2-11% versus Supabase with nothing
# resyncing them. The immediately following "Addendum ... (11)" then
# traced every Aurora-connected code path in this repo (the
# `aurora-rls-health` probe, the `db-i18n` seam, the memory-rebuild
# connectivity probe) and confirmed NONE of them read or write any of
# these 10 tables on Aurora -- the real write path for the memory/fact
# tables goes straight to Supabase PostgREST, never through an Aurora
# pool. Conclusion: there is no separate sync mechanism to protect by
# excluding these tables. They were loaded once by an earlier ad-hoc
# effort and never touched again. Leaving them excluded from the
# cutover-time final load means Aurora would serve that stale,
# months-old snapshot indefinitely post-cutover, with the actual
# `write_fact()`/memory-write path now silently pointed at a database
# nobody is writing to.
#
# `products`/`knowledge_docs` (the OTHER two tables the old
# `vitana-fullload-only` task excluded, ruled `exclude-*-known-broken`)
# are deliberately NOT re-added here -- that question was separately
# investigated and closed on 2026-09-20 ("`products`/`knowledge_docs`
# 'known-broken' question RESOLVED, no fix needed" in the status doc):
# both already load cleanly under the current TRUNCATE_BEFORE_LOAD task
# and need no special handling.
#
# This is intended to run as (or immediately before/after) the runbook's
# Step 5 final catch-up load -- see
# docs/AURORA-CUTOVER-RUNBOOK-2026-09-20.md. It targets the SAME Aurora
# database the rehearsal tasks used; running it TRUNCATES and reloads
# every included table (11 more tables than `vitana-fullload-rehearsal-v2`
# covered). Do not run this against a database anyone is relying on for
# anything else, and do not run it outside the write-freeze window (Step
# 4) if run as part of the real cutover -- Supabase writes to these 10
# tables during an unfrozen reload race exactly like any other table.
#
# Usage:
#   ./aurora-cutover-final-catchup-task.sh          # dry-run: prints the exact
#                                                    # aws dms create-replication-task
#                                                    # command, does not call AWS
#   ./aurora-cutover-final-catchup-task.sh --apply   # actually creates the task
#                                                     # (does NOT start it --
#                                                     # starting is a separate,
#                                                     # deliberate step, see below)
#
# After creation, start it explicitly and watch it:
#   aws dms start-replication-task --region eu-central-1 \
#     --replication-task-arn <arn-from-create-output> \
#     --start-replication-task-type reload-target
#   aws dms describe-replication-tasks --region eu-central-1 \
#     --filters Name=replication-task-id,Values=vitana-fullload-final-catchup \
#     --query 'ReplicationTasks[0].{Status:Status,Stats:ReplicationTaskStats}'
#
# Clean up once the real cutover's Step 5 is done (does not affect any
# other DMS task):
#   aws dms delete-replication-task --region eu-central-1 \
#     --replication-task-arn <arn-from-create-output>

set -euo pipefail

REGION="eu-central-1"
TASK_ID="vitana-fullload-final-catchup"
SOURCE_ENDPOINT_ARN="arn:aws:dms:eu-central-1:472838866351:endpoint:M5KXPHGSEZHMDBXFLV5WVH3MAU"
TARGET_ENDPOINT_ARN="arn:aws:dms:eu-central-1:472838866351:endpoint:HYKKFCTTVRAYDNYH7MMUHOCUPI"
REPLICATION_INSTANCE_ARN="arn:aws:dms:eu-central-1:472838866351:rep:PHZCRFHVT5ENVI4H4NMGWBXSEI"
MIGRATION_TYPE="full-load"

# Same as vitana-fullload-rehearsal-v2's live table mappings, MINUS the
# 10 "exclude-done-*" rules (former rule-ids 6-15). `products`/
# `knowledge_docs` ("known-broken", a different, already-resolved
# question -- see header) and the DMS control-table/partition-parent
# excludes are kept unchanged.
TABLE_MAPPINGS='{"rules": [{"object-locator": {"schema-name": "public", "table-name": "%"}, "rule-action": "include", "rule-id": "1", "rule-name": "include-public-schema", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "awsdms_%"}, "rule-action": "exclude", "rule-id": "2", "rule-name": "exclude-dms-control-tables", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "memory_audit_log"}, "rule-action": "exclude", "rule-id": "3", "rule-name": "exclude-partition-parent", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "products"}, "rule-action": "exclude", "rule-id": "4", "rule-name": "exclude-products-known-broken", "rule-type": "selection"}, {"object-locator": {"schema-name": "public", "table-name": "knowledge_docs"}, "rule-action": "exclude", "rule-id": "5", "rule-name": "exclude-knowledge_docs-known-broken", "rule-type": "selection"}, {"object-locator": {"schema-name": "%"}, "rule-action": "convert-lowercase", "rule-id": "20", "rule-name": "lowercase-schema", "rule-target": "schema", "rule-type": "transformation"}]}'

# Byte-identical to vitana-fullload-rehearsal-v2's ReplicationTaskSettings
# (TRUNCATE_BEFORE_LOAD -- never DROP_AND_CREATE, which would strip RLS
# from every included table again; see aurora-cutover-rehearsal-task.sh).
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
  echo "Creating DMS task '$TASK_ID' (TRUNCATE_BEFORE_LOAD, exclude-done tables now included)..."
  "${CMD[@]}"
  echo
  echo "Created. This task is NOT started yet. Review"
  echo "docs/AURORA-CUTOVER-RUNBOOK-2026-09-20.md Step 5 for the"
  echo "start/monitor/cleanup commands before starting it."
else
  echo "DRY RUN -- would run:"
  printf '%q ' "${CMD[@]}"
  echo
  echo
  echo "Pass --apply to actually create the task. It will NOT be started automatically."
fi

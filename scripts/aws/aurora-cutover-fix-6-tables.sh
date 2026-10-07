#!/usr/bin/env bash
# One-shot: pre-load SQL -> reload the 6 failed tables via DMS -> post-load SQL
# -> 355 foreign keys (VTID-04755). Stops at the first failure. Run as a file
# (bash aurora-cutover-fix-6-tables.sh), not pasted line by line.
set -euo pipefail
export AWS_PAGER=""
R=eu-central-1
cd "$(dirname "$0")"
T=arn:aws:dms:eu-central-1:472838866351:task:HIET6MRCGBCLROCKMF53PISNK4

echo "== 1/4 pre-load";  ./aurora-run-sql.sh aurora-cutover-vector-preload.sql
echo "== 2/4 reload 6 tables"
aws dms start-replication-task --region $R --replication-task-arn $T --start-replication-task-type start-replication >/dev/null
sleep 30
until [ "$(aws dms describe-replication-tasks --region $R --filters Name=replication-task-arn,Values=$T --query 'ReplicationTasks[0].Status' --output text)" = stopped ]; do sleep 20; done
read -r loaded errored < <(aws dms describe-replication-tasks --region $R --filters Name=replication-task-arn,Values=$T --query 'ReplicationTasks[0].ReplicationTaskStats.[TablesLoaded,TablesErrored]' --output text)
echo "loaded=$loaded errored=$errored"
if [ "$errored" != "0" ]; then echo "STOP: $errored table(s) errored -- send this output to Claude" >&2; exit 1; fi
echo "== 3/4 post-load"; ./aurora-run-sql.sh aurora-cutover-vector-postload.sql
echo "== 4/4 foreign keys"; ./aurora-run-sql.sh aurora-cutover-recreate-foreign-keys.sql
echo "ALL DONE"

#!/usr/bin/env bash
# After the full DMS load (VTID-04755): report truncated embeddings, then
# post-load (vectors back to vector type, indexes) -> foreign keys -> views.
# Stops at the first failure. Run as a file: bash aurora-cutover-after-load.sh
set -euo pipefail
export AWS_PAGER=""
R=eu-central-1
cd "$(dirname "$0")"
CLUSTER_ARN=arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod
SECRET_ARN=$(aws rds describe-db-clusters --region $R --db-cluster-identifier vitana-aurora-prod --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
echo "== 0/3 embeddings: column, non-empty, complete (the rest become NULL)"
aws rds-data execute-statement --region $R --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database vitana \
  --sql "SELECT 'ai_memory.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.ai_memory UNION ALL SELECT 'calendar_events.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.calendar_events UNION ALL SELECT 'dev_agent_memory.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.dev_agent_memory UNION ALL SELECT 'feedback_tickets.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.feedback_tickets UNION ALL SELECT 'mem_episodes.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.mem_episodes UNION ALL SELECT 'mem_facts.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.mem_facts UNION ALL SELECT 'memory_embeddings.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.memory_embeddings UNION ALL SELECT 'memory_facts.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.memory_facts UNION ALL SELECT 'memory_items.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.memory_items UNION ALL SELECT 'user_intents.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.user_intents UNION ALL SELECT 'user_intents.embedding_v2', count(embedding_v2), count(*) FILTER (WHERE embedding_v2::text LIKE '[%]') FROM public.user_intents UNION ALL SELECT 'vtid_ledger.embedding', count(embedding), count(*) FILTER (WHERE embedding::text LIKE '[%]') FROM public.vtid_ledger UNION ALL SELECT 'vtid_ledger.embedding_v2', count(embedding_v2), count(*) FILTER (WHERE embedding_v2::text LIKE '[%]') FROM public.vtid_ledger" --output text || echo "(report failed -- not blocking)"
echo "== 1/3 post-load"; bash aurora-run-sql.sh aurora-cutover-vector-postload.sql
echo "== 2/3 foreign keys"; bash aurora-run-sql.sh aurora-cutover-recreate-foreign-keys.sql
echo "== 3/3 views"; bash aurora-run-sql.sh aurora-cutover-schema-sync-views.sql
echo "ALL DONE"

# Routine: supabase-io-audit

**Schedule:** `0 6 * * *` (daily 06:00 UTC)
**Catalog row:** `routines.name = 'supabase-io-audit'`
**OASIS VTID for emitted events:** `VTID-02006`

## Autonomy contract

Daily probe of Supabase IO health. Reads three signals via direct Supabase REST and emits an OASIS event when any indicator exceeds the IO-playbook thresholds the April 2026 disk-IO crisis taught us. **No briefs.** Either the catalog tile is green or self-healing has been notified.

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | All three signals within thresholds. |
| 🟡 `partial` | At least one signal exceeded threshold → OASIS event emitted. |
| 🔴 `failure` | Routine itself errored (Supabase REST down). |

## Required environment (embedded as constants in the prompt)

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN` — for run lifecycle + OASIS ingest
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` — for the three queries below

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/supabase-io-audit/runs` with `X-Routine-Token`.

### 2. Three queries via Supabase REST

a. **Unused indexes** — read `pg_stat_user_indexes` for indexes with `idx_scan = 0` AND table size > 10 MB:
```
GET $SUPABASE_URL/rest/v1/rpc/exec_read_only_sql
B: { "sql": "SELECT schemaname, tablename, indexname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) as size FROM pg_stat_user_indexes JOIN pg_class ON pg_class.oid=indexrelid WHERE idx_scan=0 AND pg_relation_size(indexrelid) > 10*1024*1024 ORDER BY pg_relation_size(indexrelid) DESC LIMIT 20" }
```
If the `exec_read_only_sql` RPC doesn't exist, skip silently — it's optional. Use the `oasis_events` topic as a coarse proxy if so.

b. **Recent slow queries** — `pg_stat_statements` top-10 by `mean_exec_time` (if available).

c. **Table bloat / retention drift** — count `oasis_events` rows older than 7 days with `status='info'` (the retention cron should have pruned these):
```
GET $SUPABASE_URL/rest/v1/oasis_events?status=eq.info&created_at=lt.<7d_ago>&select=count
```

### 3. Threshold check

Trigger a partial / OASIS-event when ANY:
- Unused-index size sum > 500 MB
- Slow query mean_exec_time > 1000 ms
- Stale info-events count > 10 000 (retention cron broken)

### 4. Emit OASIS event (only if any threshold breached)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: {
  "vtid": "VTID-02006",
  "type": "database.io_pressure.daily_audit",
  "source": "routine.supabase-io-audit",
  "status": "warning",
  "message": "<one-line summary of breached thresholds>",
  "payload": { "unused_indexes":[…], "slow_queries":[…], "retention_drift": <int>, "thresholds_breached":[…] }
}
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| All thresholds within bounds | `success` | `"✅ Supabase IO healthy: N unused-idx OK, M slow OK, retention OK"` |
| Threshold breached | `partial` | `"⚠️ Supabase IO pressure: <kinds>. OASIS event emitted, self-healing notified."` |
| REST down | `failure` | `"❌ Could not read Supabase REST — see error"` |

`findings = { unused_indexes_size_mb, slow_query_top, retention_drift_count, breaches:[…], oasis_event_id }`

## Hard rules

- Read-only Supabase access. Never DROP, ALTER, DELETE.
- No briefs in findings. The audit log is forensics, not a queue.
- Plain `curl` only. Wall-clock cap 3 minutes.

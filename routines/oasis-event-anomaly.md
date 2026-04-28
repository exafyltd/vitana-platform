# Routine: oasis-event-anomaly

**Schedule:** `0 7 * * *` (daily 07:00 UTC)
**Catalog row:** `routines.name = 'oasis-event-anomaly'`
**OASIS VTID for emitted events:** `VTID-02006`

## Autonomy contract

Compares today's OASIS event topic distribution to the prior 7-day baseline. Surfaces:
- **Novel topics** — topics with ≥3 occurrences today that did not appear in the baseline window at all (often the leading indicator of a new failure class).
- **Spikes** — existing topics whose count today is ≥3σ above the per-topic baseline mean.

Emits a single OASIS event listing every anomaly so self-healing can decide whether to spawn investigations. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Today's distribution within baseline. No novel topics, no spikes. |
| 🟡 `partial` | Anomaly detected → OASIS event emitted. |
| 🔴 `failure` | Routine itself errored. |

## Required environment

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` (read `oasis_events`)

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/oasis-event-anomaly/runs` with `X-Routine-Token`.

### 2. Pull both windows from `oasis_events`

```
# Today (last 24h)
GET $SUPABASE_URL/rest/v1/oasis_events?created_at=gte.<24h_ago>&select=topic,status,created_at&limit=20000
# Baseline (8d to 1d ago)
GET $SUPABASE_URL/rest/v1/oasis_events?created_at=gte.<192h_ago>&created_at=lt.<24h_ago>&select=topic,status,created_at&limit=200000
```

If row counts hit the limit, paginate with `Range:` headers.

### 3. Build distributions

For each window, group by `topic` and compute count. For baseline, also compute per-topic daily mean and stddev (over 7 daily buckets).

### 4. Detect anomalies

```
novel_topics = today.keys() - baseline.keys() where today[topic] >= 3
spike_topics = topics where today[topic] >= baseline_daily_mean[topic] + 3 * baseline_daily_stddev[topic]
            AND today[topic] >= 5  (filter out tiny absolute counts)
```

If both lists are empty: STEP 4 skipped, summary = `"✅ OASIS distribution within baseline ({today_total} events vs {baseline_avg}/day avg)"`.

### 5. Emit OASIS event (only on anomaly)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: {
  "vtid": "VTID-02006",
  "type": "oasis.event_anomaly.daily",
  "source": "routine.oasis-event-anomaly",
  "status": "warning",
  "message": "Novel topics: {N}, spikes: {S}",
  "payload": {
    "novel_topics": [ { topic, count_today } ],
    "spikes":       [ { topic, count_today, baseline_mean, baseline_stddev, sigma_factor } ],
    "totals": { today_total, baseline_avg_per_day }
  }
}
```

### 6. Close run

| Outcome | status | summary |
|---|---|---|
| No anomaly | `success` | `"✅ OASIS distribution healthy: {today} events, no novel topics, no spikes"` |
| Anomaly | `partial` | `"⚠️ OASIS anomaly: {N} novel + {S} spikes. OASIS event emitted, self-healing notified."` |
| Read failed | `failure` | `"❌ Could not read oasis_events — see error"` |

`findings = { today_total, baseline_total, novel_topics, spikes, oasis_event_id }`

## Hard rules

- Read-only.
- One emitted event per run, even if multiple anomalies — the payload carries the full list.
- Wall-clock cap 3 minutes.

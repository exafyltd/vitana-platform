# Routine: oasis-event-anomaly

**Schedule:** `0 7 * * *` (daily 07:00 UTC)
**Catalog row:** `routines.name = 'oasis-event-anomaly'`
**OASIS VTID for emitted events:** `VTID-02006`

## Autonomy contract

Compares today's OASIS event topic distribution to the prior 7-day baseline using the gateway audit endpoint (no Supabase credentials in sandbox). Surfaces novel topics + spikes; emits a single OASIS event on any anomaly. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Today's distribution within baseline. |
| 🟡 `partial` | Anomaly detected → OASIS event emitted. |
| 🔴 `failure` | Routine itself errored. |

## Required environment

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN`

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/oasis-event-anomaly/runs`.

### 2. Read both windows

```
GET $GATEWAY_URL/api/v1/routines/audits/oasis-summary?window_hours=24
GET $GATEWAY_URL/api/v1/routines/audits/oasis-summary?window_hours=192&until_hours=24
```
Each returns `{ total_count, error_count, info_count, top_topics: [ { topic, count } ] }`.

### 3. Detect anomalies

Build maps `today_by_topic` and `baseline_by_topic` from `top_topics`.

```
novel_topics = [ topic in today_by_topic where today_by_topic[topic] >= 3 AND topic not in baseline_by_topic ]
spike_topics = []
for each topic where both windows have data:
  baseline_avg_per_day = baseline_by_topic[topic] / 7
  today_count = today_by_topic[topic]
  if today_count >= max(5, baseline_avg_per_day * 3):
    spike_topics.push({ topic, today_count, baseline_avg_per_day })
```

If both arrays empty: skip step 4, summary = `"✅ OASIS distribution healthy: {today_total} events, no novel topics, no spikes"`.

### 4. Emit OASIS event (only on anomaly)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-02006", type:"oasis.event_anomaly.daily",
     source:"routine.oasis-event-anomaly", status:"warning",
     message:"Novel: {N}, spikes: {S}",
     payload:{ novel_topics, spike_topics, today_total, baseline_total } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| No anomaly | `success` | `"✅ OASIS distribution healthy: {today_total} events"` |
| Anomaly | `partial` | `"⚠️ OASIS anomaly: {N} novel + {S} spikes. OASIS event emitted, self-healing notified."` |
| Audit endpoint down | `failure` | `"❌ /api/v1/routines/audits/oasis-summary unreachable — see error"` |

`findings = { today_total, baseline_total, novel_topics, spike_topics, oasis_event_id }`

## Hard rules

- Plain `curl` only.
- One OASIS event per run, payload carries the full list.
- Wall-clock cap 2 minutes.

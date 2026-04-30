# Routine: autopilot-rec-quality

**Schedule:** `30 6 * * *` (daily 06:30 UTC)
**Catalog row:** `routines.name = 'autopilot-rec-quality'`
**OASIS VTID for emitted events:** `VTID-02006`

## Autonomy contract

Reads pre-aggregated yesterday + 7-day-baseline metrics from the gateway audit endpoint (no Supabase credentials in the routine sandbox), checks for drift, emits an OASIS event on regression. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Recommendations are landing correctly. |
| 🟡 `partial` | Drift detected → OASIS event emitted. |
| 🔴 `failure` | Routine itself errored. |

## Required environment

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN`

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/autopilot-rec-quality/runs`.

### 2. Read aggregations

```
GET $GATEWAY_URL/api/v1/routines/audits/autopilot-recs
H:  X-Routine-Token: $ROUTINE_INGEST_TOKEN
→ {
  ok: true,
  yesterday: { total, null_pillar_count, null_pillar_rate, by_pillar, accepted, dismissed, snoozed, acceptance_rate, actions_total },
  baseline_window: <same shape over 7d>,
  baseline_avg_per_day: { total, accepted, dismissed, snoozed }
}
```

### 3. Drift check

```
drift_kinds = []
if yesterday.null_pillar_rate > 0.10: drift_kinds.push('null_pillar')
if baseline.acceptance_rate && yesterday.acceptance_rate &&
   yesterday.acceptance_rate < baseline.acceptance_rate * 0.5: drift_kinds.push('acceptance_collapse')
if baseline_avg_per_day.total > 0 &&
   yesterday.total < baseline_avg_per_day.total * 0.3: drift_kinds.push('volume_collapse')
```

### 4. Emit OASIS event (only if drift)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-02006", type:"autopilot.recommendations.quality_drift",
     source:"routine.autopilot-rec-quality", status:"warning",
     message:"<drift_kinds>", payload:{ yesterday, baseline_avg_per_day, drift_kinds } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| No drift | `success` | `"✅ Autopilot recs healthy: {total} recs, {acceptance}% accepted, {null_pillar}% missing pillar"` |
| Drift | `partial` | `"⚠️ Autopilot drift: <drift_kinds>. OASIS event emitted, self-healing notified."` |
| Audit endpoint down | `failure` | `"❌ /api/v1/routines/audits/autopilot-recs unreachable — see error"` |

`findings = { yesterday, baseline_avg_per_day, drift_kinds, oasis_event_id }`

## Hard rules

- Plain `curl` only.
- No briefs.
- Wall-clock cap 2 minutes.

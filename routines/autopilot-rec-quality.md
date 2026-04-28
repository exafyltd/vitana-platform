# Routine: autopilot-rec-quality

**Schedule:** `30 6 * * *` (daily 06:30 UTC)
**Catalog row:** `routines.name = 'autopilot-rec-quality'`
**OASIS VTID for emitted events:** `VTID-02006`

## Autonomy contract

Samples yesterday's autopilot recommendations across all users, audits pillar-tag accuracy and acceptance metrics vs the prior 7-day baseline, and emits an OASIS event when drift exceeds thresholds. **No briefs.** Either the tile is green or self-healing is notified.

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Recommendations are landing correctly. |
| 🟡 `partial` | Drift detected → OASIS event emitted. |
| 🔴 `failure` | Routine itself errored. |

## Required environment

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` (for direct Supabase reads of `autopilot_recommendations` / `autopilot_recommendation_actions`)

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/autopilot-rec-quality/runs` with `X-Routine-Token`.

### 2. Pull yesterday's recs + actions

```
GET $SUPABASE_URL/rest/v1/autopilot_recommendations?created_at=gte.<24h_ago>&select=id,pillar_tag,recommendation_text,priority,created_at&limit=500
GET $SUPABASE_URL/rest/v1/autopilot_recommendation_actions?created_at=gte.<24h_ago>&select=recommendation_id,action,created_at&limit=2000
```

Compute:
- `total_recs_yesterday`
- `acceptance_rate = accepted / (accepted + dismissed + snoozed)`
- `pillar_distribution` (counts by pillar_tag)
- `null_pillar_rate` (% of recs with `pillar_tag IS NULL`)

### 3. Pull baseline (8d-1d ago)

Same queries with `created_at=gte.<192h_ago>&created_at=lt.<24h_ago>`. Compute baseline averages.

### 4. Drift check

Trigger a partial / OASIS-event when ANY:
- `null_pillar_rate_yesterday > 0.10` (more than 10% of recs missing a pillar tag)
- `acceptance_rate_yesterday < acceptance_rate_baseline * 0.5` (acceptance halved)
- `total_recs_yesterday < total_recs_baseline_avg * 0.3` (rec engine collapsed)

### 5. Emit OASIS event (only if drift)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: {
  "vtid": "VTID-02006",
  "type": "autopilot.recommendations.quality_drift",
  "source": "routine.autopilot-rec-quality",
  "status": "warning",
  "message": "<drift kind summary>",
  "payload": { "yesterday":{…}, "baseline":{…}, "drift_kind":"null_pillar"|"acceptance_collapse"|"volume_collapse" }
}
```

### 6. Close run

| Outcome | status | summary |
|---|---|---|
| No drift | `success` | `"✅ Autopilot recs healthy: {total_recs} recs, {acceptance}% accepted, {null_rate}% missing pillar"` |
| Drift | `partial` | `"⚠️ Autopilot drift: <kind>. OASIS event emitted, self-healing notified."` |
| Supabase down | `failure` | `"❌ Could not read autopilot_recommendations — see error"` |

`findings = { yesterday, baseline, drift_kinds, oasis_event_id }`

## Hard rules

- Read-only. Never INSERT/UPDATE/DELETE on autopilot tables.
- No briefs in findings.
- Wall-clock cap 3 minutes.

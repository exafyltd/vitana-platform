# Routine: vitana-index-health

**Schedule:** `30 7 * * *` (daily 07:30 UTC)
**Catalog row:** `routines.name = 'vitana-index-health'`
**OASIS VTID for emitted events:** `VTID-02006`

## Autonomy contract

Audits whether the Vitana Index daily computation is keeping up with active users. Reads `vitana_index_scores` for the last 24h and compares against `app_users` activity. Emits an OASIS event when the computation falls behind. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Index computation healthy: ≥90% of active users have a fresh score, low pillar nullity. |
| 🟡 `partial` | Computation degraded → OASIS event emitted. |
| 🔴 `failure` | Routine itself errored. |

## Required environment

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/vitana-index-health/runs` with `X-Routine-Token`.

### 2. Pull active-user count

Active = users with at least one event in the last 7 days, signal of "real" usage. Use whatever proxy is cheapest:
```
GET $SUPABASE_URL/rest/v1/oasis_events?created_at=gte.<168h_ago>&select=actor_id&limit=100000
# Distinct actor_ids from the response
```

### 3. Pull today's `vitana_index_scores`

```
GET $SUPABASE_URL/rest/v1/vitana_index_scores?created_at=gte.<24h_ago>&select=user_id,overall,nutrition,hydration,exercise,sleep,mental,balance_factor,created_at&limit=10000
```

Compute:
- `users_with_fresh_score` (distinct user_id)
- `coverage_rate = users_with_fresh_score / active_users`
- `pillar_nullity_rate` = % of rows where any of the 5 pillar columns is NULL
- `balance_factor_p50` (median balance factor — sanity-check on the new 5-pillar shape)

### 4. Phase E migration readiness probe

`GET $SUPABASE_URL/rest/v1/vitana_index_config?select=name,value` — does the runtime tuning table exist with sensible values? (Phase E added it.) If the table or expected rows are missing → flag as `phase_e_pending` in the findings.

### 5. Threshold check

Trigger partial / OASIS-event when ANY:
- `coverage_rate < 0.90` (more than 10% of active users have a stale Index)
- `pillar_nullity_rate > 0.05` (more than 5% of fresh rows have a null pillar)
- `vitana_index_config` table missing entirely (Phase E migration regressed)

### 6. Emit OASIS event (only if degraded)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: {
  "vtid": "VTID-02006",
  "type": "vitana_index.computation.degraded",
  "source": "routine.vitana-index-health",
  "status": "warning",
  "message": "Index coverage {C}%, pillar-null {N}%, phase_e_pending={P}",
  "payload": { "coverage_rate", "pillar_nullity_rate", "balance_factor_p50", "phase_e_pending":bool, "thresholds_breached":[…] }
}
```

### 7. Close run

| Outcome | status | summary |
|---|---|---|
| Healthy | `success` | `"✅ Vitana Index healthy: {C}% coverage, {N}% null pillars, balance p50 {B}"` |
| Degraded | `partial` | `"⚠️ Vitana Index degraded: <kind>. OASIS event emitted, self-healing notified."` |
| Read failed | `failure` | `"❌ Could not read vitana_index_scores — see error"` |

`findings = { active_users, coverage_rate, pillar_nullity_rate, balance_factor_p50, phase_e_pending, breaches:[…], oasis_event_id }`

## Hard rules

- Read-only.
- No briefs.
- Wall-clock cap 3 minutes.

# Routine: vitana-index-health

**Schedule:** `30 7 * * *` (daily 07:30 UTC)
**Catalog row:** `routines.name = 'vitana-index-health'`
**OASIS VTID for emitted events:** `VTID-02006`

## Autonomy contract

Reads pre-aggregated active-vs-fresh-Index metrics from the gateway audit endpoint (no Supabase credentials in the sandbox). Emits an OASIS event when the Index computation falls behind active-user count or pillar nullity exceeds threshold. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Index coverage ≥90% of active users, low nullity, Phase E config present. |
| 🟡 `partial` | Computation degraded → OASIS event emitted. |
| 🔴 `failure` | Routine itself errored. |

## Required environment

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN`

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/vitana-index-health/runs`.

### 2. Read aggregations

```
GET $GATEWAY_URL/api/v1/routines/audits/vitana-index
H:  X-Routine-Token: $ROUTINE_INGEST_TOKEN
→ {
  ok: true,
  active_users, fresh_score_users, coverage_rate,
  pillar_nullity_rate, balance_factor_p50,
  fresh_rows_total, phase_e_pending
}
```

### 3. Threshold check

```
breach_kinds = []
if coverage_rate != null && coverage_rate < 0.90: breach_kinds.push('coverage_below_90')
if pillar_nullity_rate > 0.05:                    breach_kinds.push('pillar_nullity_high')
if phase_e_pending === true:                      breach_kinds.push('phase_e_pending')
```

### 4. Emit OASIS event (only if breach)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-02006", type:"vitana_index.computation.degraded",
     source:"routine.vitana-index-health", status:"warning",
     message:"<breach kinds>", payload:{ active_users, coverage_rate, pillar_nullity_rate, phase_e_pending, breach_kinds } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| Healthy | `success` | `"✅ Vitana Index healthy: {coverage}% coverage, {nullity}% null pillars, balance p50 {p50}"` |
| Degraded | `partial` | `"⚠️ Vitana Index degraded: <breach_kinds>. OASIS event emitted, self-healing notified."` |
| Audit endpoint down | `failure` | `"❌ /api/v1/routines/audits/vitana-index unreachable — see error"` |

`findings = { active_users, fresh_score_users, coverage_rate, pillar_nullity_rate, balance_factor_p50, phase_e_pending, breach_kinds, oasis_event_id }`

## Hard rules

- Plain `curl` only.
- No briefs.
- Wall-clock cap 2 minutes.

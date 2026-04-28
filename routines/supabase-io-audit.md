# Routine: supabase-io-audit

**Schedule:** `0 6 * * *` (daily 06:00 UTC)
**Catalog row:** `routines.name = 'supabase-io-audit'`
**OASIS VTID for emitted events:** `VTID-02006`

## Autonomy contract

Reads three IO-pressure signals via the gateway audit endpoint (server-side aggregation — no Supabase credentials in the routine sandbox). Emits an OASIS event when any breaches threshold. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | All three signals within thresholds. |
| 🟡 `partial` | Threshold breached → OASIS event emitted, self-healing notified. |
| 🔴 `failure` | Routine itself errored. |

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN` (embedded — same gate as the existing routine ingest)

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/supabase-io-audit/runs` with `X-Routine-Token`.

### 2. Read aggregated signals

```
GET $GATEWAY_URL/api/v1/routines/audits/io-pressure
H:  X-Routine-Token: $ROUTINE_INGEST_TOKEN
→ { ok: true, retention_drift_count, today_count, baseline_avg_per_day }
```

### 3. Threshold check

```
breach_kinds = []
if retention_drift_count > 10000: breach_kinds.push('retention_drift')   // info-events older than 7d should have been pruned
if today_count > baseline_avg_per_day * 2: breach_kinds.push('volume_spike')
if today_count < baseline_avg_per_day * 0.3: breach_kinds.push('volume_collapse')
```

### 4. Emit OASIS event (only if breach)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-02006", type:"database.io_pressure.daily_audit", source:"routine.supabase-io-audit",
     status:"warning", message:"<breach kinds>",
     payload:{ retention_drift_count, today_count, baseline_avg_per_day, breach_kinds } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| No breach | `success` | `"✅ Supabase IO healthy: retention OK, volume {today}/{baseline}/day"` |
| Breach | `partial` | `"⚠️ Supabase IO pressure: <breach_kinds>. OASIS event emitted, self-healing notified."` |
| Audit endpoint down | `failure` | `"❌ /api/v1/routines/audits/io-pressure unreachable — see error"` |

`findings = { retention_drift_count, today_count, baseline_avg_per_day, breach_kinds, oasis_event_id }`

## Hard rules

- Plain `curl` only. No DB credentials in the sandbox.
- No briefs.
- Wall-clock cap 2 minutes.

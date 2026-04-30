# Routine: voice-lab-triage

**Schedule:** `30 4 * * *` (daily 04:30 UTC, scheduler jitter pads to ~04:38)
**Catalog row:** `routines.name = 'voice-lab-triage'`
**OASIS VTID for emitted events:** `VTID-01155` (canonical voice VTID)

## Autonomy contract

Reads the last 24h of ORB Live sessions, clusters error patterns vs the 7-day baseline, and **emits an OASIS event** (`topic = voice.live.regression.daily_triage`) when a regression is detected so the existing voice self-healing loop picks it up. **No briefs for human review.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | No regression, error rate within baseline. Nothing to do. |
| 🟡 `partial` | Regression detected → OASIS event emitted → self-healing now investigating. |
| 🔴 `failure` | Routine itself errored (voice-lab API down, gateway 5xx, etc.). |

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN` (embedded in the routine prompt)

## Steps

### 1. Open the run record

```
POST $GATEWAY_URL/api/v1/routines/voice-lab-triage/runs
H: X-Routine-Token: $ROUTINE_INGEST_TOKEN
B: { "trigger": "cron" }
→ { ok: true, run: { id: "<run_id>" } }
```

### 2. Fetch yesterday + the 7-day baseline

```
# Yesterday (last 24h)
GET $GATEWAY_URL/api/v1/voice-lab/live/sessions?status=ended&since_hours=24
→ { sessions: [ { session_id, started_at, ended_at, error_count, error_codes, platform, ... } ] }

# Baseline (8d to 1d ago — the prior 7-day window, NOT including yesterday)
GET $GATEWAY_URL/api/v1/voice-lab/live/sessions?status=ended&since_hours=192&until_hours=24
```

### 3. Cluster + compare

For yesterday and baseline, compute:
- `total_sessions`
- `error_sessions` (sessions with `error_count > 0`)
- `error_rate = error_sessions / total_sessions`
- `top_error_codes` (count by error_code, top 5)
- `novel_error_codes` (codes in yesterday NOT seen in baseline)

A **regression** is any of:
- `error_rate_yesterday > error_rate_baseline * 1.5` AND `error_sessions_yesterday >= 3`
- `novel_error_codes.length > 0` AND that novel code appeared in `>= 3` yesterday sessions
- `total_sessions_yesterday < total_sessions_baseline_avg * 0.3` (collapse — voice barely used, possible outage)

### 4. If regression detected — emit OASIS event

```
POST $GATEWAY_URL/api/v1/events/ingest
B: {
  "vtid": "VTID-01155",
  "type": "voice.live.regression.daily_triage",
  "source": "routine.voice-lab-triage",
  "status": "warning",
  "message": "Voice regression detected: <one-line summary>",
  "payload": {
    "yesterday": { "total_sessions", "error_sessions", "error_rate", "top_error_codes", "novel_error_codes" },
    "baseline":  { "total_sessions", "error_sessions", "error_rate", "top_error_codes" },
    "regression_kind": "error_rate_spike" | "novel_error_codes" | "session_collapse"
  }
}
```

### 5. Close the run

`PATCH $GATEWAY_URL/api/v1/routines/voice-lab-triage/runs/{run_id}` with `X-Routine-Token`.

| Outcome | status | summary |
|---|---|---|
| No regression | `success` | `"✅ Voice healthy: X sessions, Y errors, error rate Z% (within baseline)"` |
| Regression detected | `partial` | `"⚠️ Voice regression: <kind>. OASIS event emitted, self-healing notified."` |
| Voice-lab API down | `failure` | `"❌ Could not read voice-lab/live/sessions — see error."` |

`findings` = the comparison object plus `oasis_event_id` if one was emitted.

## Hard rules

- Never produce briefs. The findings JSON is forensics — green tile means no further reading needed.
- Always end with PATCH (success / partial / failure). Never leave a run in `running`.
- Plain `curl` only. Wall-clock cap 5 minutes.

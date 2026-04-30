# Routine: orb-audio-smoke

**Schedule:** `0 8 * * *` (daily 08:00 UTC)
**Catalog row:** `routines.name = 'orb-audio-smoke'`
**OASIS VTID for emitted events:** `VTID-01155` (canonical voice VTID)

## Autonomy contract

Daily probe of `/api/v1/orb/health` to confirm Vertex AI Live API is wired up correctly. Same three checks the `EXEC-DEPLOY` hard-gate runs on every deploy — but daily and independent of any deploy event. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | All three checks pass: `gemini_live.enabled === true`, `vertex_project_id` non-empty, `google_auth_ready === true`. |
| 🟡 `partial` | At least one check failed → OASIS event emitted, voice self-healing notified. |
| 🔴 `failure` | `/api/v1/orb/health` itself unreachable. |

## Required environment

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN`

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/orb-audio-smoke/runs`.

### 2. Probe ORB health
`GET $GATEWAY_URL/api/v1/orb/health`
→ `{ ok, gemini_live: { enabled }, vertex_project_id, google_auth_ready, ... }`

### 3. Three checks

```
breach_kinds = []
if gemini_live.enabled !== true:           breach_kinds.push('gemini_live_disabled')
if !vertex_project_id || vertex_project_id === '':  breach_kinds.push('vertex_project_id_missing')
if google_auth_ready !== true:             breach_kinds.push('google_auth_not_ready')
```

### 4. Emit OASIS event (only on breach)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-01155", type:"orb.live.smoke.regression",
     source:"routine.orb-audio-smoke", status:"warning",
     message:"<breach kinds>", payload:{ checks: { gemini_live_enabled, vertex_project_id, google_auth_ready }, breach_kinds } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| All checks pass | `success` | `"✅ ORB audio pipeline healthy: gemini_live + vertex + google_auth all green"` |
| Breach | `partial` | `"⚠️ ORB audio breach: <breach_kinds>. OASIS event emitted, self-healing notified."` |
| Health endpoint down | `failure` | `"❌ /api/v1/orb/health unreachable — see error"` |

`findings = { gemini_live_enabled, vertex_project_id, google_auth_ready, breach_kinds, oasis_event_id }`

## Hard rules

- Plain `curl` only. Wall-clock cap 1 minute.
- No briefs.

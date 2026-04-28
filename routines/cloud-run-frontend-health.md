# Routine: cloud-run-frontend-health

**Schedule:** `30 8 * * *` (daily 08:30 UTC)
**Catalog row:** `routines.name = 'cloud-run-frontend-health'`
**OASIS VTID for emitted events:** `VTID-02017`

## Autonomy contract

Daily smoke of the Cloud Run gateway and the community-app preview URL. Catches silent deploy failures and CDN propagation issues that wouldn't trigger any other routine. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | All three URLs return 2xx and the gateway `/alive` payload looks healthy. |
| 🟡 `partial` | At least one URL not 2xx → OASIS event emitted. |
| 🔴 `failure` | Routine itself errored (network unreachable from sandbox). |

## Required environment

- `GATEWAY_URL`, `ROUTINE_INGEST_TOKEN`

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/cloud-run-frontend-health/runs`.

### 2. Probe three surfaces

| URL | Acceptance |
|---|---|
| `https://gateway-q74ibpv6ia-uc.a.run.app/alive` | 200 + body contains `"ok"` or `"alive"` |
| `https://community-app-q74ibpv6ia-uc.a.run.app/` | 200 + content-type starts with `text/html` |
| `https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/routines` | 200 + `body.ok === true` (proves the routines stack itself is live) |

For each one capture: http_code, content_type, body length, latency_ms.

### 3. Compute breach list

```
breach_kinds = []
for each surface:
  if http_code is not 2xx: breach_kinds.push('<surface_name>_unreachable_' + http_code)
  if expected body shape mismatch: breach_kinds.push('<surface_name>_body_unexpected')
```

### 4. Emit OASIS event (only on breach)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-02017", type:"cloud_run.health.degraded",
     source:"routine.cloud-run-frontend-health", status:"warning",
     message:"<breach_kinds>", payload:{ surfaces: [ { name, http_code, latency_ms } ], breach_kinds } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| All 2xx | `success` | `"✅ All 3 surfaces healthy: gateway + community-app + routines API"` |
| Breach | `partial` | `"⚠️ Cloud Run breach: <breach_kinds>. OASIS event emitted, self-healing notified."` |
| Network error before any probe | `failure` | `"❌ Routine sandbox cannot reach internet — see error"` |

`findings = { surfaces: [ { name, url, http_code, latency_ms, content_type, body_snippet } ], breach_kinds, oasis_event_id }`

## Hard rules

- Plain `curl` only.
- Wall-clock cap 1 minute.
- No briefs.

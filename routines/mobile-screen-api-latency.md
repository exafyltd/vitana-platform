# Routine: mobile-screen-api-latency

**Schedule:** `30 */4 * * *` (every 4 hours)
**Catalog row:** `routines.name = 'mobile-screen-api-latency'`
**OASIS VTID for emitted events:** `VTID-03177` (screen-latency telemetry cluster)

> ⚠️ **Governance:** Part of the mobile-loading test-program cluster. Confirm
> the catalog row + VTID are allocated before activating.

## Autonomy contract

Separates "slow screen" from "slow data". A screen can paint fast yet still
*feel* slow because its primary data fetch is the bottleneck. `supabase-io-audit`
only watches global DB pressure — it can't tell you the **Events** list query is
slow while everything else is fine. This routine times each screen's primary
data endpoint and emits a breach when one is slow. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Every tracked endpoint responds within latency budget. |
| 🟡 `partial` | An endpoint over budget (or non-2xx) → OASIS event emitted, self-healing notified. |
| 🔴 `failure` | Routine itself errored before timing any endpoint. |

## Tracked endpoints & budgets

Each screen's primary data call (server-timed, p1 sample). Replace the paths
below with the canonical gateway endpoint each screen calls if it drifts — the
routine reads this table as its source of truth.

| Screen | Primary endpoint (gateway) | p95 budget (ms) |
|---|---|---|
| Events | `GET /api/v1/community/events?limit=20` | 800 |
| Find a Match | `GET /api/v1/intents/matches?limit=20` | 1000 |
| Chat History | `GET /api/v1/inbox/threads?limit=20` | 800 |
| My Journey | `GET /api/v1/autopilot/summary` | 1000 |
| Settings | `GET /api/v1/settings/overview` | 600 |
| Memory | `GET /api/v1/memory/timeline?limit=20` | 1000 |
| Media Lab | `GET /api/v1/community/media-hub?limit=20` | 900 |
| Live Rooms | `GET /api/v1/live/rooms?status=active` | 900 |
| User Profile | `GET /api/v1/profile/me` | 700 |

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN`
- `ROUTINE_PROBE_JWT` — a low-privilege service token for the authenticated
  read endpoints. Endpoints that 401 without it are recorded as `auth_required`,
  not a latency breach.

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/mobile-screen-api-latency/runs`.

### 2. Time each endpoint

For each row: `curl -w '%{http_code} %{time_starttransfer} %{time_total}'`
against `$GATEWAY_URL<path>` with `Authorization: Bearer $ROUTINE_PROBE_JWT`.
Capture `http_code`, `ttfb_ms` (`time_starttransfer`), `total_ms` (`time_total`).
Take 3 samples per endpoint; use the worst (p-of-3 ≈ p95 proxy).

### 3. Compute breach list

```
breached = []
for each endpoint:
  if http_code not in 2xx and http_code != 401: breached.push({ route, kind:'http_'+http_code })
  if http_code in 2xx and total_ms > budget:    breached.push({ route, kind:'slow', total_ms, budget })
```

### 4. Emit OASIS event (only if breach)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-03177", type:"mobile.screen.api_slow",
     source:"routine.mobile-screen-api-latency", status:"warning",
     message:"<N> screen data endpoints slow/erroring",
     payload:{ breached, results:[ { route, endpoint, http_code, ttfb_ms, total_ms, budget } ] } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| All within budget | `success` | `"✅ All 9 screen data endpoints within latency budget"` |
| Breach | `partial` | `"⚠️ {N} endpoints slow/erroring: <routes>. OASIS event emitted."` |
| Probe error | `failure` | `"❌ API latency probe could not run — see error"` |

`findings = { results, breached, oasis_event_id }`

## Hard rules

- Read-only GETs only. Never POST/PATCH against a screen's data endpoint.
- Low-privilege probe JWT only — never the service role.
- One OASIS event per run; payload carries every endpoint's numbers.
- Wall-clock cap 2 minutes.
- No briefs.

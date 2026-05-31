# Routine: mobile-screen-latency-rollup

**Schedule:** `15 6 * * *` (daily 06:15 UTC)
**Catalog row:** `routines.name = 'mobile-screen-latency-rollup'`
**OASIS VTID for emitted events:** `VTID-03177` (screen-latency telemetry cluster)

> ⚠️ **Governance:** This routine is part of the mobile-loading test-program
> cluster. Confirm the catalog row + VTID are allocated before activating it
> in the scheduler.

## Autonomy contract

Turns the passive RUM firehose into per-screen signal. The `rum-beacon`
receiver is a *thin pipe* — it writes every Core Web Vital as a
`screen.latency.measured` event and explicitly does **no aggregation**. This
routine reads the server-side rollup, compares each of the 9 complained-about
mobile screens against its budget, and emits a single OASIS event listing the
screens that breach. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Every tracked screen's p75 within budget (or no traffic yet). |
| 🟡 `partial` | At least one screen breaches p75 budget → OASIS event emitted, self-healing notified. |
| 🔴 `failure` | Routine itself errored (audit endpoint unreachable). |

## Tracked screens & budgets

Budgets are the real-user p75 thresholds (ms) from `vitana-v1/src/lib/rum.ts`.
A screen breaches when its **p75 ≥ the "poor" cut** for any metric.

| Screen | Route (RUM `screen`) | LCP poor | TTFB poor | FCP poor | INP poor |
|---|---|---|---|---|---|
| Events | `/comm/events-meetups` | 4000 | 1800 | 3000 | 500 |
| Find a Match | `/comm/find-partner` | 4000 | 1800 | 3000 | 500 |
| Chat History | `/inbox` | 4000 | 1800 | 3000 | 500 |
| My Journey | `/autopilot` | 4000 | 1800 | 3000 | 500 |
| Settings | `/settings` | 4000 | 1800 | 3000 | 500 |
| Memory | `/memory` | 4000 | 1800 | 3000 | 500 |
| Media Lab | `/comm/media-hub` | 4000 | 1800 | 3000 | 500 |
| Live Rooms | `/comm/live-rooms` | 4000 | 1800 | 3000 | 500 |
| User Profile | `/me/profile` | 4000 | 1800 | 3000 | 500 |

CLS uses the unitless `[0.1, 0.25]` band; a screen also breaches when its
p75 CLS ≥ `0.25`.

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN`

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/mobile-screen-latency-rollup/runs` with `X-Routine-Token`.

### 2. Read the rollup

```
GET $GATEWAY_URL/api/v1/routines/audits/mobile-screen-latency?window_hours=24
H:  X-Routine-Token: $ROUTINE_INGEST_TOKEN
→ { ok: true, window_hours, sample_size,
    screens: [ { screen, samples,
                 metrics: { LCP: { p75, p95, count, worst_rating }, ... } } ] }
```

If `sample_size === 0`: telemetry is dark or no traffic yet → skip step 4,
summary = `"✅ No mobile latency samples in window — telemetry dark or quiet"`.

### 3. Threshold check (per tracked screen)

```
POOR = { LCP:4000, TTFB:1800, FCP:3000, INP:500, CLS:0.25 }
breached_screens = []
for each tracked screen in the table above:
  row = screens.find(s => s.screen === route)
  if not row: continue                      // no samples this window
  breaches = []
  for metric, p75 in row.metrics:
    if p75 != null and p75 >= POOR[metric]: breaches.push({ metric, p75, count })
  if breaches: breached_screens.push({ screen: route, breaches })
```

### 4. Emit OASIS event (only if breaches)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-03177", type:"mobile.screen.slow",
     source:"routine.mobile-screen-latency-rollup", status:"warning",
     message:"<N> mobile screens over budget: <screen list>",
     payload:{ window_hours:24, breached_screens, sample_size } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| No breach | `success` | `"✅ All 9 mobile screens within p75 budget ({sample_size} samples)"` |
| Breach | `partial` | `"⚠️ {N} mobile screens slow: <routes>. OASIS event emitted, self-healing notified."` |
| Audit endpoint down | `failure` | `"❌ /api/v1/routines/audits/mobile-screen-latency unreachable — see error"` |

`findings = { sample_size, breached_screens, oasis_event_id }`

## Hard rules

- Plain `curl` only. No Supabase credentials in the sandbox.
- One OASIS event per run, payload carries the full breach list.
- Wall-clock cap 2 minutes.
- No briefs.

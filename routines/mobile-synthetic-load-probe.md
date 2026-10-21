# Routine: mobile-synthetic-load-probe

**Schedule:** `0 */6 * * *` (every 6 hours)
**Catalog row:** `routines.name = 'mobile-synthetic-load-probe'`
**OASIS VTID for emitted events:** `VTID-03177` (screen-latency telemetry cluster)

> ⚠️ **Governance:** Part of the mobile-loading test-program cluster. Confirm
> the catalog row + VTID are allocated before activating.

## Autonomy contract

Synthetic prevention. Real-user RUM (the rollup routine) only fires *after*
users have already suffered a slow screen. This routine loads each of the 9
complained-about mobile screens in a throttled mobile profile **on a schedule**
and catches a regression before it reaches users. The existing
`cloud-run-frontend-health` routine only pings 3 backend URLs — it never loads
an actual screen, so a bloated route chunk is invisible to it. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Every screen loads within budget under throttle. |
| 🟡 `partial` | At least one screen over budget → OASIS event emitted, self-healing notified. |
| 🔴 `failure` | Probe harness itself errored (browser launch / network). |

## What it measures

Each screen is loaded in an **iPhone-14 viewport, Slow-4G + 4× CPU throttle**
(matches `e2e/playwright.config.ts` `mobileIPhone`). Per screen capture:
`ttfb_ms`, `fcp_ms`, `lcp_ms`, `dom_content_loaded_ms`, `load_ms`,
`transfer_bytes`.

| Screen | Route | LCP budget (throttled) | TTI/load budget |
|---|---|---|---|
| Events | `/comm/events-meetups` | 4000 | 6000 |
| Find a Match | `/comm/find-partner` | 4000 | 6000 |
| Chat History | `/inbox` | 4000 | 6000 |
| My Journey | `/autopilot` | 4000 | 6000 |
| Settings | `/settings` | 4000 | 6000 |
| Memory | `/memory` | 4000 | 6000 |
| Media Lab | `/comm/media-hub` | 4500 | 7000 |
| Live Rooms | `/comm/live-rooms` | 4500 | 7000 |
| User Profile | `/me/profile` | 4000 | 6000 |

> Media Lab and Live Rooms carry media players, so they get a slightly looser
> budget. Tighten as those routes are optimized.

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `COMMUNITY_URL` = `https://vitanaland.com`
- `ROUTINE_INGEST_TOKEN`
- Playwright (chromium) available in the sandbox. The probe reuses the harness
  in `vitana-v1` (`scripts/mobile-perf-probe.mjs`) when run from that repo, or
  any headless-chromium runner that reports Navigation/Paint Timing.

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/mobile-synthetic-load-probe/runs`.

### 2. Probe each screen

For each route in the table:
- Launch chromium, mobile viewport, Slow-4G + 4× CPU.
- `goto($COMMUNITY_URL + route)`, `waitUntil: 'load'`, cap 20 s.
- Read `performance.getEntriesByType('navigation')[0]` and `'paint'` for
  `responseStart` (TTFB), `first-contentful-paint`, `domContentLoadedEventEnd`,
  `loadEventEnd`; read `largest-contentful-paint` via PerformanceObserver.

### 3. Compute breach list

```
breached = []
for each screen result:
  if lcp_ms  > lcp_budget:  breached.push({ route, metric:'LCP',  value:lcp_ms,  budget:lcp_budget })
  if load_ms > load_budget: breached.push({ route, metric:'LOAD', value:load_ms, budget:load_budget })
  if nav failed / timed out: breached.push({ route, metric:'TIMEOUT', value:20000 })
```

### 4. Emit OASIS event (only if breach)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-03177", type:"mobile.screen.synthetic_slow",
     source:"routine.mobile-synthetic-load-probe", status:"warning",
     message:"<N> screens over synthetic budget under throttle",
     payload:{ throttle:"slow4g+4xcpu", breached, results:[ { route, ttfb_ms, fcp_ms, lcp_ms, load_ms, transfer_bytes } ] } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| All within budget | `success` | `"✅ All 9 mobile screens load within throttled budget"` |
| Breach | `partial` | `"⚠️ {N} screens over synthetic budget: <routes>. OASIS event emitted."` |
| Harness error | `failure` | `"❌ Synthetic probe could not run — see error"` |

`findings = { results, breached, oasis_event_id }`

## Hard rules

- Read-only navigation — never authenticates as a real user or mutates state.
- One OASIS event per run, payload carries every screen's numbers (not just breaches).
- Wall-clock cap 5 minutes (9 screens × throttled load).
- No briefs.

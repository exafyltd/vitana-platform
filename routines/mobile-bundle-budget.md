# Routine: mobile-bundle-budget

**Schedule:** post-build (CI) + daily `45 6 * * *` safety net
**Catalog row:** `routines.name = 'mobile-bundle-budget'`
**OASIS VTID for emitted events:** `VTID-03177` (screen-latency telemetry cluster)

> ⚠️ **Governance:** Part of the mobile-loading test-program cluster. Confirm
> the catalog row + VTID are allocated before activating.

## Autonomy contract

Root-cause attribution for slow first paint. Every one of the 9 screens is a
`lazy()` route chunk in `vitana-v1/src/App.tsx`, so a screen's first-paint cost
is dominated by the JS its chunk pulls in. When a screen suddenly gets slow,
the usual cause is a chunk that ballooned (a heavy import leaked into the route
split). Nothing checks chunk weight today. This routine reads the Vite build
manifest, attributes a transfer-weight budget to each tracked route, and emits
a breach when a route's chunk graph exceeds it. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Every tracked route's chunk graph within budget. |
| 🟡 `partial` | A route over its gzip budget → OASIS event emitted, self-healing notified. |
| 🔴 `failure` | Manifest missing / unparseable (build artifact not produced). |

## Budgets (gzipped JS, per route entry + its imported chunks)

| Screen | Lazy chunk (App.tsx) | Budget (gzip KB) |
|---|---|---|
| Events | `EventsAndMeetups` | 180 |
| Find a Match | intents/match | 180 |
| Chat History | `GroupChat` | 200 |
| My Journey | `autopilot` | 200 |
| Settings | `MobileSettings` | 150 |
| Memory | `Memory` | 180 |
| Media Lab | `media-hub` | 240 |
| Live Rooms | `LiveRooms` | 260 |
| User Profile | `Profile` | 200 |

> Shared vendor chunks (react, router, query) are counted **once** against a
> global `vendor` budget of `350` KB gzip, not per route, so a route's number
> reflects only its own marginal weight.

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN`
- A produced build: `vitana-v1/dist/.vite/manifest.json` (Vite emits this with
  `build.manifest = true`). In CI this runs right after `npm run build`.

## Steps

### 1. Open run
`POST $GATEWAY_URL/api/v1/routines/mobile-bundle-budget/runs`.

### 2. Resolve each route's chunk graph

From `dist/.vite/manifest.json`, find the entry for each lazy chunk above, then
walk its `imports[]` transitively (excluding the shared vendor chunks) and sum
the gzipped size of every file in the graph.

```
for each tracked route:
  files = closure(manifest, entry) minus vendor_chunks
  route_gzip_kb = sum(gzipSize(dist/<file>)) / 1024
```

### 3. Compute breach list

```
breached = []
for each route: if route_gzip_kb > budget: breached.push({ route, route_gzip_kb, budget })
if vendor_gzip_kb > 350: breached.push({ route:'<vendor>', route_gzip_kb:vendor_gzip_kb, budget:350 })
```

### 4. Emit OASIS event (only if breach)

```
POST $GATEWAY_URL/api/v1/events/ingest
B: { vtid:"VTID-03177", type:"mobile.bundle.over_budget",
     source:"routine.mobile-bundle-budget", status:"warning",
     message:"<N> route chunks over gzip budget",
     payload:{ breached, all_routes:[ { route, route_gzip_kb, budget } ], vendor_gzip_kb } }
```

### 5. Close run

| Outcome | status | summary |
|---|---|---|
| Within budget | `success` | `"✅ All 9 route chunks within gzip budget (vendor {v}KB)"` |
| Breach | `partial` | `"⚠️ {N} chunks over budget: <routes>. OASIS event emitted."` |
| No manifest | `failure` | `"❌ dist/.vite/manifest.json missing — build did not produce a manifest"` |

`findings = { all_routes, vendor_gzip_kb, breached, oasis_event_id }`

## Hard rules

- Reads build artifacts only — never mutates source or the build.
- Fail the CI step on breach when run in-pipeline; the daily run only emits.
- Wall-clock cap 1 minute.
- No briefs.

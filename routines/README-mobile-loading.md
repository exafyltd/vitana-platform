# Mobile-loading test-program cluster

Test programs the Command Hub was missing to detect and prevent slow mobile
screen loads — the cluster behind the user complaints about **Events, Find a
Match, Chat History, My Journey, Settings, Memory, Media Lab, Live Rooms,
User Profile**.

Before this cluster, the Hub's 15 routines were all backend-health probes;
none measured mobile screen loading. The RUM beacon (`vitana-v1/src/lib/rum.ts`)
emitted per-screen Core Web Vitals into the event firehose, but the receiver is
a thin pipe with no aggregation, no budget, and no alerting — so "Events is
slow" never surfaced.

| Test program | Layer | Catches | Emits |
|---|---|---|---|
| `mobile-screen-latency-rollup` | Real-user (RUM) | A screen users *actually* experience as slow (p75 over budget) | `mobile.screen.slow` |
| `mobile-synthetic-load-probe` | Synthetic | A load regression *before* users hit it (throttled headless load) | `mobile.screen.synthetic_slow` |
| `mobile-bundle-budget` | Build artifact | The root cause of slow first paint (a route chunk that ballooned) | `mobile.bundle.over_budget` |
| `mobile-screen-api-latency` | Backend data | "Slow data" vs "slow screen" (a screen's primary endpoint is slow) | `mobile.screen.api_slow` |
| E2E perf budgets | CI gate | A load regression at PR time (fails CI) | — (test failure) |

Together: detection (rollup), prevention (synthetic + E2E), and root-cause
attribution (bundle + API).

## Supporting code

- Gateway aggregation endpoint backing the rollup:
  `GET /api/v1/routines/audits/mobile-screen-latency`
  → `services/gateway/src/routes/routine-audits.ts`
- Synthetic probe harness (Playwright, throttled mobile):
  `vitana-v1/scripts/mobile-perf-probe.mjs` (`npm run test:mobile-perf`)
- E2E perf-budget factory + targets:
  `e2e/fixtures/smoke-helper.ts` (`createMobilePerfTests`),
  `e2e/fixtures/mobile-perf-targets.ts`,
  `e2e/community-mobile/shared/mobile-perf.spec.ts`

## Before activating

All four routines currently emit under `VTID-03177` (the existing screen-latency
telemetry VTID). Governance should confirm whether each test program gets its own
catalog row + VTID, and seed `routines.name` rows, before they are added to the
scheduler. Budgets in each spec are starting points — tune against real p75 data
once the rollup has a few days of history.

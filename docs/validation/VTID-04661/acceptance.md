# VTID-04661 — Service Health panel, Phase 0: show every check, classify honestly, probe server side

VTID: VTID-04661
VALIDATION_PROFILE: gateway_backend

## Problem
- The Command Hub Service Health popup drew seven hardcoded groups. 'Screen Load Time'
  ('Frontend & Performance') was counted in "54/55" but never shown.
- A health route answering HTTP 200 `{ "ok": false }` was shown green; 401/403 was shown
  as a degraded service.
- Screen Load Time has been `down: no_recent_runs` for 14 days although every
  SCREEN-LOAD-TIMING run is green: 0 `screen.load.synthetic_test` events in 14 days. The
  spec never looked at the report response, so a rejected report was silent.
- GitHub runs the 30-minute cron every 3–5.5 h, so a 3 h freshness cutoff would read
  "down" most of the day even once reports land.
- Every check was probed from the browser, one request per check per refresh.

## Change
- `SERVICE_HEALTH_GROUPS` in the registry, served by `/health-registry`; the popup and
  the System Overview draw these first, then every other group — nothing is dropped.
- `services/service-health-probe.ts`: one classifier (`ok:false` → down, 401/403 →
  `no_access`, grey, counted separately), and `GET /api/v1/admin/health/summary` —
  admin-only, probes every check once over loopback with the caller's token, 30 s cache,
  concurrent callers share one run. The browser path is the fallback and uses a copy of
  the classifier (parity test).
- Screen Load Time: 3–12 h old → `degraded` (`scheduler_lag`), > 12 h → `down`. The spec
  records the report's HTTP status; a new workflow step fails the run if the report was
  rejected.
- Missing `.health-dot-yellow` style added (degraded dots had no colour), grey dot added.

## Acceptance criteria
AC-1: Every registry group is drawn; a group not in the order list is still drawn.
TEST: services/gateway/test/vtid-04661-service-health-panel.test.ts

AC-2: 2xx `{ok:false}` is down, 401/403 is no_access; server and browser classify identically.
TEST: services/gateway/test/vtid-04661-service-health-panel.test.ts

AC-3: The summary route is admin-only, probes each entry once per run, forwards the token, caches.
TEST: services/gateway/test/vtid-04661-service-health-panel.test.ts

AC-4: Screen load: 3–12 h → degraded/scheduler_lag, > 12 h → down with an explanatory message.
TEST: services/gateway/test/routes/screen-load-health.test.ts

OASIS_PROOF: none. Read-only health aggregation; no state transitions.

## Evidence
- `outputs/p0-desktop*.png`, `outputs/p0-mobile*.png` — local harness (static files from
  this tree, stubbed APIs, nothing live): all 8 groups drawn, "2 down · 1 no access",
  Screen Load Time visible as degraded.
- `commands.log` — test and typecheck runs.

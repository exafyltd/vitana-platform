# Plan sparring record — VTID-05062

- Partner: plan-sparring-partner (independent, read-only)
- Class: standard (both repos, .github); rounds: 3 (cap 3)
- Plan hash (sha256 of text between plan markers): be7c59cd8ccbd667402469f77d3a460b8885daff5687110055c63e1eb0b46a2c
- Verdict: **converged** (no open or disputed blocker/major)
- Owner approval: chat, 2026-10-10 — "yes" to the Gate 1 message. Owner chose "real-member data + phone robot" (no automated tests against production; absolute rule kept).

## Rounds
- R1: F1 blocker (in-process timer duplicates across 1–4 ECS tasks) ACCEPTED → scheduled GitHub workflow + per-day idempotency; F2 major (12-char VITE_APP_VERSION vs 40-char verified commit) ACCEPTED → prefix match on the `vitana-app-version` meta tag; F3 major (count overloading metric/value) ACCEPTED → separate `kind:'nav'` schema; F4 major (mixing into screen.latency.measured corrupts routine-audits p75) ACCEPTED → new topic `screen.nav.measured`; F5 major (change suites don't run every deploy) ACCEPTED → smoke manifest; F6–F8 minor ACCEPTED.
- R2: F1–F8 closed. F9 major (repo secret GATEWAY_SERVICE_TOKEN ≠ gateway token → 401) ACCEPTED → `secrets.SUPABASE_SERVICE_ROLE` (VTID-04721); F10 minor (deploy wall time) ACCEPTED → 5-min spec timeout.
- R3: F1–F10 closed, no new findings → CONVERGED.

## Plan and planner responses (verbatim)

# Plan — Daily guarantee that mobile screen loading is fast (production + staging)

<!-- plan:begin -->
## Problem (verified)
Members keep hitting slow / reloading screens on the mobile app (latest: News feed photos re-painting
on every tab return, fixed by VTID-05013/05015). Nothing told us:
- RUM (`vitana-v1/src/lib/rum.ts` → `POST /api/v1/rum/beacon` → OASIS `screen.latency.measured`) is
  live in production (24h to 2026-10-10: 749 prod samples, 41 sessions, **LCP p75 5224 ms = "poor"**),
  but it only measures the FIRST page load (LCP/FCP/TTFB/CLS/INP), never an in-app tab switch, never
  photo re-downloads on return, and nobody reads it — no budget, no alert.
- The synthetic job (`vitana-platform/.github/workflows/SCREEN-LOAD-TIMING.yml` +
  `e2e/community-mobile/shared/screen-load-timing.spec.ts`) cold-`page.goto`s 6 screens on staging
  every 30 min, desktop network, `waitUntil:'load'`; it never switches tabs and returns, never checks
  images, and only `console.warn`s when slow (never fails).
Owner decision 2026-10-10: guarantee daily, on the live app, that screen loading works — without
running automated tests against production (absolute rule kept): production is measured from real
members' devices; the full phone journey runs on staging daily and on every deploy.

## Part A — Production: real-member measurement of tab switches (vitana-v1 + vitana-platform)
A1. `vitana-v1/src/lib/rum.ts` (+ a small router hook mounted once in the app shell): on every in-app
    route change, measure **SCREEN_READY** = ms from the navigation (history change) until the new
    screen has rendered its main content AND every image in the first viewport has completed (or a
    10 s cap → value 10000, rating poor). Each beacon carries `nav: 'first' | 'return'` (return = the
    route was already shown in this session) — the case members feel when switching tabs.
A2. **IMG_REFETCH** (return visits only): count of first-viewport images that were fetched over the
    network again (PerformanceResourceTiming `transferSize > 0` for that image URL after the
    navigation). 0 = served from memory/HTTP cache = no visible reload.
A3. ONE anonymous nav beacon per in-app navigation (no user id; session id is the existing per-tab
    random id): `{ kind: 'nav', screen, nav: 'first'|'return', ready_ms, img_refetch (integer count),
    img_total, timed_out }`. `screen` is the matched React Router route pattern (ids collapsed, e.g.
    `/comm/groups/:id`), normalized on the client for nav beacons only; existing LCP/FCP/… beacons are
    unchanged.
A4. `vitana-platform/services/gateway/src/routes/rum-beacon.ts`: a second Zod schema for `kind:'nav'`
    (the existing metric `z.enum` is untouched). Nav beacons become a NEW OASIS topic
    `screen.nav.measured` (registered in `types/cicd.ts`), so the count field never mixes with timing
    values and existing consumers of `screen.latency.measured` (e.g. the `routine-audits.ts` p75 rollup)
    are unaffected.

## Part B — Daily production report + alert (vitana-platform)
B1. Exactly-once daily run: new GitHub scheduled workflow `SCREEN-LOAD-DAILY.yml` (~06:00 UTC +
    manual dispatch) calls the production gateway `POST /api/v1/frontend/screen-load/daily-report/run`
    with Bearer `secrets.SUPABASE_SERVICE_ROLE` — the value the gateway's `GATEWAY_SERVICE_TOKEN` env is
    actually sourced from; the repo secret of that name differs and returns 401 (VTID-04721, same as
    SCREEN-LOAD-TIMING.yml); a 401/5xx fails the workflow run loudly (no in-process timer — the gateway autoscales 1–4 ECS tasks). The
    endpoint is idempotent per UTC day (if today's `screen.load.daily_report` event exists it returns it
    unless `force=true`). It aggregates the last 24 h of production `screen.nav.measured` (tab screens
    `/home`, `/inbox`, `/comm/events-meetups`, `/autopilot`) and `screen.latency.measured` LCP (app
    overall, filtered by metric). This is an operational report over telemetry, not a test: no browser,
    no sign-in, no member-data writes.
B2. Budgets (owner can tune; start here): return-visit SCREEN_READY p75 ≤ 1000 ms; first-visit
    SCREEN_READY p75 ≤ 3000 ms; return visits with IMG_REFETCH > 0 ≤ 5 %; first-load LCP p75 ≤ 4000 ms
    (today 5224 → will report red until improved — honest baseline). Fewer than 20 samples for a
    screen = "insufficient data" (yellow), never silently green.
B3. Output: OASIS event `screen.load.daily_report` (status success/error, per-screen numbers, budget
    verdicts); a Google Chat DevOps message via the existing `notifyGChat` (red/yellow/green summary +
    worst screen); `GET /api/v1/frontend/screen-load/daily-report` (latest report in the
    `{status:'ok'|'degraded'|'down'}` health shape) so the Command Hub service-health grid shows it. It
    coexists with the existing `/health` (synthetic cold-load job), which is unchanged.
B4. **Build check** in the same run: read-only unauthenticated GET of the production HTML
    (`https://vitanaland.com/`, same class as the documented post-deploy bundle check — not a test) →
    read `<meta name="vitana-app-version">` (12-char short SHA baked by the deploy) → it must be a
    prefix of the `metadata.commit` (40-char) of some `staging.verify.passed` community-app event.
    No match → red.

## Part C — Phone journey robot on staging, daily + every deploy (vitana-v1)
C1. New `tests/e2e/staging/screen-journey.staging.spec.ts` (read-only, staging-guard, test user,
    orb-widget aborted client-side as in VTID-05013's spec): mid-range phone (Pixel 7 viewport + 4×
    CPU throttle + "Fast 4G" network via CDP), journey **News → Postfach → Events → Reise → News →
    Events** by tapping the bottom tabs.
C2. Per step it measures the same SCREEN_READY definition, counts storage-image responses that hit
    the network on return visits, and checks media frames don't change height. **Fails** if: any
    return-visit step > 1500 ms, any first-visit step > 4000 ms, any image re-downloaded on return,
    any frame height change. (Robot budgets are looser than B2's p75 because one run is noisy.)
C3. Registered in the community-app **smoke suite**
    (`vitana-platform/scripts/ci/staging-verify/smoke/community-app.json`, a `playwright` entry next to
    `smoke.staging.spec.ts`), so STAGING-VERIFY runs it on **every** community-app staging deploy
    (blocks Gate 2) and STAGING-VERIFY-NIGHTLY runs it **daily**. Wall-time budget: the spec has a 5-min
    test timeout (one journey ≈ 2–3 min under throttling), well inside STAGING-VERIFY's 45-min job
    timeout; kept on every deploy because catching a regression before Gate 2 is the point. Its own VTID change suite also
    lists it (`staging-tests.json`). Results are posted to the existing
    `POST /api/v1/frontend/screen-load/report` (environment `staging`).
C4. The old cold-load job (SCREEN-LOAD-TIMING) stays as is (no deletion); its role is documented as
    "cold load only".

## Out of scope
Production browser tests (owner decision: no); performance fixes themselves (LCP 5.2 s) — tracked as
the first red the report will show; keeping screens mounted across tabs (separate plan).

## Files in scope
vitana-v1: `src/lib/rum.ts`, `src/lib/rum.test.ts`, new `src/lib/screen-ready.ts` (+ test), app shell
mount point (one line, file confirmed during implementation), `tests/e2e/staging/screen-journey.staging.spec.ts`,
`docs/validation/<VTID>/*`.
vitana-platform: `services/gateway/src/routes/rum-beacon.ts`, `services/gateway/src/routes/screen-load-health.ts`,
new `services/gateway/src/services/screen-load-daily-report.ts` (+ test), `services/gateway/src/types/cicd.ts`
(2 topics), new `.github/workflows/SCREEN-LOAD-DAILY.yml`,
`scripts/ci/staging-verify/smoke/community-app.json`, tests, `docs/validation/<VTID>/*`.

## Test plan
- Vitest (v1): SCREEN_READY timing with fake router/images (first vs return, 10 s cap); IMG_REFETCH
  from mocked resource entries; route-pattern collapsing; no beacon on non-navigation renders.
- Jest (gateway): nav beacon schema (valid/invalid), emitted topic is `screen.nav.measured` and the
  old metric path is unchanged; daily report aggregation over fixture events (p75, refetch %,
  insufficient-data, short-SHA prefix match, mismatch → red), GChat message shape, per-day
  idempotency (second call returns the same report, no second GChat post), auth required.
- Staging: the journey spec itself (passes on current main); STAGING-VERIFY green on both deploys.
- Post-deploy (prod, read-only): bundle contains the SCREEN_READY code; within 24 h the first daily
  report exists in OASIS with production samples.
<!-- plan:end -->

## Planner responses — round 1
- F1 [blocker] ACCEPTED: no in-process timer; GitHub scheduled workflow SCREEN-LOAD-DAILY.yml calls an authenticated run endpoint once a day; endpoint idempotent per UTC day (B1).
- F2 [major] ACCEPTED: build check reads the 12-char `vitana-app-version` meta tag and prefix-matches the 40-char `staging.verify.passed` commit (B4).
- F3 [major] ACCEPTED: separate `kind:'nav'` schema; img_refetch is its own integer field, not a `metric`/`value` (A3/A4).
- F4 [major] ACCEPTED: new topic `screen.nav.measured`; `screen.latency.measured` and its consumers untouched (A4); daily report filters LCP by metric.
- F5 [major] ACCEPTED: journey spec added to the smoke manifest `scripts/ci/staging-verify/smoke/community-app.json` (every deploy + nightly) (C3).
- F6 [minor] ACCEPTED: B1/B4 state explicitly these are read-only operational reads, not tests.
- F7 [minor] ACCEPTED: route-pattern normalization on the client, nav beacons only; old beacons unchanged (A3).
- F8 [minor] ACCEPTED: endpoint named `/daily-report`, coexists with `/health` (B3).

## Planner responses — round 2
- F9 [major] ACCEPTED: SCREEN-LOAD-DAILY.yml authenticates with `secrets.SUPABASE_SERVICE_ROLE` (B1); auth failure fails the run loudly.
- F10 [minor] ACCEPTED: 5-min spec timeout, ~2–3 min expected, fits the 45-min job; stays on every deploy by design (C3).

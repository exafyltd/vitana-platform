# VTID-04887 — Command Hub Overview Phase 4: cleanup

Plan A (Command Hub Overview), Phase 4. Sparring record: `plan-sparring.md` (points at
`docs/validation/VTID-04869/plan-sparring.md`, converged, owner-approved 2026-10-04). Builds on
Phase 1 (VTID-04876), Phase 2 (VTID-04885) and Phase 3 (VTID-04886).

What changed:
- the Overview's four other tabs (Live Metrics, Recent Events, Errors & Violations, Release Feed)
  are router redirects to their specialised screens, with a short note;
- their renderers, fetchers, polls, hardcoded lists and state are deleted;
- the collapsed "Detailed panels" keep only the two panels nothing else covers: grouped Service
  Health and Vitana Recommends;
- a new admin-gated `GET /api/v1/ops/pipeline-summary` serves `buildPipelineSummary()` in-process.
  The three browser consumers of the pipeline summary use it; the service-token route is unchanged
  for machine callers;
- the voice navigation catalog retires the four tab screens into `formerIds`;
- 57 dead CSS rules are removed with the repo's own matcher.

No live endpoint, database or AWS API was called while building this. Every test uses mocks, and
the cockpit was rendered offline with every request aborted (`commands.log`).

## Tab redirects

AC-1: `NAVIGATION_CONFIG`'s Overview section has one tab, System Overview. The four old paths
`/command-hub/overview/{live-metrics,recent-events,errors-violations,release-feed}/` are in
`OVERVIEW_TAB_REDIRECTS`, merged into the router's redirect table. They resolve to Operator ›
Dashboard, OASIS › Events, Governance › Violations and Operator › Deployments. Each carries a short
note, shown once as an info toast. On first load the address bar is rewritten to the target tab.
TEST: services/gateway/test/command-hub/vtid-04887-overview-cleanup.test.ts ("the four old Overview tabs are redirects")
CURL: GET https://preview-aws-gateway.vitanaland.com/command-hub/overview/live-metrics/ -> 200 text/html with the 20261030-vtid-04887 app.js (staging-tests.json); the redirect itself is client-side

AC-2: Every redirect target exists in `NAVIGATION_CONFIG`. A test walks them with the real router
code (`getRouteFromPath` and both redirect tables evaluated from app.js). It also walks every
older entry of the shared redirect table: none dangles. A mutation (a wrong target tab) fails the
walk.
TEST: services/gateway/test/command-hub/vtid-04887-overview-cleanup.test.ts ("every redirect target exists in NAVIGATION_CONFIG (walk)", "every redirect in the shared table resolves to a real tab too")

AC-3: No dead tab content is left. There is no dispatch branch for an old tab, and 26 functions
are deleted with no mention left: the four tab renderers and their fetchers and auto-refresh, the
dashboard fetch and its helpers, the metrics grid, the VTID attention cards, the old
pipeline-summary and timeseries fetches, and the 60 s poll. The hardcoded lists (`NOISE_TOPICS`,
`EVENT_FILTERS`, the critical-service list) and nine orphaned state blocks are gone. The standing
zero-caller guard (T2) is green: it is computed at test time, so it needs no regeneration.
TEST: services/gateway/test/command-hub/vtid-04887-overview-cleanup.test.ts ("no dead tab content")
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

AC-4: Voice navigation follows. The four `DEVHUB.OVERVIEW.*` screens are removed from
`command-hub-screens.json`, and their ids become `formerIds` of the redirect targets, so every
legacy DEVHUB id still opens. Two of each old screen's phrasings move to its target. They already
have stored vectors, so no embedding run is needed. The golden cases follow.
TEST: services/gateway/test/navigation/vtid-04814-command-hub-navigation.test.ts ("has exactly one screen per tab of NAVIGATION_CONFIG", "keeps every legacy DEVHUB id working", golden cases)

## Detailed panels

AC-5: The collapsed disclosure ("Service health and recommendations") keeps only what no tile or
adapter covers. It is rendered, and fetched, only when opened:
- grouped Service Health: every check, grouped. The Platform tile only summarises it.
- Vitana Recommends: the only place in the Command Hub that generates recommendations
  (`POST /autopilot/recommendations/generate`), with Activate and Dismiss. The Operator Runbook
  lists recommendations read-only.

The metrics grid, VTID attention, ORB card, failures, deployments, attention center and live
activity are deleted. The Phase 2 tiles, the queue (operator_pipeline adapter) and the Phase 3
timeline cover them.
TEST: services/gateway/test/command-hub/vtid-04887-overview-cleanup.test.ts ("the detailed panels keep only grouped Service Health and Vitana Recommends")
TEST: services/gateway/test/command-hub/vtid-04869-overview-phase0.test.ts (every Phase 0 false-signal fix still pinned, or pinned as gone with its code)
UI: docs/validation/VTID-04887/outputs/p4-service-health-desktop.png, p4-service-health-mobile-viewport.png, p4-recommends-desktop.png, p4-recommends-mobile.png

AC-6: Vitana Recommends used to read the pipeline summary through the service-token route. That
route always answered 401 in the browser, so the panel only ever said "No pending". It now reads
the admin route. A failed read says "Could not load recommendations (…)", and a pending read says
"Loading…"; neither says "No pending". `fetched` is set in `finally`, so a failure cannot loop, and
a refresh swaps only the panel. The badge of the Service Health header now uses full class names,
so the dead-CSS matcher sees them; the amber state gets a style (it had none).
TEST: services/gateway/test/command-hub/vtid-04887-overview-cleanup.test.ts ("Vitana Recommends", "the Service Health badge names full class names")
TEST: services/gateway/test/vtid-04671-recommendation-card.test.ts
TEST: services/gateway/test/vtid-04667-executable-source-types-drift.test.ts
UI: docs/validation/VTID-04887/outputs/p4-recommends-desktop.png, p4-recommends-mobile.png

## Pipeline summary route (plan Q6)

AC-7: Before this change, three browser callers read `/api/v1/autopilot/pipeline/summary` and got
401: Operator › Dashboard, Operator › Runbook and Vitana Recommends. All three read
`GET /api/v1/ops/pipeline-summary` with the bearer token. No browser code line calls the
service-token route now.
TEST: services/gateway/test/vtid-03925-pipeline-summary-loop-fix.test.ts
TEST: services/gateway/test/command-hub/vtid-04887-overview-cleanup.test.ts ("browser callers of the pipeline summary use the admin route")

AC-8: `GET /api/v1/ops/pipeline-summary` (routes/ops-pipeline-summary.ts) is behind
`requireAdminAuth` (platform exafy_admin). Without a token it answers 401 JSON and the builder
never runs. For an admin it answers exactly `buildPipelineSummary()`'s status and body: the same
snake_case JSON as the service-token route, in-process, with no HTTP self-call. Successful answers
are cached for 15 s per task with single-flight; a builder 500 is passed through and never cached.
`Cache-Control: no-store`. The service-token route is unchanged for machine callers.
TEST: services/gateway/test/vtid-04887-ops-pipeline-summary-route.test.ts
TEST: services/gateway/test/vtid-04875-pipeline-summary-builder.test.ts (the service-token route, byte-for-byte)
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/ops/pipeline-summary (no token) -> 401 application/json (staging-tests.json)

AC-9: The new route file is claimed by the developer domain atlas (`/^ops-/`, domain `oasis`,
"OASIS, VTIDs and governance"). The atlas drift guard in `npm run test:roles` is green, and the route test asserts
the claim.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts ("every gateway route file is claimed by at least one domain")
TEST: services/gateway/test/vtid-04887-ops-pipeline-summary-route.test.ts ("the developer domain atlas claims the new route file")

ROUTE_MOUNT: `const opsPipelineSummaryRouter = require('./routes/ops-pipeline-summary').default;`
and `mountRouterSync(app, '/api/v1/ops/pipeline-summary', opsPipelineSummaryRouter, { owner:
'ops-pipeline-summary' })` in services/gateway/src/index.ts, next to `/api/v1/ops/attention`.
FINAL_URL: GET https://preview-aws-gateway.vitanaland.com/api/v1/ops/pipeline-summary
CURL_PROOF:
- Before merge: not run. No live endpoint may be called from this session, so mount, auth and body
  are proven in-process with supertest (AC-8).
- After deploy: an unauthenticated GET must answer `401 application/json` (staging-tests.json,
  read-only). The admin 200 path is not probed on staging, because the suite never signs in.

## Gates

AC-10: The ownership guard allowlists VTID-04887. The asset version moves forward to
`20261030-vtid-04887`, and every older staging suite that pins it follows (VTID-04696). An offline
check of all 59 served-asset assertions in every `staging-tests.json` passes against the local
files. The symbol index is regenerated with its generator (`--check` in sync, 902 functions).
TEST: services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts
TEST: services/gateway/test/scripts/generate-command-hub-symbol-index.test.ts

AC-11: Dead CSS. `find-dead-css-classes.mjs --fix` removed 57 rules: 54 orphaned by this cleanup and
3 that were already dead at Phase 3 (`.orb-config-value-*`, the old ORB card). Every removed class
was checked for runtime string building. One real case was found: the matcher cannot see
`'overview-count-badge-' + …`. It is fixed in app.js (full class names), not by an exception. The
recommendation rules are kept for Vitana Recommends. `--check` is in sync.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts
TEST: services/gateway/test/command-hub/vtid-04887-overview-cleanup.test.ts ("the Service Health badge names full class names")

AC-12: CSP. No CSP pattern appears in added lines of `services/gateway/src/frontend/`, for Phase 4
alone and for Phases 2–4 together. The `.style` writes of the restored panel became CSS classes.
There is no inline handler.
TEST: scripts/ci/validator-path-guard.cjs --csp-added-lines (outputs/06-csp-added-lines.txt)
UI: docs/validation/VTID-04887/outputs/p4-cockpit-desktop.png, p4-cockpit-mobile.png (no horizontal scroll, no target < 24 px)

AC-13: The standing suites stay green: `npm run test:operator` (rule 42e) and `npm run test:roles`
(rule 42h, atlas drift guard).
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

OASIS_PROOF: no new OASIS event types. The new route only reads, through the existing builder.

## Known gaps

- `services/gateway/specs/dev-screen-inventory-v1.json` still lists the four old tabs. Its
  generator (`scripts/regen-screens-catalog.mjs`) already fails at Phase 3 on duplicate DEV screen
  ids (DEV-OVERVIEW, DEV-SESSIONS, …), and with a local vitana-v1 checkout it also fails on
  `icon: Inbox`. It was not hand-edited. The file is docs-only (`/command-hub/docs/screens/`), and
  the old URLs still work (redirects).
- `GET /api/v1/ops/overview-timeseries` (DEV-COMHU-03404) has no frontend caller any more. The
  backend route is kept, because removing a route is outside this frontend cleanup.
- The admin 200 path of the new route is proven in CI only; staging probes it unauthenticated.

# VTID-04876 — Command Hub Overview Phase 1: the supervisor cockpit

Plan A (Command Hub Overview), Phase 1. Sparring record: `plan-sparring.md` (points at
`docs/validation/VTID-04869/plan-sparring.md`, converged, owner-approved 2026-10-04). Builds on
Phase 0 (VTID-04869) and Phase 1a (VTID-04875, in-process builders).

What changed: a new admin-only aggregator `GET /api/v1/ops/attention` (seven in-process adapters,
numeric rubric, time-based hysteresis, per-adapter time budgets (3 s default; service health 8 s, autonomy 6 s), single-flight + 25 s cache), the
`ops_attention_state` table, `golden_path` on the service-health registry, `/ops/action-required`
behind `requireAdminAuth`, and the Overview rewritten into a status bar + ranked "Needs attention
now" queue with a `?vtid=` / `?session=` deep-link contract. No live endpoint or database was
called while building this; every test uses mocks (`commands.log`).

## Route

AC-1: `GET /api/v1/ops/attention` lives in `routes/ops-attention.ts` and is mounted in `index.ts`
next to `/ops/action-required`. It is protected by the existing `requireAdminAuth` (platform
exafy_admin only). Without a token the real middleware answers 401 JSON before any read.
TEST: services/gateway/test/vtid-04876-ops-attention-route.test.ts ("401 JSON without an Authorization header")
TEST: services/gateway/test/vtid-04876-ops-attention-route.test.ts ("mountRouterSync at /api/v1/ops/attention")
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/ops/attention (unauthenticated) -> 401 application/json (staging-tests.json, after deploy)

AC-2: The response is `{ok, data:{generated_at, env, verdict, counts:{p1,p2,p3}, sources:[{id,
status:'ok'|'unknown', fetched_at, error?}], items:[{id, fingerprint, domain, severity, title,
detail, since, count, source, deeplink:{section, tab, query}, evidence}]}}`. `Cache-Control:
no-store`. `sources` lists the seven adapters plus `attention_state`.
TEST: services/gateway/test/vtid-04876-ops-attention-route.test.ts ("200 {ok, data} with the contract shape")
TEST: services/gateway/test/vtid-04876-ops-attention-aggregator.test.ts ("response shape, env-scoped fingerprints, ranking")

AC-3: `/api/v1/ops/action-required` is behind `requireAdminAuth`; its existing test is updated
and an unauthenticated request gets 401 before any Supabase read.
TEST: services/gateway/test/ops-action-required.test.ts
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/ops/action-required (unauthenticated) -> 401 application/json (staging-tests.json)

## Aggregator

AC-4: Every adapter runs within its own time budget: 3 s by default, 8 s for service health and
6 s for autonomy (owner decision 2026-10-04: the planner sets the budgets). The client waits 15 s.
A timeout or a throw makes that source `unknown` with its error. A partial read makes it `unknown`
and still shows what was found.
TEST: services/gateway/test/vtid-04876-ops-attention-aggregator.test.ts ("exceeds the 3 s timeout", "per-source budgets", "throwing adapter", "partial adapter")

AC-5: Verdict: CRITICAL when any P1 is shown; else UNKNOWN whenever any source is unknown; else
ATTENTION (P2/P3); else OK. It is never OK on missing data, and an unmeasured golden-path health
check makes the health source unknown.
TEST: services/gateway/test/vtid-04876-ops-attention-aggregator.test.ts ("verdict")
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("an unmeasured golden-path check (no_access) makes the source UNKNOWN")

AC-6: Single-flight per task plus a 25 s cache. Concurrent callers share one computation, a call
within 25 s is served from the cache, and one at 25 s recomputes. Nothing runs in the background
(on demand, while a viewer has the Overview open).
TEST: services/gateway/test/vtid-04876-ops-attention-aggregator.test.ts ("getOpsAttention — single-flight + cache")

AC-7: The adapters never make HTTP self-calls. The production reads call the in-process functions:
- `buildHealthSummary` (caller's auth header forwarded);
- `buildVoiceOverview({window:'1h', scope:{is_platform_admin:true}})`;
- `buildPipelineSummary`, `buildSupervisorSnapshot`, `getAllSystemControls`, `isAutonomousExecutionTask`;
- the `/approvals/pending` helpers and the cached ops-runtime build-info checks;
- bounded service-role reads, each with a LIMIT and an indexed filter.

A failed read throws (→ unknown); it never becomes "nothing found".
TEST: services/gateway/test/vtid-04876-ops-attention-reads.test.ts

## Rubric (plan table as amended by N4/N5/N7)

AC-8: Service health. A golden-path check failing for ≥ 2 min is P1. Any other check failing for
≥ 2 min is P2. A degraded check is P3. The 2 minutes are held through `ops_attention_state`.
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("service_health adapter")

AC-9: Release.
- P1: the newest prod deploy is `prod.deploy.failed` or `prod.deploy.rolled_back`, less than 2 h ago.
- P2: `staging.verify.failed` with no newer `staging.deploy.completed`.
- P3: STAGING-VERIFY stale > 72 h; prod ≠ staging commit for > 48 h (state hold); a legacy
  `deploy.gateway.failed` / `cicd.deploy.service.failed` in 24 h.
- Unreadable build-info makes the source unknown.
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("release adapter")

AC-10: Voice supervisor. A `system_wide` verdict is P1, a segment critical P2, a warning P3.
Quarantined classes and open architecture reports (carried over from `/ops/action-required`)
are P3.
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("voice_supervisor adapter")

AC-11: Autonomy.
- A critical supervisor alert is P2 and a warning P3; info alerts are dropped.
- The kill-switch alert belongs to governance (N7) and the awaiting-approval alert to decisions.
- Self-heal: `rolled_back` is P2 and `escalated` P3, one item per endpoint with a count.
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("autonomy adapter")

AC-12: Operator pipeline (N4). Only `isAutonomousExecutionTask()` rows count. A task is stuck
when it has had no claim heartbeat for > 60 min (`claim_expires_at` − 60 min, else
`claim_started_at`), never by `updated_at`. Broken (pipeline summary) or stuck is P2. There is no
30–60 min band.
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("operator_pipeline adapter (N4)")

AC-13: Governance (N5/N7).
- A disarmed `autopilot_execution_enabled` / `vtid_allocator_enabled` is P2, with who and when.
- The Dev Autopilot kill switch engaged is one P2 fingerprint, with when from
  `dev_autopilot.kill_switch.activated`.
- Critical violations are one P2 item and other open violations one P3 item.
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("governance adapter")

AC-14: Decisions waiting. Dev Autopilot awaiting approval, self-heal pending approval and PR
approvals: waiting > 4 h is P2 and > 1 h is P3. Items are grouped per kind with a count.
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("decisions_waiting adapter")

## Hysteresis and state

AC-15: Time-based hysteresis.
- A candidate with a source timestamp is stateless.
- Otherwise `ops_attention_state` keeps `first_seen` while the fingerprint keeps being observed.
- `first_seen` resets after 90 s unseen.
- Fingerprints and the primary key include the env (`VITANA_ENV` via `env.ts`), so staging and
  production rows never mix.
TEST: services/gateway/test/vtid-04876-ops-attention-aggregator.test.ts ("hysteresis (time-based, N2/N5/N8)")

AC-16: A state read failure is logged and falls back to "first seen at this request";
`attention_state` is then unknown (a hold can never open, so it must not look green). A write
failure is logged and the response is unaffected.
TEST: services/gateway/test/vtid-04876-ops-attention-aggregator.test.ts ("state READ failure", "state WRITE failure")

AC-17: Migration `20261004130000_vtid_04876_ops_attention_state.sql`:
- `ops_attention_state(env, fingerprint, first_seen, last_seen)`, PK (env, fingerprint);
- env CHECK constrained, index (env, last_seen);
- RLS on, REVOKE from PUBLIC/anon/authenticated, GRANT to service_role only;
- idempotent (`IF NOT EXISTS`). `DATABASE_SCHEMA.md` is updated. Not applied by this session.
TEST: services/gateway/test/vtid-04876-ops-attention-reads.test.ts ("ops_attention_state store")

AC-18: `golden_path: true` is set on Gateway, Gateway Alive, Auth, ORB Live, Nova Sonic, Aurora
Memory, Aurora RLS, Database Latency and Frontend Prod, and nowhere else. The VTID-04875
health-summary snapshot was re-recorded, and its diff is the new field only (`commands.log`).
TEST: services/gateway/test/vtid-04661-service-health-panel.test.ts ("VTID-04876: golden-path registry entries")
TEST: services/gateway/test/vtid-04662-service-health-registered-routes.test.ts

## Frontend

AC-19: The Overview system view is rewritten into two parts:
- a status bar: verdict, P1/P2/P3 counts, sources fresh x/y, generated_at, and the env label
  "Staging build · production data" on staging;
- a ranked "Needs attention now" queue with domain filters.

The pre-Phase-1 panels stay, collapsed, rendered only when opened.
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("status bar", "ranked queue")
UI: docs/validation/VTID-04876/outputs/cockpit-desktop.png, cockpit-mobile.png (offline render, mocked API)

AC-20: Severity is shown as icon, text label and colour class. The queue body is
`aria-live="polite"`. Targets are ≥ 24px and the CSS uses logical properties only.
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("severity is icon + text label + colour class")
UI: docs/validation/VTID-04876/outputs/cockpit-filter-operator.png

AC-21: The cockpit polls every 30 s, only while the Overview is the routed screen
(`currentModuleKey`/`currentTab`) and no Operator popup is open. The poll patches the cockpit in
place. The status bar turns UNKNOWN ("Cockpit blind — check GChat") on any fetch error or after
2× the poll interval.
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("polls every 30 s and goes blind after 2x")
TEST: services/gateway/test/vtid-03917-overview-poll-no-full-rerender.test.ts
UI: docs/validation/VTID-04876/outputs/cockpit-blind.png

AC-22: The `/ops/action-required` consumer is migrated to `/ops/attention`, and nothing in app.js
reads `/ops/action-required` any more. There is no `onclick` in the Overview region: one
delegated listener reads `data-action`.
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("no inline handlers", "the /ops/attention migration")

AC-23: Deep-link contract.
- `navigateToScreen(section, tab, query)` appends the query.
- `?vtid=` opens the task drawer (command-hub/tasks) and the ledger drawer (oasis/vtid-ledger);
  `?session=` opens the voice session drawer (voice/sessions).
- The parameter is read on navigation, back/forward and page load.
- An unresolvable value shows a toast and falls back to the list.
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("deep-link contract")

AC-24: A unit test walks every adapter deeplink against `NAVIGATION_CONFIG` and checks three
things: the section/tab exists, every query key is one that screen reads (the frontend and
backend contracts are equal), and the screen is rendered by the dispatcher.
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("every adapter deeplink resolves against NAVIGATION_CONFIG")

AC-25: The Command Hub is admin-facing and English by design (stated in the cockpit code comment
and in the adapters module). Added frontend lines contain no CSP pattern (VALIDATOR-CHECK
`--csp-added-lines`: no hits).
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("says why its strings are English", "CSP-clean")

AC-26: The ownership guard allowlists VTID-04876. The asset version is `20261027-vtid-04876`, and
the older staging suites follow the bump (VTID-04696). The orphaned banner CSS is removed with the
standing dead-CSS tool, and the command-hub symbol index is regenerated (`--check` in sync).
TEST: services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts
TEST: services/gateway/test/command-hub/vtid-04354-orchestrator-view.test.ts
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts

AC-27: The standing suites stay green: `npm run test:operator` (rule 42e) and `npm run test:roles`
(rule 42h, including the atlas drift guard). `routes/ops-attention.ts` is claimed by the
`/^ops-/` domain, so no atlas change was needed.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

## Adapter wiring status

All seven adapters are wired to real in-process sources. None is `not_wired`.

| Adapter | Source (in-process) | Status |
|---|---|---|
| service_health | `buildHealthSummary` (VTID-04875) | real |
| release | `oasis_events` (prod/staging deploy + verify topics, `prod.deploy.rolled_back`, legacy failure topics) + `runRuntimeCheckCached('deploy/prod-gateway' / 'deploy/staging-gateway')` | real; build-info needs `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS`, else the source reports unknown |
| voice_supervisor | `buildVoiceOverview` (1h, platform scope) + `voice_healing_quarantine` + `voice_architecture_reports` | real |
| autonomy | `buildSupervisorSnapshot().alerts` + `self_healing_log` | real |
| operator_pipeline | `vtid_ledger` claim columns + `isAutonomousExecutionTask` + `buildPipelineSummary` BROKEN set | real |
| governance | `getAllSystemControls` + `dev_autopilot_config.kill_switch` + `governance_violations` | real |
| decisions_waiting | `dev_autopilot_executions` (awaiting_approval) + `self_healing_log` (pending approval) + `/approvals/pending` helpers | real |

## Known gaps (honest limits, tracked for later phases)

- The Service Health adapter's builder probes about 117 endpoints in parallel with a 5 s probe
  timeout, so it gets an 8 s budget; if a run still exceeds it, the source reads unknown until the
  in-flight run lands in the shared 30 s cache.
- `buildSupervisorSnapshot` is heavy (many reads) and gets a 6 s budget; beyond that it reads
  unknown rather than a guess.
- Self-heal escalations are not live re-probed (`/ops/action-required` re-probed with a 4 s probe,
  which does not fit the 3 s budget).
- "Broken" operator tasks use the pipeline summary's own heuristic (in progress, more than 2 h
  without a ledger update). Unclaimed autonomous tasks have no heartbeat to age, so they are not
  reported as stuck.
- The kill-switch OASIS event carries no actor: only "when" is shown, not "who".
- Service-health items deep-link to the Overview's own detailed panels; there is no dedicated
  Service Health screen yet.
- `find-dead-css-classes` flags `.orb-config-value-*` as dead. That is a false positive which
  predates this change (the classes are set through string concatenation), so they are kept.
- The asset version is `20261027-vtid-04876`, not the `20261004-vtid-04876` named in the brief.
  The current version was already `20261026-vtid-04869`, and standing tests require the version
  to only move forward.

ROUTE_MOUNT: `mountRouterSync(app, '/api/v1/ops/attention', opsAttentionRouter, { owner: 'ops-attention' })`
in services/gateway/src/index.ts. It holds one route in services/gateway/src/routes/ops-attention.ts:
`GET /` (`requireAdminAuth`).
FINAL_URL: GET https://preview-aws-gateway.vitanaland.com/api/v1/ops/attention
CURL_PROOF:
- Before merge: not run. This session may not call any live endpoint, so mount and auth were proven
  in-process with supertest (AC-1).
- After deploy, an unauthenticated GET must answer `401 application/json`, and `/alive` must answer
  `200`. Both are checked by staging-tests.json, read-only.

OASIS_PROOF: no new OASIS event types. The route only reads OASIS (`oasis_events` deploy, verify
and kill-switch topics). The one write is the gateway's own `ops_attention_state` bookkeeping
(service role).

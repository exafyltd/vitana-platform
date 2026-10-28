# VTID-04885 — Command Hub Overview Phase 2: domain tiles + six more adapters

Plan A (Command Hub Overview), Phase 2. Sparring record: `plan-sparring.md` (points at
`docs/validation/VTID-04869/plan-sparring.md`, converged, owner-approved 2026-10-04). Builds on
Phase 1 (VTID-04876): the same `GET /api/v1/ops/attention`, the same aggregator (timeouts,
hysteresis, `ops_attention_state`, single-flight + cache), the same cockpit.

What changed: six new in-process adapters with a rubric and deep links, a server-side `domains`
summary (one entry per plan domain), 13 domain tiles under the queue, five new queue filters, and
the Feedback module made routable (no sidebar entry) with a `?ticket=` deep link. No live endpoint,
database or AWS API was called while building this; every test uses mocks (`commands.log`).

## Adapters

AC-1: Cost & budgets (`cost_budgets`, 8 s budget). In-process reads of today's LLM spend
(`loadSpendToday` + `aggregateSpend` + `budgetLines`, the arithmetic of
`GET /api/v1/orchestrator/budgets`) and this month's `jev.budget.threshold_crossed` events
(VTID-04857). A platform or agent line over its daily limit is P2 and one at ≥ 80% is P3; run lines
are grouped (over → P2, ≥ 80% → P3). Per tenant, the highest Jev level wins: 100% is P2, 80% is P3.
A truncated spend read or one failed half makes the source unknown; both failing throws.
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-adapters.test.ts ("cost_budgets adapter")
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-reads.test.ts ("cost & budgets")

AC-2: Tests & contracts (`tests_contracts`). `ci_test_runs` on `main` in the last 7 days (LIMIT
1000). A workflow whose latest verdict failed is P3, and ≥ 2 failures in a row is P2 (`since` is the
first failure of the streak). Failing capability contracts (`test_contracts.status = 'fail'`) are
one P3 item. `ci_test_runs` is synced lazily; a sync older than 24 h (or never) makes the source
unknown. STAGING-VERIFY stays with the release adapter, so it is not counted twice.
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-adapters.test.ts ("tests_contracts adapter")
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-reads.test.ts ("tests & contracts")

AC-3: Routines (`routines`). Enabled `routines` rows. A failed last run is P3 and ≥ 3 in a row is
P2. A run still `running` after 6 h is P3. A routine is overdue (P3) once 1.5 schedule intervals pass
without a run. A schedule the parser does not understand makes the source unknown rather than
"on time".
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-adapters.test.ts ("routines adapter")

AC-4: Support tickets (`support_tickets`). Open `feedback_tickets` (the closed statuses of the
partial index excluded) that are p0/p1 or older than 72 h. An open p0 is P2. A p1 waiting > 1 h is P3
and > 4 h is P2. Any ticket open > 72 h is one P3 item. One ticket deep-links to
`feedback/inbox?ticket=<id>`; several link to the inbox.
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-adapters.test.ts ("support_tickets adapter")
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-reads.test.ts ("routines, support tickets, Google fallback")

AC-5: LLM Google fallback (`llm_google_fallback`). `llm.call.completed` events in 24 h whose
`metadata.provider` is vertex/google/gemini (the router records the fallback provider and
`fallback_used`). Any fallback landing on Google is P2 (CLAUDE.md §2b, IF-THEN 29: an incident). A
stage routed at Google without a fallback is its own P2. An unreadable read throws.
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-adapters.test.ts ("llm_google_fallback adapter")

AC-6: Stuck session VTIDs (`stuck_vtids`). The in-progress ledger page that `operator_pipeline`
reads (shared, read once per computation). Session-plane rows (not `isAutonomousExecutionTask`)
with no update for > 72 h are one P3 item. Autonomous tasks belong to the operator adapter. A full
500-row page makes the source unknown.
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-adapters.test.ts ("stuck_vtids adapter")
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-reads.test.ts ("the in-progress ledger is read once per computation")

AC-7: CloudWatch alarms are **not wired**. `@aws-sdk/client-cloudwatch` is not a gateway
dependency (only `-logs`), and adding one was out of scope, and the task-role IAM grant is its own
infra VTID. The source is listed in `NOT_WIRED_SOURCES`, and the Platform tile names it under
"Not yet monitored" (not unknown). `OPS_ATTENTION_CLOUDWATCH_ENABLED` is reserved for it.
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-adapters.test.ts ("the CloudWatch adapter is not wired")

AC-8: All new reads are in-process and bounded (LIMIT + an indexed filter). None makes an HTTP
self-call. A failed read throws (→ unknown), never "nothing found". The registry is the seven
Phase 1 adapters followed by the six new ones.
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-reads.test.ts ("nothing above used fetch")
TEST: services/gateway/test/vtid-04876-ops-attention-adapters.test.ts ("registry")
TEST: services/gateway/test/vtid-04876-ops-attention-aggregator.test.ts ("per-source budgets")

## Domain tiles

AC-9: The response gains `domains`: one entry per plan domain (13, in plan order), each with
`status ok|unknown|not_monitored`, `worst_severity`, `open`, `sources_fresh/total`, `fetched_at`
(oldest source fetch), `errors`, `not_wired` and a deep link. Each adapter belongs to exactly one
tile. Moderation & Commerce and Data & Memory have no adapter (`not_monitored`). A monitored
domain whose source failed or did not run is `unknown`, never OK.
TEST: services/gateway/test/vtid-04885-ops-attention-phase2-adapters.test.ts ("registry, not-wired sources and domain tiles")
TEST: services/gateway/test/vtid-04876-ops-attention-route.test.ts ("200 {ok, data} with the contract shape")

AC-10: The cockpit renders 13 tiles under the queue. Each tile shows the worst severity (icon +
text + colour), the open count, "Sources fresh x/y · age" and a click-through (`data-action`, no
`onclick`). Unmonitored tiles say "Not yet monitored" and are not links. A blind cockpit shows every
tile UNKNOWN.
TEST: services/gateway/test/command-hub/vtid-04885-overview-tiles.test.ts ("domain tiles")
UI: docs/validation/VTID-04885/outputs/p2-cockpit-desktop.png, p2-cockpit-mobile.png, p2-cockpit-blind.png

AC-11: Every tile deep link and every new adapter deep link is a `NAVIGATION_CONFIG` screen the
dispatcher renders, and every query key is one that screen reads. The queue filters gain AI & LLM,
Quality, Cost, Support and Jobs.
TEST: services/gateway/test/command-hub/vtid-04885-overview-tiles.test.ts ("every tile deep link", "the queue filters cover every domain")
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("every adapter deeplink resolves against NAVIGATION_CONFIG")
UI: docs/validation/VTID-04885/outputs/p2-cockpit-filter-support.png

## Feedback module

AC-12: The Feedback module (VTID-02605 views) is routable at `/command-hub/feedback/{inbox,
handoffs,kpis,audit}/`. Its `NAVIGATION_CONFIG` section is flagged `"sidebar": false`, and
`renderSidebar` skips it, so the sidebar is unchanged. The four screens are in the Command Hub
screen registry with `disabled` set, so voice does not open them: their phrasings have no stored
Titan vectors, and producing vectors needs an AWS embedding run.
TEST: services/gateway/test/command-hub/vtid-04885-overview-tiles.test.ts ("the Feedback module is routable without a sidebar entry")
TEST: services/gateway/test/navigation/vtid-04814-command-hub-navigation.test.ts ("has exactly one screen per tab of NAVIGATION_CONFIG")

AC-13: `?ticket=` on `feedback/inbox` opens the ticket drawer. An id the admin feedback API does not
return falls back to the inbox with a toast. The frontend and backend deep-link contracts stay
equal.
TEST: services/gateway/test/command-hub/vtid-04885-overview-tiles.test.ts ("?ticket= on feedback/inbox opens the ticket drawer")
TEST: services/gateway/test/command-hub/vtid-04876-overview-cockpit.test.ts ("the frontend contract equals the backend DEEPLINK_QUERY_CONTRACT")

## Gates

AC-14: The ownership guard allowlists VTID-04885. The asset version moves forward to
`20261028-vtid-04885`, and every older staging suite follows the bump (VTID-04696). The symbol index
is regenerated with its tool (`--check` in sync). The CSS uses logical properties only and has no
CSP pattern in added lines.
TEST: services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts
TEST: services/gateway/test/command-hub/vtid-04885-overview-tiles.test.ts ("styles and asset version")

AC-15: The standing suites stay green: `npm run test:operator` (rule 42e) and `npm run test:roles`
(rule 42h, atlas drift guard). No route file was added.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

## Adapter wiring status

| Adapter | Source (in-process) | Status |
|---|---|---|
| cost_budgets | `loadSpendToday` + `budgetLines` (orchestrator budgets, shadow) + `oasis_events` `jev.budget.threshold_crossed` | real |
| tests_contracts | `ci_test_runs` (main, 7 d) + `ci_test_sync_state` + `test_contracts` | real (unknown when the lazy sync is > 24 h old) |
| routines | `routines` (enabled) | real |
| support_tickets | `feedback_tickets` (open, p0/p1 or > 72 h) | real |
| llm_google_fallback | `oasis_events` `llm.call.completed` with a Google `metadata.provider` | real |
| stuck_vtids | `vtid_ledger` in-progress page (shared with operator_pipeline) | real |
| cloudwatch_alarms | — | **not_wired** (no `@aws-sdk/client-cloudwatch`; IAM grant is its own infra VTID) |

## Known gaps

- Jev budget items deep-link to Autopilot › Orchestrator (LLM budgets). The Jev card is the
  standalone `/command-hub/jev.html` and is not a `NAVIGATION_CONFIG` screen, so the item names it
  in its detail.
- The LLM budgets are the orchestrator's shadow budgets (`enforced: false`). Per-tenant LLM budgets
  do not exist yet (no tenant on the telemetry row).
- `ci_test_runs` is synced only when Testing & QA is read. If nobody opens it for 24 h, the Quality
  tile is unknown. That is the honest answer, but it can be noisy.
- Moderation & Commerce and Data & Memory have no adapter. Stripe webhook failures and loop
  heartbeats (original Phase 2 text) are not in the revised list and are not built.
- The Feedback screens are not voice-navigable until their phrasings are embedded.

ROUTE_MOUNT: no new route. `GET /api/v1/ops/attention` (VTID-04876) gains `data.domains`.
FINAL_URL: GET https://preview-aws-gateway.vitanaland.com/api/v1/ops/attention
CURL_PROOF: not run before merge (no live endpoint may be called from this session); after deploy
an unauthenticated GET must answer `401 application/json` (staging-tests.json, read-only).

OASIS_PROOF: no new OASIS event types; the new adapters only read `oasis_events`
(`jev.budget.threshold_crossed`, `llm.call.completed`).

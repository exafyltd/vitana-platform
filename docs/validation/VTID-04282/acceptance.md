# VTID-04282 (with VTID-04280, VTID-04281) — Acceptance

One PR, three VTIDs: VTID-04280 unsticks the pipeline, VTID-04281 adds the
supervisor snapshot the screens read, VTID-04282 wires the nine Command Hub
Autopilot tabs to it. This pack covers all three.

## Context — what the owner reported, and what the live data showed (2026-09-22, read-only)

| Report | Root cause found |
|---|---|
| "Active runs frozen, nothing happens after I started them" | Live tab read `/api/v1/automations/runs(/active)` — the tenant-scoped community AP engine, which 400s without a tenant (same defect VTID-04260 fixed on Runs) and has **no run since 2026-08-15** (`automation_runs` max `started_at`). Its 10 s poll also updated state without re-rendering, so the screen stayed on its first load. |
| "Twice-a-day trigger doesn't happen" | `DEV-AUTOPILOT.yml` runs `0 7,19 * * *`; every scheduled scan 2026-09-16 → 09-21 **failed** against the dead GCP URL (fixed by VTID-04225). Since 09-21 scans succeed, delayed 2–5 h by GitHub. Nothing on screen showed cadence. |
| "9 open findings, nobody ingests them" | 5 low/medium findings had **no plan**: `lazyPlanTick` read the top 12 by impact and skipped planned rows — all 12 were planned-but-blocked (9 `operator_onramp`, 3 dev_autopilot), so planless rows were never reached and auto-approve (plan required) never saw them. 3 more were held forever by the PR-flood guard: their prior executions are `reverted` with a `pr_url` whose PR the bridge had already **closed** (#3544/#3547/#3548). 2 are high-risk refactors (human decision by design). |
| "4 blockers nobody fixes" | "Blockers" was the count of rules with `severity=blocker` (what a rule does to a PR when it fires). They had **0 hits in 30 days**. |
| "Auto approve stays at 70%" | 70% = 16 of 23 detectors in the allowlist, not outcomes. Real numbers: 82% of open findings need no human; **0 of 17 self-healing executions succeeded in 7 days**; 118 of 135 executions this week were operator-requested, not autonomous. |
| "5 planned since months" | Registry "Planned" = AP automations with no handler written. They only move when code ships. |

## Acceptance Criteria

AC-1: `lazyPlanTick` plans planless findings that sit below already-planned higher-impact rows (window 200, one batch plan lookup; a plan-lookup failure skips the tick).
TEST: services/gateway/test/vtid-04280-pipeline-unstick.test.ts — "plans the planless rows even when the 12 highest-impact rows are already planned", "skips the tick when the plan lookup fails rather than re-planning everything"

AC-2: `autoApproveTick` reads a 50-row window and pre-filters to planned findings in one query.
TEST: services/gateway/test/vtid-04280-pipeline-unstick.test.ts — "autoApproveTick reads a wide window and pre-filters to planned findings"

AC-3: A PR recorded closed-unmerged (`metadata.pr_closed_unmerged_at`) no longer blocks its finding in any of the three PR-flood guards; a merged PR still blocks.
TEST: services/gateway/test/vtid-04280-pipeline-unstick.test.ts — "all three PR-flood guards use the shared filter", "STRANDED_PR_FILTER excludes rows stamped closed-unmerged"

AC-4: The bridge stamps its own CI-stage PR close; the closed-PR reconciler (every 5 min, 10 rows, re-check after 1 h) stamps closed-unmerged PRs from GitHub, records merged/open ones without unblocking, reads rows that carry only a `pr_url`.
TEST: services/gateway/test/vtid-04280-pipeline-unstick.test.ts — "stamps closed-unmerged PRs, records merged/open PRs without unblocking them", "is rate-limited to once per 5 minutes", "the bridge stamps its own CI-stage close on the row", "prNumberOf falls back to the pr_url (the #3570 row has no pr_number)"

AC-5: `GET /api/v1/dev-autopilot/supervisor` (dev-role, 15 s cache) returns scan cadence, 7-day funnel split by origin, a blocker diagnosis per open finding that mirrors the real gates, failure reasons, impact-rule hits, effective autonomy and alerts.
TEST: services/gateway/test/vtid-04281-dev-autopilot-supervisor.test.ts — all 15 tests (diagnoseFinding, scan cadence, execution funnel, origin split, rule hits, alerts, route wiring)

AC-6: Every Autopilot tab shows the supervisor strip (tiles link to the tab that explains them, alerts link to the tab that acts on them); Live reads real Dev Autopilot executions and re-renders on change; Scanners and Auto-Approve list each open finding with its blocker; Impact Rules shows hits; Registry/Growth state the community engine's real status.
UI: docs/validation/VTID-04282/outputs/*-desktop.png, *-mobile.png — local harness (working-tree statics + the supervisor snapshot produced by the real `buildSupervisorSnapshot()` over the live rows); no JS errors, no horizontal overflow at 1400×900 or 390×844; clicking the "Open findings" tile navigates Live → Scanners.
TEST: services/gateway/test/command-hub (full suite, 1,838 tests with the autopilot suites) + CSP added-lines gate clean

ROUTE_MOUNT: `router.get('/supervisor', requireDevRole, ...)` in `services/gateway/src/routes/dev-autopilot.ts`, on the pre-existing `/api/v1/dev-autopilot` router.
FINAL_URL: `GET /api/v1/dev-autopilot/supervisor`
CURL_PROOF: pre-merge staging — `404 text/html` (route not yet deployed) while sibling `/api/v1/dev-autopilot/spend` returns `401 application/json` (router mounted, dev-role gate live). Post-merge expectation: `/supervisor` → `401 application/json` unauthenticated. Recorded after the staging deploy in commands.log.

OASIS_PROOF: one new event type, `dev_autopilot.execution.pr_closed_reconciled` (added to the `CicdEventType` union in `services/gateway/src/types/cicd.ts`), emitted by `closedPrReconcileTick()` once per execution whose PR GitHub reports closed-unmerged, payload `{ execution_id, pr_number }`, `status: info`, source `dev-autopilot`. Never emitted for merged or open PRs, and never per poll (a state transition only, not a heartbeat).
TEST: services/gateway/test/vtid-04280-pipeline-unstick.test.ts — "stamps closed-unmerged PRs, records merged/open PRs without unblocking them" asserts exactly one emission with that type and payload for the one closed-unmerged row of three. Live signal after merge: rows with this topic in `oasis_events` on staging.

## Not done here, stated plainly

- **Community AP engine (Registry/Growth/Engine) is still not running.** Its triggers were GCP Cloud Scheduler jobs; moving them to EventBridge needs `scheduler:*`/`lambda:*` IAM this session does not have (same wall as VTID-04226), and re-enabling them sends real notifications to members — a product decision. The screens now say so instead of showing empty cards.
- **Agent turn-cap failures** (54 of ~111 failures this week) are the dominant reason executions fail; draft PR #3500 (another session) addresses the exploration budget. Not duplicated here; surfaced on the Live tab.
- **Raising the allowlist %** was deliberately not done: adding rules with 0 hits or detectors whose runs fail does not add autonomy. The Auto-Approve tab now shows the real gap.
- Not verified live until this merges and staging deploys.

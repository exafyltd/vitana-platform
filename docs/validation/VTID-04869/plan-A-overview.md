# PLAN A — Command Hub Overview redesign (supervisor cockpit)

Repo: exafyltd/vitana-platform. Frontend: services/gateway/src/frontend/command-hub/app.js (~2.3MB, no build step).
Goal (owner): a supervisor sees everything that needs immediate attention, in any part of the system; clicking an
issue redirects to the specialized screen with details, circumstances and history.

## Research findings the plan rests on
- Overview reads/writes state.activeModule/activeTab but router uses state.currentModuleKey/currentTab → 60s/30s polls
  never fire; "View all" no-op (app.js 27645, 29237, 30208, 30288, 30350, 30590).
- live-metrics calls navigateTo() which is undefined (31002).
- Shared-health branch wraps as Promise.resolve({status,value}) → results[0].value.map throws (28971/29021).
- /autopilot/pipeline/summary requires service token → 401 from browser → Attention Center says "running smoothly".
- Banner defaults OPERATIONAL on null; "No failures" shown on fetch failure; Vertex/Gemini labels; user counts from limit=200.
- Only 2 of ~11 panels drill down. Inline onclick blocked by CSP.
- Existing aggregators: GET /api/v1/ops/action-required (public, voice+self-heal, deeplinks point to URLs nobody reads),
  /api/v1/admin/health/summary (admin, registry probes, 30s cache), /api/v1/dev-autopilot/supervisor (alerts[]),
  /autopilot/pipeline/summary attention_queue (SVC), /autonomy/pulse.
- ~60 per-domain trouble endpoints exist (ops/runtime/*, ops/health/*, voice/supervisor/*, self-healing/*, governance/*,
  testing/results/summary, routines, approvals, orchestrator budgets, admin/feedback/*, etc.).
- Gaps: SNS/CloudWatch alarms forwarded to GChat only; Jev budget crossings only OASIS events; voice-budget-watch router
  required but never mounted (404); stripe webhook failures unread; no stuck-VTID view; Feedback module not routable.
- Deep links: only ?operator_thread=, ?doc=, ?sub= work. Task drawer (fetchVtidDetail), ledger drawer
  (fetchOasisVtidDetail), voice session drawer, ticket drawer are JS-only.

## Design
Principles: exception-first ranked queue; UNKNOWN (grey) never green when data is missing; every item deep-links to
the exact item; one severity rubric (P1 members impacted now / safety guard tripped; P2 pipeline blocked, budget
crossed, human decision waiting >1h; P3 degraded/trending; UNKNOWN source stale); server-side aggregation.

Layout: Status bar (verdict, P1/P2/P3 counts, sources fresh x/y, prod vs staging commit, kill switch state)
→ "Needs attention now" ranked cross-domain queue with domain filters + Ack/Snooze
→ 13 domain tiles (Platform & Services, Release Pipeline, Voice/ORB, AI & LLM Routing, Autonomy, Operator & VTIDs,
  Governance, Quality, Cost & Budgets, Community & Support, Moderation & Commerce, Data & Memory, Scheduled Jobs)
→ 24h change & incident timeline + key SLI sparklines.

Architecture:
- GET /api/v1/ops/attention (routes/ops-attention.ts, requireAdminAuth). Per-source adapters, parallel, 3s timeout each,
  normalized {id, domain, severity, title, detail, since, count, source, deeplink{section,tab,query}, evidence} +
  sources[] freshness. 20s server cache. Subsumes ops/action-required.
- Frontend: rewrite renderOverviewSystemView; 30s poll via real router state + /events/stream for P1; no inline handlers.
- Deep-link contract: navigateToScreen(section, tab, query) + screens read ?vtid= ?session= ?ticket= ?run=.
- Ack/Snooze: table ops_attention_acks (who, when, reason, expiry, optional VTID), via gateway.
- Overview's other 4 tabs (live-metrics, recent-events, errors-violations, release-feed) → redirects to their specialized
  screens.

## Phases (one VTID + PR each)
0 Stop false signals: state keys, crash, navigateTo, inline onclick, UNKNOWN banner, fetch-failure states, Vertex labels,
  mount voice-budget-watch.
1 Aggregator + new Overview + deep-link contract; route test per adapter; read-only Playwright staging spec.
2 Gap closure: persist SNS alarms as OASIS events, Jev budget adapter, stripe failures, stuck-VTID query, loop heartbeats,
  routable Feedback module.
3 Ack/Snooze (migration + DATABASE_SCHEMA.md), timeline, SLI sparklines, P1 browser notification.
4 Cleanup: tab redirects, delete dead functions and hardcoded lists.
Constraints: command-hub-ownership-guard allowlist per VTID, bump ?v= in index.html, staging tests read-only, no prod tests.

---
# REVISION 2 — planner responses to round 1 (supersedes conflicting text above)

F1 ACCEPTED — Overview is a TRIAGE surface, not the pager; GChat (SNS) stays the paging channel (documented). Response
  carries generated_at; client turns the status bar UNKNOWN after 2× poll interval or any fetch error ("Cockpit blind —
  check GChat"). Out-of-band ALB target-health alarm on vitana-gateway: verify it exists; if missing → separate infra
  VTID (not in this plan).
F2 ACCEPTED — no background polling: computed on demand only while a viewer has the Overview open; per-task
  single-flight + 30s cache; every adapter query time-bounded and indexed, with an adapter table (query, index, budget
  ms) in the Phase 1 spec; per-adapter 3s timeout → source UNKNOWN. Staging computes it (STAGING-VERIFY needs it) and
  labels "Staging build · production data".
F3 ACCEPTED — adapters call service functions in-process (e.g. buildSupervisorSnapshot, pipeline summary builder,
  voice supervisor service); no HTTP self-calls. Endpoint gated platform exafy_admin only (requireAdminAuth);
  tenant admins excluded (no cross-tenant exposure).
F4 ACCEPTED — Phase 1 migrates app.js:30270 to /ops/attention and gates /ops/action-required behind requireAdminAuth
  (test/ops-action-required.test.ts updated). /events/stream not used for P1 push in Phase 1 (polling only).
F5 ACCEPTED — P1 ackable, never snoozable; ack/snooze needs reason + expiry ≤24h; keyed by fingerprint
  (source + entity id); emits OASIS ops.attention.acked / ops.attention.snoozed; RLS platform-admin only. (Phase 3.)
F6 ACCEPTED — fingerprint, grouping (one item + count), open after 2 consecutive observations, clear after 3, since =
  first seen (state kept in-process per task; UNKNOWN is per source). Rubric table below.
F7 ACCEPTED — voice-budget-watch dropped from Phase 0 (Vertex-era); separate question whether a Nova/Polly budget cap
  exists.
F8 ACCEPTED — no SNS ingest. Phase 2 adapter reads CloudWatch alarm state via DescribeAlarms (read-only); the IAM
  task-role permission change is its own infra VTID.
F9 ACCEPTED — Phase 1 = status bar + ranked queue + 7 adapters only. Domain tiles appear in Phase 2 only for domains
  with an adapter; others show "not yet monitored". Timeline/sparklines Phase 3.
F10 ACCEPTED — per-screen deep-link checklist (?vtid= task+ledger drawers, ?session= voice drawer, ?ticket= later,
  ?sub= existing) each with a regression test via real router keys; unresolvable param → toast + list fallback; unit
  test walks every adapter deeplink against NAVIGATION_CONFIG.
F11 ACCEPTED — delegated listeners with data-action; test asserts no "onclick=" in Overview renderers.
F12 ACCEPTED — severity = icon + text label + color; queue aria-live="polite"; keyboard-reachable actions, ≥24px
  targets; Command Hub is admin-facing English by design (stated in code comment).
F13 ACCEPTED — opt-in notifications only on a NEW fingerprint reaching P1 (Phase 3).
F14 ACCEPTED — staging specs assert structure only (status bar, sources freshness, deeplink navigation), never counts;
  writes (ack) via Vitest with mocked DB; docs/validation/<VTID>/staging-tests.json per phase.

Answers: Q1 supervisor = platform exafy_admin. Q2 complement GChat. Q3 resolved dynamically (aws ecs), design is
task-count independent (on-demand + per-task cache). Q4 below. Q5 out of scope (separate question). Q6 other
pipeline/summary consumers (Operator dashboard, runbook) switch to an admin-gated in-process route in Phase 4.
Q7 gateway reads prod + staging build-info server-to-server (URLs from config/env, no hardcoding).

## Phase 1 adapters + rubric (numeric)
| Adapter (in-process) | P1 | P2 | P3 |
|---|---|---|---|
| Service health (health-registry summary) | golden-path service failing ≥2 checks | other service failing ≥2 checks | degraded | 
| Release (staging-verify, prod/staging deploy events, build-info) | prod deploy failed / auto-rollback in last 2h | STAGING-VERIFY failed on latest staging commit | staging verify stale >72h; prod≠staging commit >48h |
| Voice supervisor (verdict_summary) | system_wide critical | segment_specific critical | warning verdict |
| Autonomy (dev-autopilot supervisor alerts + self-healing escalated/rolled_back) | — | critical alert (provider outage, unexpected kill switch), self-heal rolled_back | warning alert |
| Operator pipeline (attention_queue) | — | broken task; stuck >60 min | stuck 30–60 min |
| Governance (controls + violations) | — | any control disarmed; critical violation | other open violation |
| Decisions waiting (PR approvals, self-heal pending-approval, dev-autopilot awaiting approval) | — | waiting >4h | waiting >1h |

## Revised phases
0 Frontend-only false-signal fixes (state keys, crash, navigateTo, inline onclick, UNKNOWN banner, fetch-failure
  states, Vertex labels). One Command Hub VTID.
1 /ops/attention (7 adapters, rubric, dedup/hysteresis, generated_at) + status bar + ranked queue + deep-link contract
  (?vtid=, ?session=) + gate ops/action-required.
2 Tiles for monitored domains; more adapters (CloudWatch DescribeAlarms after its IAM VTID, cost/budgets, tests &
  contracts, routines, support tickets with routable Feedback module, LLM google-fallback, stuck VTIDs).
3 Ack/Snooze (migration, OASIS events), timeline, sparklines, opt-in P1 notifications.
4 Redirect the 4 old Overview tabs; migrate other pipeline/summary consumers; delete dead code.

---
# REVISION 3 — planner responses to round 2 (supersedes conflicting text above)

N1 ACCEPTED — new Phase 1a (own VTID, own PR): extract buildPipelineSummary() from routes/autopilot.ts:1351,
  buildVoiceOverview({window, scope:{is_platform_admin:true}}) from routes/voice-supervisor.ts:198-223, and
  buildHealthSummary() from routes/admin-health.ts; existing routes become thin wrappers with byte-identical
  responses, snapshot tests, npm run test:operator (42e) green. Health: keep the deliberate loopback self-probe,
  documented as "as seen from the serving task".
N2 ACCEPTED — hysteresis is time-based from source timestamps (first_failure_at, self-heal created_at, verdict
  window, claim/heartbeat age), stateless and identical across tasks. Where a source has no timestamp: small
  ops_attention_state table (fingerprint, first_seen, last_seen) written by the gateway, Vitest-covered (moved into
  Phase 1, migration + DATABASE_SCHEMA.md).
N3 ACCEPTED — Command Hub frontend has no Cognito references today (Supabase auth), so requireAdminAuth works for the
  supervisor. Hard dependency recorded: if Command Hub moves to Cognito before/after this ships, the exafy_admin
  KNOWN GAP (auth-supabase-jwt.ts:243) must be closed first (separate VTID). Staging spec signs in as an exafy_admin
  account designated by the owner (not the community test user, which is not admin); read-only.
N4 ACCEPTED — operator adapter filters isAutonomousExecutionTask(); stuck = claim/heartbeat age, not updated_at;
  P3 30–60 min band dropped; P2 = broken, or stuck >60 min by heartbeat.
N5 ACCEPTED — add golden_path:true to service-health-registry entries (Gateway, Auth, ORB/Nova, Supabase/Aurora data
  probes, frontend prod) with registry tests updated; failing ≥2 = failing for ≥2 min by probe timestamps from
  ops_attention_state; kill switch ON = P2 "control engaged" with who/when from OASIS; release adapter topics named:
  staging.verify.passed|failed, staging.deploy.completed|failed, prod.deploy.completed|failed,
  deploy.gateway.failed, deploy.service.failed (dev-autopilot-deploy-topics.ts:49-62, ops-runtime-health.ts:324-336).
  Auto-rollback: prod.deploy.failed implies rollback per VTID-04647; Phase 1a verifies whether a distinct rollback
  topic exists and uses it if so.
N6 ACCEPTED — build-info cached 60s, 5s timeout (testing.ts:273 pattern), UNKNOWN on failure; ALB target-health
  alarm verified = Phase 1 exit criterion before PUBLISH.
N7 ACCEPTED — kill switch has one fingerprint owned by the governance adapter.

Answers: Q1 Supabase (Command Hub has 0 Cognito refs). Q2 own VTID (Phase 1a). Q3 topics listed in N5.

Revised phases: 0 frontend fixes → 1a builder extraction → 1 aggregator + status bar + queue + deep links +
ops_attention_state → 2 tiles + more adapters → 3 ack/snooze, timeline, sparklines, notifications → 4 cleanup.

---
# REVISION 4 — round 3 responses (final; verdict ESCALATED to owner)
N8 ACCEPTED — ops_attention_state primary key and every fingerprint include env (VITANA_ENV); staging and prod
  observations never mix. Whether staging may write env='staging' rows at all → owner decision (default if not:
  staging runs state read-only, "first seen at this request").
N5 minor FIXED — service deploy topic is cicd.deploy.service.failed (dev-autopilot-deploy-topics.ts:50).

---
# OWNER DECISIONS 2026-10-04
6. Staging may write env='staging' rows to ops_attention_state — approved.
7. Staging spec signs in as one of the 2 existing full-access admin test accounts (verify both are registered in
   service_bot_accounts + notification_test_actors before use).
8. ALB target-health alarm on vitana-gateway — approved, separate infra VTID.
Plan A: CONVERGED after owner decisions.

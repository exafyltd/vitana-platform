# VTID-05141 — Plan sparring record (Loop Engineering Phase 3b)

Plan hash (canonical, `services/gateway/src/services/plan-sparring/canonical-hash.ts`, text between the plan markers as approved): `e3c701f52c75e0cfce791c98c61de70bc4c58ee6a91469a7ea4658e03b81ae00`.
Partner: plan-sparring-partner agent (read-only), 2 rounds, standard class. Verdict: **CONVERGED**.
Owner approval: in session 2026-10-13, "Yes" in answer to the Gate 1 message for Loop Engineering Phase 3b.
Gate: allocated with `p_plan_hash` set to the hash above (VTID-05141, ledger id d9872d22-69d3-42a3-b87c-734a71c076ef); this record is referenced from the ledger row's metadata. Parent: VTID-05103.

---

# Loop Engineering Phase 3b — plan for sparring

Parent: VTID-05103 (Phase 3a, live in production at 2541b523). Doctrine: `docs/autonomy/LOOP-ENGINEERING.md` §6 item 3.
Repo: exafyltd/vitana-platform only.

<!-- plan:begin -->
## Change class
standard (a migration seeding catalog rows, gateway services/routes, `.github/workflows`, loop catalog).

## Goal
Close the remaining Phase 3b gaps with the smallest change that turns each "detect only" item into a closed loop on the existing shared engine (routine runner from VTID-05103, `routine_runs`, OASIS, self-healing intake, ops health routes). No new tables, no new UI, no enforcement that can block a member-facing call.

## Parts

### P1 — voice-lab-triage that works (L7)
- Data source: `voice_session_facts` (migration 20261001120000, columns include `started_at`, `outcome` ok/silent/one_way/dropped/error/abandoned/active, `failure_class`, `close_code`). This is the per-session table `routes/voice-supervisor.ts` already reads. `/api/v1/voice-lab/live/sessions` is NOT used (no time window, `error_count` hard-coded 0, voice-lab.ts:840).
- New exported loader `auditVoiceSessionOutcomes({ sinceHours, untilHours })` in `routes/routine-audits.ts` (same pattern as the other audit* functions): counts per window — total ended sessions, sessions with `outcome` in (silent, one_way, dropped, error), and counts by `failure_class`. Read-only PostgREST select on `voice_session_facts` with `started_at` bounds; paged/capped like the existing audits.
- New pure check `checkVoiceLabTriage(yesterday, baseline)` in `checks.ts`, thresholds verbatim from `routines/voice-lab-triage.md`: error_rate_yesterday > baseline × 1.5 with ≥ 3 error sessions; a failure_class new vs the baseline with ≥ 3 sessions; total_yesterday < baseline daily average × 0.3. Breach topic `voice.live.regression.daily_triage`, vtid `VTID-01155` (as the spec says).
- Added to `RUNNER_ROUTINES` at 04:30 UTC. Spec `routines/voice-lab-triage.md` rewritten: data source = voice_session_facts, "Runs in: the gateway's routine runner", "Known broken" line removed, and the dead Cloud Run gateway URL, the routine token and every external HTTP step deleted (round 1, F6). "error code" in the spec becomes "failure_class" (the real classification, `voice-failure-taxonomy.ts`).
- Its September claude.ai trigger is already disabled.

### P2 — every ALERT workflow check has one gateway ops health route (L1, L5, L12)
- Three already have a gateway twin with the same RPC/query: OASIS-LEDGER-INTEGRITY ↔ `/api/v1/ops/health/vtid-ledger`, ORB-SESSION-STATE-HEALTH ↔ `/ops/health/orb-session-ledger`, PUSH-DISPATCH-HEALTH ↔ `/ops/health/push-dispatch` (ops-health-checks.ts:230-258; public, read-only GET routes).
- Add three new ops health checks in `routes/ops-health-checks.ts`, same pattern, same thresholds the workflows use today: `/welcome-greeting` (RPC `ci_welcome_greeting_health`), `/orb-bootstrap-latency` (`orb.live.context.bootstrap` events, the workflow's limit and threshold), `/newday-briefing-loop` (the two `orb.live.diag` queries the workflow runs). Register them in `SERVICE_HEALTH_GROUPS` (`constants/service-health-registry.ts`) in the group of the loop that owns the workflow (L1 for orb-bootstrap, L12 for welcome-greeting and newday).
- Target and ordering (round 1, F1/F2): the workflows monitor production, so they GET the production gateway (`https://gateway.vitanaland.com/api/v1/ops/health/<x>`, public read-only GET, same as any external monitor) and fail the job unless the JSON status is healthy; the two `if: failure()` self-healing report steps stay. A workflow is only switched once its route is live in production:
  - Step A (this PR): the three workflows whose routes are already in production (OASIS-LEDGER-INTEGRITY, ORB-SESSION-STATE-HEALTH, PUSH-DISPATCH-HEALTH) become thin; the three new routes ship in the gateway; the other three workflows are unchanged.
  - Step B (second PR, same VTID, opened only after the production deploy of Step A and a read-only GET of each new route on production returns JSON): WELCOME-GREETING-HEALTH, ORB-BOOTSTRAP-LATENCY and NEWDAY-BRIEFING-LOOP become thin. The VTID is terminalized after Step B.
  - A thin workflow treats a non-JSON or 404 answer as a failure of the check itself (reported, never silently green).
- The duplicated SQL/RPC logic is deleted from the switched workflows, so each check has one implementation (resolves overlaps O2 and O3).
- ALERT-APP-USERS-IDENTITY-DRIFT stays as is (it compares Supabase with Aurora through `rds-data`, which the gateway does not have). Recorded in the catalog as the one exception.

### P3 — SCHEDULED_WORKFLOWS derived from the generated catalog (L1/L4)
- `routes/ops-runtime-health.ts:273-279` hard-codes five workflows. Replace with: read the published test catalog through the existing `services/testing/test-catalog.ts` reader, take every workflow with a non-empty `schedules`, and check those. Any error reading or parsing the catalog (the reader throws on a malformed catalog, test-catalog.ts:85-86) is caught around the whole read-and-filter step and falls back to today's five (so the check never gets weaker than now). Calls to GitHub stay bounded: at most 30 workflows, sequential with the existing helper. Resolves overlap O10.

### P4 — per-loop stop rules on the shared engine (L1, all runner loops)
- Kill switch: the routine catalog `routines.enabled` already stops a runner routine (VTID-05103). Add enforcement of `agents_registry.enabled` (column exists, migration 20260923120000, never enforced): one helper `assertAgentEnabled(agentId)` in `services/orchestrator/run-ledger.ts`, called by every code path that inserts a native `agent_runs` row — audited (round 1, F3): `services/community-autopilot/action-registry.ts:284` and `services/orchestrator/delegation-run-store.ts:153`. `run-lease.ts` writes lease mirrors of other planes and is excluded. A disabled agent's run is refused with an error and one `agent.run.refused_disabled` event. A test greps the gateway source for `from('agent_runs').insert` and fails if a new writer appears without the helper. Legacy planes (dev autopilot, self-healing) keep their own existing kill switches.
- Stagnation stop for the runner (round 1, F4 — defined on run rows, not the counter): after finishing a run with status `failure` (the loader or check errored, not a breach), the runner reads that routine's last 3 `gateway-runner` runs; if all 3 are `failure`, it sets `routines.enabled=false` and emits one `routine.runner.stagnated` OASIS event (status `error`) naming the routine and its last error. Any `success` or `partial` among the last 3 means no stop. A person re-enables it. A real ongoing problem (`partial`) keeps reporting.
- Repeated-breach damping: if the same routine reported the same breach topic on each of the last 3 days, the runner still records the run but does not call `processFailingService` again that day (self-healing already has the incident); it emits the OASIS event as usual. Prevents daily duplicate repair tickets for an open problem.

### P5 — L5 spend budget and silent-fallback incident (L5)
- New runner routine `llm-spend-budget` (06:45 UTC): evaluates the existing shadow budgets in `services/orchestrator/budgets.ts` (platform $200/day, per-agent defaults, from `llm.call.completed` events) over the last 24h. Breach → `llm.spend.budget_exceeded` event (status warning) with the agents over budget. If there are zero `llm.call.completed` events in 24h the run is a `failure` ("no spend data"), never a green pass (round 1, Q3; production had 783 such events in the last 24h, read-only check 2026-10-13). It does not throttle or block any call (enforcement is a later owner decision); it makes the overspend visible daily and routes it to the intake.
- New runner routine `llm-fallback-watch` (07:15 UTC): counts `llm.call.completed` events over the last 24h that `isGoogleLlmCall` (ops-attention-adapters.ts:1294-1301, already exported; matches provider vertex/google/gemini OR a model starting with `gemini`) classifies as Google — reused, not re-implemented (round 1, F5). Both `fallback_used=true` and Google-routed calls are reported, split like `llmGoogleFallbackAdapter`. Any count > 0 → `llm.fallback.google_incident` event with status `error` and routed to self-healing as an incident (CLAUDE.md 10c, IF-THEN 29). Excludes the sanctioned carve-outs (sr/ru voice bridge, audiobook Google TTS) — they are not LLM-router calls and do not appear in `llm.call.completed` with fallback_used.
- Specs `routines/llm-spend-budget.md`, `routines/llm-fallback-watch.md`; catalog rows seeded by one migration (`INSERT … ON CONFLICT DO NOTHING`, like the 05103 seed for mobile-screen-latency-rollup). Both owned by L5 in the loop catalog.

### Catalog and docs
- `specs/loop-catalog-v1.json`: L7 gap text, L5 gap text, L1 gap text, overlaps O2/O3/O10 → resolved; new routines assigned (voice-lab-triage stays L7; the two new routines L5). Coverage rule unchanged and must stay green.
- `docs/autonomy/LOOP-ENGINEERING.md` §6 Phase 3b marked done with the list; `docs/CHANGELOG.md`; `DATABASE_SCHEMA.md` (routines seed rows).

## Out of scope (stays with the owner or later phases)
- Owner: the environment setup script fix, the 13 April-generation claude.ai triggers, rotating the routine ingest token.
- Enforcing LLM budgets (blocking calls), the GCP carve-out window watcher, the consent audit (L5 cases listed for later).

## Files in scope
- services/gateway/src/services/routine-runner/{checks.ts,sources.ts,runner.ts}
- services/gateway/src/routes/routine-audits.ts (auditVoiceSessionOutcomes)
- services/gateway/src/routes/ops-health-checks.ts, services/gateway/src/constants/service-health-registry.ts
- services/gateway/src/routes/ops-runtime-health.ts
- services/gateway/src/services/orchestrator/run-ledger.ts
- services/gateway/src/services/ops-attention-adapters.ts (extract the Google-fallback predicate)
- services/gateway/src/services/orchestrator/budgets.ts (read only; export if needed)
- .github/workflows/ALERT-{OASIS-LEDGER-INTEGRITY,ORB-SESSION-STATE-HEALTH,PUSH-DISPATCH-HEALTH}.yml (Step A); ALERT-{WELCOME-GREETING-HEALTH,ORB-BOOTSTRAP-LATENCY,NEWDAY-BRIEFING-LOOP}.yml (Step B, after production)
- services/gateway/src/services/community-autopilot/action-registry.ts, services/gateway/src/services/orchestrator/delegation-run-store.ts (call the enabled check)
- supabase/migrations/<new>_vtid_<X>_phase3b_routine_seeds.sql
- routines/voice-lab-triage.md, routines/llm-spend-budget.md, routines/llm-fallback-watch.md
- services/gateway/specs/loop-catalog-v1.json, docs/autonomy/LOOP-ENGINEERING.md, docs/CHANGELOG.md, DATABASE_SCHEMA.md
- tests under services/gateway/test/routine-runner/ and test/ops-health/ ; docs/validation/<VTID>/

## Test plan
- Unit (Jest): checkVoiceLabTriage, checkLlmSpendBudget, checkLlmFallbackWatch thresholds (pass/breach each kind); auditVoiceSessionOutcomes query shape with a stubbed fetch; runner stagnation (3 loader failures → enabled=false PATCH + one event; partial never counts); breach damping (3 days same topic → no processFailingService, event still emitted); run-ledger refuses disabled agent; ops health routes welcome-greeting / orb-bootstrap-latency / newday-briefing-loop healthy/degraded/down with stubbed data; SCHEDULED_WORKFLOWS derived from a catalog fixture and fallback to five on read error.
- Workflow tests: each thin workflow calls the production route, treats non-JSON/404 as failure, and keeps the failure()-only report steps (extend status-route-and-workflows.test.ts); Step B extends the same test.
- Agent-run writer guard: a source test fails if any `from('agent_runs').insert` lacks the enabled check.
- loop-catalog.test.ts stays green (every sensor owned once).
- Migration: throwaway local Postgres test (seed idempotent).
- Staging (read-only, staging-tests.json): GET the three new `/api/v1/ops/health/*` routes → 200 JSON with a status field; the runner stays off on staging (status route 401 unauthenticated, as today).
- After the production deploy (read-only): the next day's `routine_runs` rows for voice-lab-triage, llm-spend-budget, llm-fallback-watch.
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] ACCEPTED. Split into Step A (three workflows whose routes are already in production) and Step B (the other three, second PR after the production deploy and a read-only GET proving each route answers JSON). A thin workflow fails loudly on 404/non-JSON.
- F2 [major] ACCEPTED. Target is the production gateway (these alerts monitor production; the routes are public read-only GETs). Ordering above guarantees the route is live in production before a workflow depends on it.
- F3 [minor] ACCEPTED. Audited native `agent_runs` writers: action-registry.ts:284, delegation-run-store.ts:153 (run-lease.ts writes mirrors, excluded). One helper used by both, plus a source test that fails on a new writer without it.
- F4 [minor] ACCEPTED. Stagnation now defined on the last 3 runner rows all being `failure`; `partial`/`success` in between means no stop. The catalog counter is not used for this.
- F5 [minor] ACCEPTED. Reuse the exported `isGoogleLlmCall` (provider OR gemini model name).
- F6 [minor] ACCEPTED. Dead URL, token and HTTP steps removed from the spec.
- F7 [minor] ACCEPTED. try/catch around the whole catalog read+filter, fallback to the five.
- Q1: two PRs, Step A then Step B after production (see F1).
- Q2: see F4 — partial never counts and never needs to reset anything, the rule reads run rows.
- Q3: budgets.ts computes from `llm.call.completed` events, which production emits (783 in the last 24h, 0 with fallback_used, read-only query). Zero events in 24h makes the routine fail loudly instead of passing.


## Round 1 — partner findings (verbatim)

**F1 [major] P2 proposes making six ALERT workflows thin wrappers that GET the production gateway, but three of the six routes do not exist yet -- the plan must handle the bootstrap ordering risk.**
Evidence: only 3 of the 6 routes exist today (`/vtid-ledger`, `/orb-session-ledger`, `/push-dispatch` at `ops-health-checks.ts:230-258`). If the PR ships both the new routes AND the rewritten workflows in one merge, a scheduled ALERT run fires, hits a 404 on the route, and reports a false failure.
Suggestion: (a) split into two PRs (deploy routes first, then rewrite workflows), or (b) a route-existence fallback.

**F2 [major] P2 claims the six workflows will GET the "production gateway" route -- but workflows also fire before production is deployed, and the workflows on `main` cannot know which gateway (staging vs prod) to target.**
Suggestion: decide which gateway the workflow targets; if production, the routes must be in production before the workflow YAML is changed — specify the deployment sequence.

**F3 [minor]** P4 enforces `agents_registry.enabled` in `run-ledger.ts`; confirm no other code path creates agent runs that would bypass this gate.

**F4 [minor]** P4 stagnation stop does not specify whether `consecutive_failures` resets on a `partial` run (`finish_routine_run`, migration 20261012210000:101-104: success resets, failure increments, else unchanged).

**F5 [minor]** P5 describes the predicate as `provider in vertex/google/gemini`, but `isGoogleLlmCall` (ops-attention-adapters.ts:1297-1300) also matches a model starting with `gemini`. Reuse `isGoogleLlmCall` by name.

**F6 [minor]** `routines/voice-lab-triage.md:21` still has the dead GCP `run.app` URL and `ROUTINE_INGEST_TOKEN`; confirm they and the external-HTTP steps are replaced.

**F7 [minor]** P3 fallback: `test-catalog.ts:85-86` throws on a malformed catalog; the fallback must be a try/catch, not a null check.

Questions: Q1 deployment sequence for P2; Q2 does `partial` reset the counter; Q3 are the budgets computed from events that are reliably emitted?

Verdict: NOT CONVERGED (F1, F2).

## Round 2 — partner response (verbatim)

F1 closed. F2 closed. F3 closed ("Verified against the code: the audit is complete"). F4 closed ("Unambiguous"). F5 closed. F6 closed. F7 closed.
"No new blocker or major findings. The revision addressed all seven findings cleanly and introduced no new risk."
Verdict: **CONVERGED** — all round 1 blockers and majors are closed with code-verified evidence.

## Implementation notes (after approval)
- Health groups: the three new routes are in existing groups (Community & Social; AI & Assistant), which the loop catalog assigns to L1. The plan said L12 for welcome-greeting and new-day; L12 owns no health group, and a new group would have widened scope. The workflows themselves stay owned by L12 in the catalog.
- llm-spend-budget runs at 23:50 UTC instead of 06:45: the budgets in `orchestrator/budgets.ts` are per UTC day and `loadSpendToday` reads the current day, so the check reads the whole day just before it closes.
- Dispatcher: a switched-off agent is refused in `delegateToAgent` before any work starts (the run-store gate alone only skipped the run row).

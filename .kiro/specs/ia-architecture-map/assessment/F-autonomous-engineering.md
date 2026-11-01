# F. Autonomous engineering assessment

Covers Loop Engineering, self-healing, VCAOP, verification, learning, health signals, Dev Autopilot and its governance.
For each part it records what is live, what is dark, and where module awareness is missing (directive §7).

## 1. Loop Engineering

The doctrine (`P:docs/autonomy/LOOP-ENGINEERING.md`) has three parts:
- three layers: sensors, 14 loops, one shared engine (`:23-27`);
- an 8-field contract per loop (`:29-43`);
- invariants (`:50-57`).

The shared engine (`:78-80`) is made of:
- the intake: `self_healing_log` and `autopilot_recommendations`;
- the executor: Dev Autopilot;
- the run ledger: `agent_runs_unified`;
- the human inbox: Autonomy Pulse;
- a claim verifier and red-flag rules. Both verifiers have `existing_ref: null`, so they are not built.

**Catalog use.**
- The catalog is `P:services/gateway/specs/loop-catalog-v1.json`. Its only runtime consumer is
  `GW/services/loop-catalog.ts`, which loads it, validates it and serves it read-only at `/autonomy/loops`
  (`GW/routes/autonomy-loops.ts:20`).
- `test/loop-catalog.test.ts` checks the contract, the R2/R3 gates, that every `existing_ref` resolves, and that each
  sensor has a single owner.
- **The catalog has no `owner` field.** `human_gate` is the only accountability field.
- Its live signal is per plane, not per loop. Nothing routes incidents or gates actions by loop.

| Loop | Name | Status | Trigger | Actuator | Human gate |
|---|---|---|---|---|---|
| L1 | Repair | partial | any owned sensor red | `self_healing_log` → six-layer diagnosis → spec → Dev Autopilot | spec approval, rollback |
| L2 | Build and Release | **live** | approved finding, or merge to main | plan → PR → LLM review → merge → staging → STAGING-VERIFY → Gate 2 | approval gates, Gate 2 |
| L3 | Learn | partial | finished L1/L2/L6 run, escaped bug, shadow eval | write lesson, propose graduation | owner |
| L4 | Simplify | planned | orphan or double-owned sensor, dead code | removal PR | owner |
| L5 | Guard | partial | cost, fallback, secret, consent or ledger signal | escalate only | owner/DPO |
| L6 | Support | **live** | member ticket | triage → Devon/Sage → supervisor → executor | human activates dispatch |
| L7 | Voice quality | partial | daily voice outcomes | tuning PR | owner |
| L8 | Content and language | partial | new string or content | propagate and audit 11 locales | human merge |
| L9 | Supplier catalog | partial | supplier feed or stock | normalise and validate | human publish |
| L10 | Listing and creator commerce | planned | listing or video | variants under the claim verifier | creator/supplier |
| L11 | Trust | planned | review or report | classify, hold | moderator |
| L12 | Engagement | partial | every notification | propose cadence | human |
| L13 | Community matching | partial | daily recompute | recompute, propose | supervisor/tenant admin |
| L14 | Health coaching | partial | check-in, consent | prepare cart (never execute) | member |

## 2. L1 to L5 in code

| Loop | Code | Scheduler | Tables | State |
|---|---|---|---|---|
| L1 Repair | `GW/routes/self-healing.ts`; `GW/services/self-healing-*.ts`; `dev-autopilot-bridge.ts`; `routine-runner/runner.ts`; `voice-self-healing-adapter.ts` | in-process reconciler (`GW/index.ts:2146`); hourly routine runner, each routine once a day; `ALERT-*` crons | `self_healing_log`, `self_healing_snapshots`, `system_config`, `autopilot_recommendations`, `routine_runs`, `vtid_ledger` | live (reporting gap in §3) |
| L2 Build and Release | `dev-autopilot-execute.ts` (4,543 lines), `-watcher`, `-bridge`, `-approval*`, `-llm-review`, `-safety`, `-retry-breaker` | `DEV-AUTOPILOT.yml`, `DEV-AUTOPILOT-IMPACT.yml`, `STAGING-VERIFY(-NIGHTLY).yml` | `dev_autopilot_executions`, `_config`, `_outcomes` | live |
| L3 Learn | `routine-runner/learn-outcomes.ts` (VTID-05148), `dev-autopilot-outcomes.ts`, `repair-pattern-store.ts` | daily 12:00 UTC | `self_healing_log.diagnosis.tests_added`, `routine_runs.findings` | live in prod (runner pinned on there) |
| L4 Simplify | coverage test only; Phase 2 removals were done by hand (VTID-05098) | — | — | dark |
| L5 Guard | `GW/routes/ops-health-checks.ts`; routines `llm-spend-budget` (23:50), `llm-fallback-watch` (07:15); `agents_registry.enabled` as kill switch | routine runner | — | partly live. The plan-sparring reconciler is dark. |

## 3. Self-healing pipeline

**Intake:** `POST /api/v1/self-healing/report` (`GW/routes/self-healing.ts:402-537`, `requireServiceOrAdmin`).
- `system_config.self_healing_enabled` fails closed (`:79-101`). An autonomy-level error falls back to OBSERVE_ONLY.
- Accepted endpoints: keys of `ENDPOINT_FILE_MAP`, `/alive`, `/api/v1/self-healing/health`, `voice-error://<class>` and
  `routine-incident://x/y` (`:468-499`). Anything else is skipped as "Unknown endpoint".

**Reporting gap [code].** All seven `ALERT-*.yml` workflows call `scripts/ci/report-to-self-healing.sh` with an
`alert-workflow://ALERT-…` endpoint. That form matches neither synthetic pattern. `ENDPOINT_FILE_MAP` has no
`alert-workflow://` keys (`GW/types/self-healing.ts`: 0 matches). The intake therefore skips these reports.
- The ALERT runs still fail visibly in GitHub, but they create no VTID and no diagnosis.
- The script also defaults to the staging gateway (`report-to-self-healing.sh:25`), which shares the production database.

**Other sensors that never reach the intake:**
- CloudWatch/SNS alarms go only to Google Chat (`GW/routes/aws-sns-alerts.ts:1-25`, `:134`).
- `VCAOP-HEALTH` files a GitHub issue instead (§4).

**Incident to fix** (`processFailingService`, `GW/routes/self-healing.ts:207-370`):
1. dedup and circuit breaker;
2. 5 s re-probe (recovered → no VTID);
3. at level 0, stop;
4. `beginDiagnosis` allocates a VTID; at level 1, stop;
5. triage agent when confidence is below 0.8; escalate below 0.5;
6. fix spec;
7. level 2 waits for a human; level 3 auto-approves at confidence ≥ 0.8; level 4 at ≥ 0.5;
8. inject into Dev Autopilot.

The injector (`GW/services/self-healing-injector-service.ts`) does three things:
- maps 14 service names to the ledger modules GATEWAY, OASIS, COMHU or AGENTS (default GATEWAY);
- stores a dedupe key;
- **refuses any source outside `services/gateway/src/**`.**

So incidents in other services or in V1 cannot become autonomous fixes.

**Fix mode.** Watchers move an execution through CI → merge → deploy → verify. A failure goes through
`bridgeFailureToSelfHealing` to triage, then auto-revert. After that it either spawns a child (confidence ≥ 0.5, under
the depth cap) or escalates. A CI failure keeps the same PR (`test/vtid-04465…:666-742`).

**Reconciler.** Rows pending for more than 60 minutes are re-probed and re-dispatched at most twice, then escalated.

**Gates and defaults:**

| Gate | Default | Evidence |
|---|---|---|
| `self_healing_enabled` / `self_healing_autonomy_level` | seeded `true` / `3` (auto-approve at confidence ≥ 0.8). Both fail closed. **Live values not visible.** | `20260402000000_self_healing_tables.sql:66-69` |
| `autopilot_execution_enabled` (EXECUTION_DISARMED) | a missing row means **armed** | `GW/services/system-controls-service.ts:453-460` |
| `dev_autopilot_config.kill_switch` | bridge escalates, watchers skip | `dev-autopilot-bridge.ts:1006-1027` |
| Retry breaker | 5 failures per 24 h; turn-cap failures snooze 7 days | `dev-autopilot-retry-breaker.ts:58` |
| Outage gate | after 1 outage, one probe execution; after 3, none (30 min window) | `test/vtid-04465…:516-559` |
| Production claims | only with `DEV_AUTOPILOT_PROD_CLAIM_ENABLED=true` (not pinned) | `dev-autopilot-env-ownership.ts:67` |

## 4. VCAOP healing: a second stack

VCAOP ("Vitanaland Commerce and Account-Operations Platform") was built autonomously as a dev/staging, mock-first
platform (`P:vcaop/CURRENT-STATE.md`; `FINAL-REPORT.md`: draft PR #2585, 159 tests).

**Its own healing:**
- `P:vcaop/SELF-HEALING-PLAN.md` defines detect → diagnose → remediate → verify → restore-or-escalate, with six failure
  categories and a bounded ladder in which guardrail failures are never auto-healed.
- Code: `P:services/vcaop/src/healing/orchestrator.ts`, `runner.ts`, `health-probe.ts`, with an in-memory OASIS sink.

**Deployment:**
- `VCAOP-HEALTH.yml` runs Jest hourly and opens a GitHub issue on failure.
- `VCAOP-CICD.yml` deploy-dev is gated and targets Cloud Run, which is dead after the GCP decommission.
- The gateway mounts its own routes over the live VCAOP tables (`GW/routes/vcaop.ts:1-13`; `GW/index.ts:364-371`).
- The healing library itself is not deployed.

**Relationship to the central pipeline: none.**
- VCAOP writes no `self_healing_log` rows, allocates no VTIDs and does not use Dev Autopilot.
- It emits OASIS-shaped events with the same `source: 'self-healing'` label, which can be mistaken for the central
  pipeline in queries.
- Its concepts duplicate the gateway's: categories vs `failure_class`, ladder vs autonomy levels, human task vs
  Autonomy Pulse, GitHub issue vs intake.
- **Decision needed:** bridge it into the central intake, or retire the VCAOP healing code. Directive §7.2 forbids a
  second healing orchestrator.

## 5. Verification

- **Verification engine.** Source: `P:services/agents/vitana-orchestrator` (`server.py`: "does NOT claim completion";
  `stage_gate.py` emits `vtid.stage.verification.*`).
  - It is called by the worker orchestrator (`GW/services/worker-orchestrator-service.ts:1210`, `:1238`), **not by Dev
    Autopilot**.
  - It runs on ECS with no ALB.
- **STAGING-VERIFY.** `.github/workflows/STAGING-VERIFY.yml` and `scripts/ci/staging-verify/run.mjs`:
  - confirm the deployed commit;
  - run the smoke suites and the change suites of every commit between production and staging (read-only);
  - record `staging.verify.passed|failed|superseded` in OASIS.
  - The nightly full run at 02:17 must be younger than 24 h for Gate 2.
- **Change suites.** `docs/validation/<VTID>/staging-tests.json`: `{vtid, service, tests:[{kind:"http", path,
  expect_status, expect_content_type, expect_body_contains}]}`, plus kind `existing` (a Jest command). There are 382
  such files in platform and 208 in V1.
- **Production deploy safety** (VTID-04647). `AWS-PROD-DEPLOY-GATEWAY.yml` captures the live task definition, runs GET-only
  post-deploy checks, and rolls back on failure (`:851-867`, `:1674-1732`). The same pattern is in the operator,
  projector, orb-agent and verification-engine deploys.
- **Dev Autopilot's own verify step.** It passes when no new error events appear in a window after deploy (VTID-04625).
  The Jev fix-verification gate is shadow-only and notes that "no new errors" passes findings that have no probeable
  endpoint (`GW/services/jev/gates/fix-verification-gate.ts:1-18`).

## 6. Health signals

| Signal | Scope | Note |
|---|---|---|
| `/alive`, `/health` on the gateway | process | Both return constants (`GW/index.ts:627-634`). The service health registry nonetheless lists `/health` as golden-path "Gateway", and MORNING calls it the "core aggregate". **This misleads.** |
| `/api/v1/admin/health/summary` | grouped by `SERVICE_HEALTH_GROUPS` | Runs registry checks over loopback |
| `/api/v1/ops/health/*` (`GW/routes/ops-health-checks.ts:308-401`) | per signal: vtid-ledger, orb-session-ledger, push-dispatch, welcome-greeting, orb-bootstrap-latency, newday-briefing-loop | Polled by the `ALERT-*` crons |
| `ci_vital_systems_health()` | platform-wide (AI provider governance, locale coverage) | MORNING and ops-health-checks |
| `MORNING-SYSTEM-HEALTH-CHECK.yml` | one platform roll-up at 06:00 UTC | Claimed by two MT plans (B §8) |
| `admin-health-index` | per tenant | Scores a missing data family as 60 ("neutral unknown") |
| Context source health (`GW/orb/context/context-source-health.ts`) | per ORB compile, per source | Emits `assistant.context_source_degraded` |
| Screen load (`/api/v1/frontend/screen-load/*`) | per screen | Playwright twice an hour, plus RUM |

No signal carries a module key, so health cannot be reported per module today.

## 7. Learning

- **`dev_autopilot_outcomes`** records decisions and outcomes, keyed by `scanner_name` and `risk_class`.
- **`learn-outcomes`** (VTID-05148) does three things:
  - fills `diagnosis.tests_added` from fix PRs, and files a `write_test` finding when a fix shipped no test;
  - proposes graduations on Mondays (at least 20 runs and 95 % success). It never applies them.
  - computes metrics. Pattern reuse is `not_measured`.
- **Repair patterns** (`repair-pattern-store.ts`) match on exact signature and quarantine after 2 failures.
  - The lookup is wired only into the test-contract scanner.
  - Auto-recording is not built (`GW/routes/repair-patterns.ts:8-11`).
  - The route is exafy-admin only.
- **Into planning:**
  - The planner prompt includes `watcher_lessons` filtered by scanner (`dev-autopilot-planning.ts:463-488`).
  - File-scoped `dev_agent_memory` recall exists for planner, worker and validator, but all three flags are off by default
    and not pinned (`dev-agent-memory-file-recall.ts:1-39`).

**Learning keys are scanner, risk class and signature. None of them is module, tenant or role.**

## 8. Governance of autonomous producers

- **Plan sparring** (VTID-04868):
  - A `BEFORE INSERT ON vtid_ledger` trigger checks for a sparring record.
  - `plan_sparring_config.mode` is seeded `'log'`, which never blocks (`20261004110000…sql:117`).
  - The only policy class is `converged-auto-v1`.
- **Autonomous producers have no sparring path.** Self-healing (`beginDiagnosis`) and Dev Autopilot
  (`dev-autopilot-vtid-allocate.ts`) call `allocate_global_vtid` with no sparring arguments.
  - Today they are only logged as `missing`.
  - **Switching the gate to `enforce` would stop both**, because no machine-producer policy exists.
  - The hourly reconciler that would flag bare rows is off (`PLAN_SPARRING_RECONCILER_ENABLED`).
  - This conflicts with CLAUDE.md rule 51, which applies to self-healing and Dev Autopilot too. It needs an owner
    decision before autonomy is widened.
- **Project Manager** (VTID-05216): observe and decide; it never acts outside the §7b merge rule. It refuses governance
  paths. `PM_MODE=live` on staging only. No link to self-healing or Dev Autopilot state was found [unverified].
- **Governance evaluate** fails open (D §7).

## 9. Live vs dark

| Control | Default | Pinned | State |
|---|---|---|---|
| `ROUTINE_RUNNER_ENABLED` | off unless `'true'` | prod true, never staging | live in prod |
| `self_healing_enabled` / autonomy level | seeded true / 3 | DB | live (value not visible) |
| `SELF_HEALING_RECONCILER_ENABLED` | on unless `'false'` | — | live |
| `DEV_AUTOPILOT_EXECUTOR_ENABLED` / watchers | on unless `'false'` | prod true | live |
| `DEV_AUTOPILOT_WATCHER_LIVE`, `DEV_AUTOPILOT_LLM_REVIEW_ENABLED` | off | prod and staging true | live |
| `DEV_AUTOPILOT_PROD_CLAIM_ENABLED` | off | — | staging executes; production does not claim |
| `DEV_AUTOPILOT_PR_APPROVAL_REQUIRED` | — | staging true, prod unset | hold on staging only |
| `AUTOPILOT_LOOP_ENABLED` | off unless `'true'` | — | unknown |
| `plan_sparring_config.mode` | `log` | migration | non-blocking |
| `PLAN_SPARRING_RECONCILER_ENABLED` | off | — | dark |
| `PM_AGENT_ENABLED` / `PM_MODE` | off | staging true/live | staging only |
| `DEV_AUTOPILOT_{PLANNER,WORKER,VALIDATOR}_MEMORY_ENABLED` | off | — | dark |
| `JEV_TEST_SELECTION_MODE`, `JEV_FIX_VERIFICATION_MODE` | off/shadow | — | shadow at most |
| VCAOP dev deploy | gated by repo variable | — | dark |

## 10. Gaps for module-aware self-healing and learning (directive §7.2, §7.3)

1. **No module key.** `self_healing_log` has no module, domain, tenant or role column, and no later migration adds one
   (`20260402000000…sql:8-28`). Tenant appears only inside voice rows' `diagnosis` JSON. The same holds for
   `dev_autopilot_outcomes` and repair patterns.
2. **No join key across taxonomies.** Atlas domains, health groups, ledger modules, impact-rule categories,
   service-path-map and loop-catalog groups cannot be joined. `DOMAIN_ATLAS` is used only by the developer ORB.
3. **Autonomous fixes are limited to `services/gateway/src/**`.**
4. **No test selection by module.** Selection is by paired test name or commit range. Import-graph selection is
   shadow-only (`GW/services/jev/gates/test-selection-gate.ts:1-21`).
5. **Health signals that check nothing** (§6).
6. **Sensors that never reach the intake:** `ALERT-*` reports are skipped (§3); SNS goes to Chat; VCAOP files issues.
7. **No per-loop routing.** L5 (escalate-only) and L12 findings enter the same L1 intake.
8. **Duplicate healing stack** in VCAOP (§4).
9. **No sparring path** for autonomous producers (§8).
10. **Loops have no owner**, and the live signal is per plane.
11. **The verification engine is not on the Dev Autopilot path.** Dev Autopilot's own check is "no new errors in a
    window".
12. **Learning is not measured or recorded:** pattern reuse is not measured, auto-recording is not built, and memory recall
    is dark.

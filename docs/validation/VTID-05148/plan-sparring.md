# VTID-05148 — Plan sparring record (Loop Engineering Phase 4 — L3 Learn)

Plan hash (canonical, `services/gateway/src/services/plan-sparring/canonical-hash.ts`, text between the plan markers as approved): `2ff9db7316b4e71545b894ad35adea1df1c19bee92f7c4c2c973b9861ab15999`.
Partner: plan-sparring-partner agent (read-only), 2 rounds, standard class. Verdict: **CONVERGED**.
Owner approval: in session 2026-10-13, "Continue" in reply to the status message whose open item was the Phase 4 Gate 1 question.
Gate: allocated with `p_plan_hash` set to the hash above (VTID-05148, ledger id e1ff1a7e-2c02-435a-8281-4363a68bf7ed); this record is referenced from the ledger row's metadata. Parent: VTID-05141.

---

# Loop Engineering Phase 4 — L3 Learn — plan for sparring

Parent: VTID-05141 (Phase 3b). Doctrine: `docs/autonomy/LOOP-ENGINEERING.md` §6 item 4. Catalog: L3 Learn (`services/gateway/specs/loop-catalog-v1.json:238-307`).
Repo: exafyltd/vitana-platform only.

<!-- plan:begin -->
## Change class
standard (gateway services and routes, Command Hub Autonomy Pulse source, loop catalog; one additive seed migration for the routine's catalog row, nothing else).

## Goal
L3's catalog goal: "each outcome leaves exactly one lesson … verified against the next runs of the same class: repeat-failure rate must fall". Today outcomes are recorded (`dev_autopilot_outcomes`, `self_healing_log`, `repair_patterns`, `watcher_lessons`) but nothing reads them to act (`dev-autopilot-outcomes.ts:6-10`: "the policy that acts on these rows is a follow-up"). Phase 4 adds the smallest closed loop on top of what exists: measure, turn every fix without a regression test into a write-test finding, and propose (never apply) graduations. No new table or column, no executor change, and no autonomy level is ever changed by code.

## Parts

### P1 — Escaped bug becomes a test (cases Q02, Q05)
- Which fixes shipped a test is read from the fix's own PR, not from the executor (round 1, F1/F3: the changed-file list is not stored on `dev_autopilot_executions` and `recordExecOutcome` takes no metadata — neither is changed). The daily `learn-outcomes` routine (P3) takes `self_healing_log` rows with `outcome='fixed'` and a `diagnosis.pr_url` (written by `writeAutopilotSuccess`, `dev-autopilot-self-heal-log.ts:230-326`) that have no `diagnosis.tests_added` yet, fetches that PR's changed files from GitHub with the token the gateway already uses for workflow reads (`GITHUB_SAFE_MERGE_TOKEN`/`GITHUB_TOKEN`, as `ops-runtime-health.ts` does), and records `diagnosis.tests_added: string[]` (files matching `*.test.ts`, `*.test.cjs`, `*.spec.ts`, or under `test/`/`__tests__/`) by a read-modify-write: the routine already reads the row's `diagnosis`, merges `tests_added` into it, and PATCHes the whole `diagnosis` back (round 2, F7 — a bare PATCH would overwrite summary, execution_id, pr_url…). At most 50 PRs per run; a GitHub error leaves the row for the next run (never written as "no tests").
- Feedback-ticket fixes need no separate change (round 1, F2): the bridge creates a normal `dev_autopilot_executions` row, and completion goes through the same `patchExecution` → `writeAutopilotSuccess` path, so they appear in `self_healing_log` like any other fix.
- A fix whose PR shipped no test (`tests_added` empty) is an escaped-bug lesson: the routine creates ONE `write_test` finding for it through the existing missing-test path (the `autopilot_recommendations` insert in `routes/test-contracts-missing.ts:275-312`: scanner `missing-test-scanner`, `repair_kind: 'write_test'`), exported for reuse without behaviour change, deduped by the fix's VTID + endpoint so it is created once. Auto-exec eligibility stays exactly what that path already sets.

### P2 — Graduation proposals, never applied (case E04)
- Weekly (Mondays) the `learn-outcomes` routine groups `dev_autopilot_outcomes` of the last 30 days by `(scanner_name, risk_class)`, counting only rows with `exec_outcome IS NOT NULL` (round 1, F6). All conditions read `dev_autopilot_outcomes` (round 1, Q3): ≥ 20 such executions, success rate (`exec_outcome='success'`) ≥ 95 %, zero `exec_outcome='rolled_back'`, zero `human_modified_plan=true`, and the class's findings are not already `auto_exec_eligible` (read from `autopilot_recommendations`).
- Each candidate → one OASIS event `learn.graduation.proposed` (status info) with the class, counts, window and the rule that would change. Applying it stays a human decision on the existing config surfaces; code never flips `auto_exec_eligible`, `self_healing_autonomy_level` or any flag.
- Auto-withdraw (catalog stop rule): a class with an open proposal whose next 30-day success rate drops below 90 % or that gets a rollback → `learn.graduation.withdrawn`.
- Autonomy Pulse gets a fifth source `graduation_proposal` (open proposals = proposed and not withdrawn, from oasis_events), read-only with an "Open" link like the VTID-05098 items; same fetch/normalize/aggregate pattern as the four existing sources (`routes/autonomy-pulse.ts:89-96` type, `202-412` normalize/fetch/aggregate).

### P3 — The `learn-outcomes` routine and the L3 metrics
- New gateway-runner routine `learn-outcomes` (daily 12:00 UTC; graduation step only on Mondays). It computes the three L3 metrics the catalog names, from existing tables, and stores them in the run's `findings`:
  - repeat-failure rate per class (round 1, Q2 — defined on `outcome`, not on failure_class names): a fix is a `self_healing_log` row with `outcome='fixed'`; it is repeated when a row for the same `endpoint` with `outcome` in (`pending`,`failed`,`escalated`) is created within 7 days after it. Rate = repeated fixes / fixes, last 30 days, grouped by the fixed row's failure_class;
  - share of fixes reusing a known pattern: fixes whose execution referenced a `repair_patterns` row (reported as `not_measured` with the reason if no execution records it — no number is invented);
  - escaped bugs that became tests: fixed rows with non-empty `tests_added` over fixed rows (only rows written after P1; older rows are `unknown`, not counted as missing).
- Breach (routes to the intake like every routine): repeat-failure rate for a class above 30 % with ≥ 5 fixes → `learn.repeat_failure.high`.
- Spec `routines/learn-outcomes.md`; catalog row seeded in the same way as VTID-05141 (one additive migration is the exception to "no migration": it only inserts the `routines` row, ON CONFLICT DO NOTHING).
- `GET /api/v1/autonomy/loops` returns, for L3, the latest `learn-outcomes` findings as `metrics_latest` (read from `routine_runs`); the Loops screen shows the three numbers on the L3 card.

### Catalog and docs
- L3 status stays PARTIAL; gap text updated (what is measured, what is still recorded-only: repair-pattern auto-record and prompt-learning graduation). `learn-outcomes` owned by L3. Doctrine §6 item 4, CHANGELOG, DATABASE_SCHEMA (the seed row; the two jsonb keys documented).

## Out of scope
- Applying any graduation; changing autonomy levels; auto-recording repair patterns (PR-L5.1); graduating `watcher_lessons`; shadow-model promotion (V10, already its own CRON workflows).

## Files in scope
- (no executor change) the routine PATCHes `self_healing_log.diagnosis` only
- services/gateway/src/services/routine-runner/{checks.ts,sources.ts} + a new `learn-outcomes.ts` loader
- services/gateway/src/routes/test-contracts-missing.ts (export the finding insert for reuse, no behaviour change)
- services/gateway/src/routes/autonomy-pulse.ts; services/gateway/src/frontend/command-hub/app.js (Pulse card label for the new source) + index.html ?v=
- services/gateway/src/services/loop-catalog.ts, routes/autonomy-loops.ts, frontend loops-catalog.js
- supabase/migrations/<new>_vtid_<X>_learn_outcomes_routine_seed.sql; routines/learn-outcomes.md
- services/gateway/specs/loop-catalog-v1.json, docs, tests, docs/validation/<VTID>/

## Test plan
- Unit: tests_added from a stubbed PR-files response (test file patterns; non-test files ignored; GitHub error leaves the row untouched; cap 50); the learn-outcomes metrics on fixture rows (repeat within 7 days counted, outside not; old rows without tests_added = unknown); write_test finding created once per fix (dedupe) and not for fixes with tests; graduation candidate rules (each threshold boundary, already-eligible class skipped) and withdrawal; no code path writes auto_exec_eligible/autonomy level (source test); Pulse fifth source normalize + filter + counts; loops API metrics_latest for L3.
- Migration seed on throwaway Postgres; loop-catalog test green; full gateway suite.
- Staging (read-only): `GET /api/v1/autonomy/pulse` and `/api/v1/autonomy/loops` unauthenticated → 401 JSON (routes still gated); Command Hub bundle carries the new marker.
- After production (read-only): first `learn-outcomes` run row with the three metrics.
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] ACCEPTED. tests_added now comes from the fix PR's changed files, read by the daily routine via the GitHub API (pr_url is already in diagnosis), not from the executor. No executor change.
- F2 [major] ACCEPTED. The feedback bridge line is removed; feedback fixes go through the same patchExecution → writeAutopilotSuccess path.
- F3 [major] ACCEPTED (moot). Nothing is written to dev_autopilot_outcomes.metadata; recordExecOutcome is untouched.
- F4 [minor] ACCEPTED. Line refs corrected.
- F5 [minor] ACCEPTED. Change class states the one seed migration.
- F6 [minor] ACCEPTED. Graduation counts only exec_outcome IS NOT NULL rows; rolled_back counted within them.
- Q1: GitHub PR files API in the routine, capped, errors retried next run.
- Q2: defined on `outcome` (fixed vs pending/failed/escalated on the same endpoint within 7 days).
- Q3: all graduation conditions read dev_autopilot_outcomes; eligibility from autopilot_recommendations.

## Round 2 — partner verdict
F1–F6 closed (verified: diagnosis.pr_url written at dev-autopilot-execute.ts:2461 via dev-autopilot-self-heal-log.ts:302; GitHub token used at ops-runtime-health.ts:541; feedback fixes go through patchExecution). New minor F7 (jsonb PATCH needs read-modify-write) — ACCEPTED, plan text updated. New minor F8 (runner only runs in production) — informational, no change. Verdict: **CONVERGED**.

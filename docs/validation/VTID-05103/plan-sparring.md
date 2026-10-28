# Plan sparring record — VTID-05103

Plan hash (canonical, `services/gateway/src/services/plan-sparring/canonical-hash.ts`, text between the plan markers as approved): `c64cb261f5380d9165ff67175c552d1a62eef55295f46ef729680453eb6edd7a`.
Partner: plan-sparring-partner (read-only, independent). Class: standard. Verdict: **CONVERGED** after 2 rounds; mid-flight amendment A1 **CONVERGED** in round 3 (same partner).
Owner approval: in session 2026-10-12, "Yes" in answer to the Gate 1 message for Loop Engineering Phase 3a.
Gate: allocated with `p_plan_hash` set to the hash above and no `p_sparring_id`; this record is referenced from the ledger row's metadata (`sparring_record`). Parent: VTID-05098.

---

# Loop Engineering Phase 3a — Close L1: routines run inside the gateway, alerts reach the one intake

Parent: VTID-05084 (loop catalog), VTID-05098 (Phase 2, live in production 98ebdab1).
Change class: **standard**.
Scope (system areas): gateway services + one route file, one migration, 7 ALERT-* workflow files + 1 shared CI script, prod deploy workflow (one pinned env var), loop catalog + doctrine, tests, evidence.

<!-- plan:begin -->
## Problem (verified 2026-10-12)

1. **No routine produces a signal.** Every September-generation claude.ai routine trigger fails ~3 s after firing (`RUN_ERRORED`). Transcript of session `cse_013fvK2yMDvS7FxuW7rkedcF` (oasis-event-anomaly): the cloud environment's setup script runs `cd vitana-platform/services/gateway`; routine sessions clone no repo, so it exits 1 before the prompt runs. The April-generation triggers post to the deleted Cloud Run gateway.
2. **The routines don't need an AI session.** 10 of the 14 files in `routines/` are deterministic: curl a gateway data endpoint, apply fixed thresholds, open/close a `routine_runs` row, and on breach POST `/api/v1/events/ingest` (which `routes/events.ts:132-162` routes to `processFailingService` when `source` starts with `routine.` and status is warning/error). Running them as LLM sessions costs money, needs the ingest token pasted in plain text into every prompt, and depends on an environment setup script.
3. **Alert workflows don't reach the intake.** The 7 `ALERT-*.yml` scheduled workflows only `exit 1`; only `E2E-ORB-MONITOR.yml` POSTs `/api/v1/self-healing/report` on failure. A red ALERT run is seen by nobody unless someone opens Actions.
4. Three routine docs (dyk-tour-progress, knowledge-docs-freshness, spec-memory-quarantine) emit events without `source: routine.*` / `status`, so even a working run would not reach self-healing.

## Plan

### A. One in-gateway routine runner (replaces 10 LLM routines)
- New `services/gateway/src/services/routine-runner/`:
  - `checks.ts` — one pure function per routine: `(data) → { status: 'success'|'partial'|'failure', summary, findings, breach?: { topic, payload } }`. Thresholds ported **verbatim** from each `routines/<name>.md` (unit-tested against the doc's own examples).
  - `sources.ts` — one loader per routine, calling the **same code** the HTTP route uses today. Every source, by strategy:
    - (a) **Extracted from `routes/routine-audits.ts`** (8): oasis-event-anomaly ← `oasis-summary` (:86), supabase-io-audit ← `io-pressure` (:143), autopilot-rec-quality ← `autopilot-recs` (:238), vitana-index-health ← `vitana-index` (:281), knowledge-docs-freshness ← `knowledge-docs-staleness` (:358), dyk-tour-progress ← `dyk-tour-progress` (:414), spec-memory-quarantine ← `spec-memory-quarantine` (:456), mobile-screen-latency-rollup ← `mobile-screen-latency` (:526). Each handler body becomes an exported `auditX(params)` function in the same file; the route calls it (thin wrapper, same response shape). The stale header comment (lists 4) is corrected.
    - (b) **Extracted from `routes/agents-registry.ts`** (1): agents-heartbeat ← handler at :147 (`supabaseRequest` + `deriveStatus`) becomes exported `readAgentsRegistry({ status? })` in the same file; the route wraps it.
    - (c) **Extracted from `routes/voice-lab.ts`** (1): voice-lab-triage ← handler at :751 (`queryVoiceLabEvents` for start/end events) becomes exported `listLiveSessions({ status, sinceHours, untilHours })` in the same file; the route wraps it.
    - No new queries are written; no loader calls HTTP.
  - `runner.ts` — `startRoutineRunner()`: hourly `setInterval(...).unref()` tick (same pattern as `startSlowSessionScheduler`). For each routine whose UTC run hour has passed today and that has not run today: **claim** the day atomically, load, check, record, route.
  - Routines covered (10): agents-heartbeat, autopilot-rec-quality, dyk-tour-progress, knowledge-docs-freshness, mobile-screen-latency-rollup, oasis-event-anomaly, spec-memory-quarantine, supabase-io-audit, vitana-index-health, voice-lab-triage. Each keeps its documented UTC hour.
- **Recording:** writes the same `routine_runs` rows (`trigger: 'gateway-runner'`) the routes already write, so Command Hub → Routines tiles keep working unchanged.
- **Breach routing:** emits the same OASIS event the doc specifies (now always `source: routine.<name>`, `status: warning`) and calls the same `processFailingService` path `events.ts` uses (`routine-incident://<name>/<topic>`), so autonomy level and dedup apply exactly as today. Fixes problem 4 for the three docs.
- **Exactly once across ECS tasks:** migration adds `claim_routine_run(p_name text, p_day date) RETURNS uuid` — inserts the `routine_runs` row under a unique partial index `(routine_name, (started_at AT TIME ZONE 'UTC')::date) WHERE trigger = 'gateway-runner'`, `ON CONFLICT DO NOTHING`, returns null when another task already claimed. Single BEGIN/COMMIT, idempotent. Run failures still close the row as `failure` (never left `running`).
- **Start:** `index.ts` gets one call in the exact 4-line `try { … } catch` shape of `startSlowSessionScheduler` (`index.ts:2016-2021`); nothing else in `index.ts` changes (it is the untested hotspot).
- **Switches (checked once, at `startRoutineRunner()` entry, which returns false — same as `startSlowSessionScheduler`):** `ROUTINE_RUNNER_ENABLED` exact `'true'` (opt-in). Does not start when `VITANA_ENV === 'staging'` (staging shares the production database — same guard as reward-sweep). Pinned `"true"` in `AWS-PROD-DEPLOY-GATEWAY.yml` like `REWARD_SWEEP_ENABLED` (VTID-04944), so a publish never silently drops it; off = dispatch `env_overrides` `false`.
- **Status endpoint:** `GET /api/v1/routines/runner/status` (`requireAuth, requireExafyAdmin`, read-only — deliberately not `X-Routine-Token`: it is for people in the Command Hub, not for machines): enabled flag, env, per-routine last run + next due hour.

### B. Retire the 10 claude.ai triggers + their `.md` sensors
- Until then each routine may record two rows a day (the failing claude.ai run, if the owner fixes the setup script first, and the `gateway-runner` run). Expected and harmless; step B ends it.
- Once A is live in production and each routine has produced one `gateway-runner` row: disable the 10 September-generation triggers (`update_trigger enabled=false`, agent-created). The `routines/<name>.md` files stay (they are the spec the checks implement, and the catalog/coverage registry), each gaining one line `Runs in: gateway routine-runner (VTID-<new>)`, and their dead `GATEWAY_URL = https://gateway-q74ibpv6ia-uc.a.run.app` "Required environment" block is replaced by that line (no one should try the HTTP path again).
- April-generation triggers remain an owner action (already reported).

### C. ALERT-* workflows reach the one intake
- New `scripts/ci/report-to-self-healing.sh <name> <summary>`: POST `/api/v1/self-healing/report` in the exact shape `E2E-ORB-MONITOR.yml:54-65` already uses (same secret, same gateway), `|| true` so reporting never masks the original failure.
- Each of the 7 `ALERT-*.yml` gets one `if: failure()` step calling it. No change to what the checks test.

### D. Catalog + doctrine
- `loop-catalog-v1.json` L1: gap text updated; routines keep their owning loops (coverage rule unchanged). `LOOP-ENGINEERING.md` §5/§6: Phase 3a outcome, the setup-script finding.

### Out of scope (kept, tracked in §6 roadmap as Phase 3b)
- The owner's setup-script fix is tracked as an owner action in `docs/validation/<VTID>/acceptance.md` and in `LOOP-ENGINEERING.md` §6 (Phase 3b entry).
- The 4 non-deterministic routines (draft-pr-babysitter needs `gh`; mobile-synthetic-load-probe needs a browser; mobile-screen-api-latency calls app APIs as a user; mobile-bundle-budget reads CI artifacts) stay claude.ai routines. They work again once the **owner** fixes the environment setup script (`[ -d vitana-platform/services/gateway ] && cd …`).
- Deriving `SCHEDULED_WORKFLOWS`, per-loop kill switch / budget / stagnation stop, L5 spend budgets.

## Tests
- `test/routine-runner/checks.test.ts`: every routine's thresholds, breach and no-breach, against fixtures taken from the docs.
- `test/routine-runner/runner.test.ts`: due-hour logic; claim returns null → nothing runs; a loader that throws closes the row `failure`; breach → OASIS emit + `processFailingService` called with `routine-incident://…`; staging env → never starts; flag off → never starts.
- `test/routine-audits.test.ts` (extended): the HTTP routes return the same shapes after the extraction; same for `/api/v1/agents/registry` and `/voice-lab/live/sessions` (existing tests kept green, one shape test each added if none exists).
- Route test for `/routines/runner/status` (401/403 without exafy_admin).
- Migration lint (single BEGIN/COMMIT); a `migration-test.sql` in the evidence pack showing the double-claim returns null.
- Workflow: a `bats`-free shell check that the 7 ALERT files each contain the `if: failure()` report step (Jest file-content test, like existing workflow tests).
- STAGING-VERIFY (read-only): the jest suites above via `existing npx jest …`; `GET /api/v1/routines/runner/status` without auth → 401 JSON. The runner itself does not run on staging by design.
- Production post-deploy: next day, read-only — one `gateway-runner` row per covered routine (Gate 2 evidence follow-up, then step B).

## Files in scope
services/gateway/src/services/routine-runner/{checks,sources,runner}.ts (new), services/gateway/src/routes/routine-audits.ts (extract 8 functions), services/gateway/src/routes/agents-registry.ts (extract 1), services/gateway/src/routes/voice-lab.ts (extract 1), services/gateway/src/routes/routines.ts (status route), services/gateway/src/index.ts (start call), supabase/migrations/<ts>_vtid_<new>_routine_run_claim.sql, scripts/ci/report-to-self-healing.sh, .github/workflows/ALERT-*.yml (7), .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (one pinned var), routines/*.md (10, one line each), services/gateway/specs/loop-catalog-v1.json, docs/autonomy/LOOP-ENGINEERING.md, docs/CHANGELOG.md, DATABASE_SCHEMA.md, tests above, docs/validation/<VTID>/*.
<!-- plan:end -->


## Planner responses — round 1

- **F1 [major] ACCEPTED.** Verified: voice-lab-triage reads `routes/voice-lab.ts:751` (inline, `queryVoiceLabEvents`) and agents-heartbeat reads `routes/agents-registry.ts:147` (inline, `supabaseRequest` + `deriveStatus`). Plan now names both extractions (`listLiveSessions`, `readAgentsRegistry`) and adds both files to scope.
- **F2 [major] ACCEPTED in part (enumeration), premise corrected.** All 10 sources are now listed by strategy. Correction: dyk-tour-progress, knowledge-docs-freshness and spec-memory-quarantine do use audit routes — `routines/dyk-tour-progress.md:20` → `/routines/audits/dyk-tour-progress` (route at `routine-audits.ts:414`), `knowledge-docs-freshness.md:20` → `:358`, `spec-memory-quarantine.md:22` → `:456`; mobile-screen-latency-rollup → `:526`. The file has 8 GET routes (`:86, :143, :238, :281, :358, :414, :456, :526`); its header comment listing 4 is stale and will be corrected. So 8 sources come from routine-audits.ts, 2 from extractions in other route files, none from new queries.
- **F3 [minor] ACKNOWLEDGED** — count confirmed, no change.
- **F4 [minor] ACCEPTED** — the dead `GATEWAY_URL` block is replaced by the "Runs in" line in the 10 docs.
- **F5 [minor] ACCEPTED** — transition overlap sentence added to B.
- **F6 [major] ACCEPTED** — `index.ts` addition pinned to the 4-line try/catch shape of `index.ts:2016-2021`, nothing else there.
- **F7 [minor] ACCEPTED** — intent stated in the plan.
- **F8 [minor] ACCEPTED** — guards checked once at `startRoutineRunner()` entry.
- **Q1:** see F1 — both are inline today; extracted in their own files.
- **Q2:** they use audit routes (see F2) — extracted functions, no new queries.
- **Q3:** tracked — owner action in acceptance.md and the Phase 3b roadmap entry.

## Amendment A1 (mid-flight, VTID-05103) — voice-lab-triage leaves the runner

Found while implementing (2026-10-12): the premise of voice-lab-triage is false in the code.
- `routines/voice-lab-triage.md:37-41` reads `GET /api/v1/voice-lab/live/sessions?status=ended&since_hours=24` and `…&since_hours=192&until_hours=24`, then computes `error_rate` from `error_count` and `novel_error_codes` from `error_codes`.
- The route's schema (`routes/voice-lab.ts:619-623`) accepts only `status`, `limit` (max 100) and `offset`; `since_hours`/`until_hours` are silently dropped. The handler sets `error_count: 0` for every session (`:840`) and returns no `error_codes` field. So the routine can never see an error-rate spike or a novel code, and its "collapse" rule compares two capped 100-row samples.
- Porting it "verbatim" would create a check that is green forever — the opposite of a sensor.

Change:
- The runner covers **9** routines (voice-lab-triage removed). Source (c) and the `voice-lab.ts` extraction are dropped from scope; `voice-lab.ts` is not touched.
- `routines/voice-lab-triage.md` gets a "Known broken — not run (VTID-05103)" note citing the two lines above. Its claude.ai trigger is disabled with the other 9 in step B (it would only ever report green).
- `loop-catalog-v1.json`: voice-lab-triage stays owned by L7 (coverage rule unchanged); L7's gap text records that its daily triage has no working data source, and the fix (a time-windowed session query using the existing `classifyQualityFromSessionStop` failure classes) is Phase 3b.
- Tests: unchanged except no voice-lab case; a test asserts voice-lab-triage is not in the runner's routine list.

---

## Partner findings — round 1 (verbatim summary of the partner's report)

Verified premises: events.ts routine-breach predicate (`events.ts:133-136`); 7 ALERT-* files, none POST `/self-healing/report`; dyk-tour-progress event lacks `source`/`status`; `startSlowSessionScheduler` hourly `setInterval().unref()` pattern (`slow-session-gate.ts:176-188`); `REWARD_SWEEP_ENABLED` pinned in `AWS-PROD-DEPLOY-GATEWAY.yml:1039-1042`.

- F1 [major] voice-lab-triage reads `/api/v1/voice-lab/live/sessions`, not a routine-audit endpoint; agents-heartbeat reads `/api/v1/agents/registry`. Name the service functions; if inline, extraction is extra scope.
- F2 [major] routine-audits.ts header names 4 routines; the other 6 need different loaders. Enumerate all 10 sources by strategy.
- F3 [minor] count of 14 routine specs confirmed.
- F4 [minor] docs still show the dead Cloud Run `GATEWAY_URL`; remove it when adding "Runs in".
- F5 [minor] acknowledge the transitional double run.
- F6 [major] `index.ts` is the untested hotspot; pin the addition to the 4-line try/catch at `index.ts:2016-2021`.
- F7 [minor] status route uses exafy_admin auth, a second pattern under `/routines/` — confirm deliberate.
- F8 [minor] say whether the staging/flag guard is checked at start or per tick.
Verdict: NOT CONVERGED (F1, F2, F6).

## Partner findings — round 2

Verified the corrected F2 premise: dyk-tour-progress, knowledge-docs-freshness, spec-memory-quarantine use audit routes (`routine-audits.ts:414, :358, :456`); the stale header lists 4; all 8 routes serve 8 routines. Verified both extraction targets (`agents-registry.ts:147`, `voice-lab.ts:751`).
F1–F8: all **closed**. No new blocker or major. Verdict: **CONVERGED**.

## Partner findings — round 3 (amendment A1, mid-flight)

Verified: `voice-lab.ts:619-623` schema has only `status`, `limit`, `offset` (time windows stripped); `:840` hard-codes `error_count: 0`, no `error_codes`; `routines/voice-lab-triage.md:37-38, :48-51` expect them. Removing voice-lab-triage from the runner (9 instead of 10) avoids a green-forever sensor; scope reduction clean. No blocker or major. Verdict: **CONVERGED**.

# Plan sparring record — VTID-05098

Plan hash (sha256 of the text between the plan markers, as approved): `6485437ac5e714aae25260293d1223fedf27515ce8755bd133b118dfb6864bdb`.
Partner: plan-sparring-partner (read-only, independent). Class: standard. Verdict: **CONVERGED** after 2 rounds.
Owner approval: in session 2026-10-12, "Yes" in answer to the Gate 1 message for Loop Engineering Phase 2.
Gate: allocated with `p_plan_hash` set to the hash above and no `p_sparring_id`; this record is referenced from the ledger row's metadata (`sparring_record`). Parent: VTID-05084.

---

# Plan — Loop Engineering Phase 2: Simplify (remove duplicate and dead checks)

<!-- plan:begin -->
## 0. Meta
- **Change class:** standard. Command Hub UI, one gateway route file, one data-only migration, external routine triggers.
- **Repos:** `exafyltd/vitana-platform` only.
- **Owner direction (2026-10-12):** "start Phase 2 — remove the duplicate checks". This is roadmap Phase 2 in `docs/autonomy/LOOP-ENGINEERING.md` §6. The rule: fewer things before more things.
- **Builds on** VTID-05084 (loop catalog, coverage rule, the overlaps O1–O10 in `services/gateway/specs/loop-catalog-v1.json`).

## 1. What the research found (read-only, 2026-10-12)
1. **The Routines layer produces no signal today.** Routines are claude.ai scheduled triggers. The `routines/*.md` files are documentation and the `routines` table is the run log (`20260427130000_vtid_01981_routines_catalog.sql:12`). Each routine has **two live triggers**:
   - An **April generation** posting to the deleted Cloud Run gateway (`gateway-q74ibpv6ia-uc.a.run.app`). It reports "SUCCEEDED" only because the script `exit 0`s when it cannot open a run.
   - A **September generation** targeting `gateway.vitanaland.com`. Its last runs are all `FAILED / RUN_ERRORED` within about 3 s.
2. **Security:** both trigger generations carry `ROUTINE_INGEST_TOKEN` in plain text inside the prompt, with different values.
3. **Per overlap:**

| # | Overlap | Verdict | Survivor |
|---|---|---|---|
| O1 | `diagnostics/health-checks` and `infrastructure/health` | **True duplicate.** Same 5 endpoints (`app.js:33721-33746`, `:40036-40087`); all 5 already in the 117-check registry (`service-health-registry.ts:68,71,73,78,84`). | One tab rendering the registry summary the header pill already uses. |
| O2 | ORB health ×4 | Mostly **different signals**. `orb-audio-smoke` reads `gemini_live` Vertex fields (false breaches since GCP is off) and its `enabled` check duplicates the registry's "ORB Live". `ALERT-ORB-SESSION-STATE-HEALTH` and the registry "ORB Session Ledger" call the same RPC. | Retire `orb-audio-smoke`. Keep E2E-ORB-MONITOR and the bootstrap-latency alert (unique). The session-state alert-vs-panel pair goes to Phase 3. |
| O3 | Push ×3 | Workflow and ops route run the same query (`ALERT-PUSH-DISPATCH-HEALTH.yml:64-73` vs `ops-health-checks.ts:258-280`). The routine checks Appilix and token counts, and is dead. | Retire the routine. The workflow-to-ops-route consolidation goes to Phase 3 (alert workflows feed the intake). |
| O4 | Migration ×2 | Different comparisons. The routine's file-prefix vs `schema_migrations` diff overlaps 2 of 377 (`check-migration-drift.cjs:13-17`), so it always breaches. | MIGRATION-DRIFT-CHECK. Retire the routine and `/routines/audits/migration-backlog`. |
| O5 | Frontend reachability ×2 | Overlapping. The routine probes dead `*.a.run.app` URLs (April) or `/alive` + `vitanaland.com` (September). The registry already has "Gateway Alive", "Frontend Prod", "Frontend Staging". | The registry. Retire the routine. |
| O6 | Self-healing queue on 2 screens | Partial duplicate. **Pulse's Apply/Discard are broken:** they send `{vtid}`, `/approve` and `/reject` require a UUID `id` (`app.js:42731-42733` vs `self-healing.ts:896-902,1004`), so every click returns 400. | `autonomy/self-healing` acts. Pulse shows the item and links there. |
| O7 | Test-contract failures on 2 screens | Pulse offers `rerun_contract`/`open_contract`, which `autonomyPulseDoAction` does not handle ("Unsupported action", `app.js:42739`). | `testing-qa/test-contracts` acts. Pulse links there. |
| O8 | `self-healing-triage` twice | **Not the same thing.** The routine is an inert daily rules pass (its own prompt expects 401/403 on approve/reject). The `agents_registry` row is the in-gateway Claude triage service. | Retire the routine. Keep the agent. |
| O9 | Missing-test scanner twice | **Not a duplicate.** Two live code paths with different signals (`.ts` without `.test.ts` vs endpoint without `test_contracts` row). | Keep both. Reclassify in the catalog. |
| O10 | Scheduled-job lists ×4 | **Not duplicates.** Four scopes; TEST-CATALOG is generated. Only `SCHEDULED_WORKFLOWS` (`ops-runtime-health.ts:273-279`) is hand-kept. | Reclassify. Deriving `SCHEDULED_WORKFLOWS` from the generated catalog goes to Phase 3. |

## 2. What Phase 2 changes
### A. Retire five dead or duplicate routines
`orb-audio-smoke`, `push-pipeline-probe`, `migration-backlog`, `cloud-run-frontend-health`, `self-healing-triage`. For each:
1. **Disable both claude.ai triggers** (`update_trigger enabled=false`). Disable, never delete, so history stays and it is reversible. The trigger ids are resolved with `list_triggers`/`get_trigger` and recorded in the evidence pack.
2. **Delete** `routines/<name>.md`.
3. **Data-only migration** `supabase/migrations/<ts>_vtid_<VTID>_retire_duplicate_routines.sql`: `UPDATE routines SET enabled=false, description = description || ' [retired VTID-…: duplicate of …]' WHERE name IN (…)`. Idempotent. We UPDATE and never DELETE these rows, specifically to keep their `routine_runs` history: a DELETE would cascade-drop it (`routine_runs.routine_name … ON DELETE CASCADE`, `:30`). The Routines screen then shows them as disabled. Applied at publish via RUN-MIGRATION and listed at Gate 2.
4. **Delete the two audit endpoints** in `routes/routine-audits.ts` that only these routines used (`/routines/audits/push-pipeline` `:409-440`, `/routines/audits/migration-backlog` `:447`), with their tests updated. If any other caller is found, keep the endpoint and record why.

### B. Disable every April-generation trigger that still targets the deleted Cloud Run gateway
This applies to every routine, not only the five above. Criterion: the trigger prompt contains `a.run.app`. They post into nothing, and their "SUCCEEDED" is false. Disable only. The exact set is determined at execution time with `list_triggers` and recorded (id, name, URL found) in the evidence pack.

### C. One Health tab (O1)
- **Literal de-duplication, no behaviour change.** `diagnostics/health-checks` stays exactly as it is today (same 5 probes, same view).
- Remove the `infrastructure/health` tab (`app.js:3896`, its render branch at `:8749`). Redirect it to `diagnostics/health-checks` (AUTONOMY_REDIRECTS pattern, `app.js:12609`).
- If `renderInfraHealthView` then has no caller, it is removed (t2 zero-caller test).
- The full 117-check registry stays where it already is: the header Service Health pill. Moving the tab onto the registry is not part of this phase.
- Swap or remove its voice entry in `command-hub-screens.json` and regenerate the nav vectors.
- `infrastructure/services` keeps `fetchInfraServices` (a third consumer); untouched.

### D. One place to act (O6, O7)
In Autonomy Pulse, `pending_heal` and failed test-contract items lose their action buttons and get an "Open" link to the source tab (`source_url` already exists). Pulse stays the single pane of glass for seeing; the source tab is the single place to act.

This is a deliberate application of "one place to act", not only a bug workaround. Fixing Pulse to send `{id}` would be one line, but it would keep two surfaces that approve the same queue with different filters (Pulse: all confidences, `autonomy-pulse.ts:362`; the tab: confidence < 0.8, `self-healing.ts:845+`).

### E. Catalog and coverage
- `loop-catalog-v1.json`:
  - each overlap gets a `status`: `resolved` (O1, O4, O5, O6, O7, O8), `partly_resolved` (O2, O3: routine retired, alert-vs-panel left to Phase 3) or `not_a_duplicate` (O9, O10), plus a one-line `resolution`;
  - retired routines leave `L1.sensors.routines`.
- `loop-catalog.test.ts`:
  - the overlap test keeps `>= 10` entries and asserts every entry has a valid status;
  - the coverage test keeps working: retired routines no longer exist as files, so none dangle.
- The Loops screen's Simplification panel shows each overlap's status.

### F. Findings handed to the owner, not fixed here
- **Rotate `ROUTINE_INGEST_TOKEN`** and remove it from trigger prompts (security, owner action).
- **The surviving routines fail on every run** (September generation `RUN_ERRORED`). Diagnosing them belongs to Phase 3 (close L1). Until then they are listed in the catalog as `gap` on L1.

## 3. Files in scope (vitana-platform)
- **Deleted:** `routines/{orb-audio-smoke,push-pipeline-probe,migration-backlog,cloud-run-frontend-health,self-healing-triage}.md`.
- **New:**
  - `supabase/migrations/<ts>_vtid_<VTID>_retire_duplicate_routines.sql`
  - tests
  - `docs/validation/<VTID>/*`
- **Changed:**
  - `services/gateway/src/routes/routine-audits.ts`
  - `services/gateway/src/frontend/command-hub/app.js` (health tab, redirect, Pulse actions)
  - `index.html` (`?v=`)
  - `navigation-config.js` + `dev-screen-inventory-v1.json` + `command-hub-symbol-index.json` (generated)
  - `src/navigation/data/command-hub-screens.json` + `nav-embeddings.*` (generated)
  - `specs/loop-catalog-v1.json`
  - `test/loop-catalog.test.ts`
  - the Loops screen module
  - tests and staging suites that pin `app.js`/`styles.css` versions
  - `scripts/ci/command-hub-ownership-guard.js` (every Command Hub change must allowlist its VTID there)
  - `DATABASE_SCHEMA.md` (if it lists routine rows)
  - `docs/autonomy/LOOP-ENGINEERING.md` §5
  - `docs/CHANGELOG.md`
- **Outside the repo:** claude.ai routine triggers (disable only).
- **Not touched:** workflow YAML, auth, LLM routing, vitana-v1.

## 4. Test plan
- **Unit (Jest):**
  - the remaining `routine-audits` routes still pass; removed routes return 404;
  - the migration lints idempotent (PR-gate migration lint);
  - catalog test (overlap statuses);
  - coverage test (no dangling routine).
- **Command Hub tests:**
  - `diagnostics/health-checks` still renders its 5 probes (unchanged);
  - `infrastructure/health` redirects;
  - Pulse heal and contract items render an Open link and no Apply/Discard/rerun buttons;
  - the existing guardrails stay green.
- **Full gateway suite**, typecheck, build, golden fingerprint, regen and symbol-index `--check`.
- **Staging (read-only `staging-tests.json`):**
  - the served `app.js` contains the new health view and the redirect, and no longer contains the Pulse heal apply action;
  - `/routines/audits/migration-backlog` returns 404/401 JSON;
  - `/command-hub/` loads the new version.
- **Trigger changes:** verified with `get_trigger` (`enabled=false`) and listed in the evidence pack.
- **Production:** no tests.
<!-- plan:end -->

---
## Planner responses — round 1
- **F1 [major] — ACCEPTED, simpler option.** Literal de-duplication: `infrastructure/health` is removed and redirected; `diagnostics/health-checks` is unchanged. No new view, no behaviour change. §2.C rewritten.
- **F2 [major] — ACCEPTED.** Reworded: we UPDATE and never DELETE in order to keep history; a DELETE would cascade-drop runs.
- **F3 [minor] — ACKNOWLEDGED.** Clean removal; the redirect covers deep links.
- **F4 [minor] — REJECTED (deliberate).** Removing Pulse's buttons applies "one place to act"; fixing them would keep two approval surfaces with different confidence filters (`autonomy-pulse.ts:362` vs `self-healing.ts:845+`). Stated in §2.D.
- **F5 [minor] — ACCEPTED.** The set is determined via `list_triggers` at execution and recorded with id, name and URL.
- **F6 [minor] — ACCEPTED.** Reason added.
- **F7 [minor] — ACKNOWLEDGED.**
- **Q1:** literal dedup (see F1). **Q2:** the principle (see F4).

## Partner round 2
F1, F2, F3, F5, F6 and F7 are closed. F4 is acknowledged (the partner verified the two different confidence filters). New: F8 [minor], a stale test-plan line.

## Planner responses — round 2
- **F8 [minor] — ACCEPTED.** The test-plan line now says the 5-probe view still renders, unchanged.

## Verdict
**CONVERGED** after 2 rounds (standard class, cap 3). No blocker or major is open or disputed.

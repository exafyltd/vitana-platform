# Tasks — ci-github-modernization

Eight lanes. Acceptance bullets are what the reviewer agent checks. No test is deleted or loosened; a
removed workflow needs evidence its target is gone; a changed assertion matches the current contract.

<!-- lane: dead-workflows -->
## Lane: dead-workflows

Remove the one genuinely-live dead GCP Cloud Run workflow and correct the dead-list. Independent lane
(R1-F1: no migration, no `depends_on`).

- [ ] T1 — Confirm (and cite in the evidence row) that `VCAOP-GUARDRAILS-CI.yml` already runs the vcaop
  `typecheck` (`npm run typecheck`) and `test:guardrails` (`npm run test:guardrails`, required gate) plus
  `npm test` on the same `services/vcaop/**` triggers. No migration into `TEST-SUITE.yml`; no dependency
  on lane 6.
- [ ] T2 — **Preserve the vcaop build gate first (R2-F1):** add a `Build` step (`run: npm run build`,
  `working-directory: services/vcaop`) to `.github/workflows/VCAOP-GUARDRAILS-CI.yml` (after its
  `npm test` step). `VCAOP-CICD.yml:46-48` runs `npm run build` (= `tsc` with emit, distinct from
  `typecheck` = `tsc --noEmit`) and no other workflow builds vcaop, so this must land before deletion or
  the only vcaop build gate is silently lost.
- [ ] T3 — Remove `.github/workflows/VCAOP-CICD.yml` (dead: `google-github-actions/auth@v2` :63,
  `gcloud run deploy vcaop-api-dev --region us-central1` :77-78 — decommissioned GCP, infrastructure.md
  §1). After T2 its only unique body is the dead GCP `deploy-dev` job.
- [ ] T4 — Add the evidence row under `docs/validation/<VTID>/` (what the workflow deployed, that the GCP
  target is gone, and that `VCAOP-GUARDRAILS-CI.yml` now covers the vcaop typecheck + guardrails + build
  gates) and record in the inventory that EXEC-DEPLOY/STAGE-DEPLOY are already gone and UNIT.yml is already
  a real check (not a no-op).
- [ ] T5 — Add tests: a dead-GCP-marker inventory test (`scripts/ci/ci-inventory/*.test.mjs` or a case in
  `scripts/ci/pr-gate/__tests__/`) that greps the workflow tree for live GCP/Cloud-Run deploy markers and
  fails while any such workflow exists; **plus** an assertion that `VCAOP-GUARDRAILS-CI.yml` runs
  `npm run build` (red on base — no build step today — green on head). Run `node --test` over them green
  after the changes.

**Acceptance (R1-F1, R2-F1):** `VCAOP-GUARDRAILS-CI.yml` gains an `npm run build` step **before**
`VCAOP-CICD.yml` is deleted (the vcaop build gate survives); the evidence row cites
`VCAOP-GUARDRAILS-CI.yml` as the surviving runner of the vcaop typecheck / guardrails / build gates;
`VCAOP-CICD.yml` is gone; the inventory test is red on base (VCAOP present) and green on head; the build
assertion is red on base and green on head; no TEST-SUITE edit and no lane-6 dependency; no non-dead
workflow (e.g. `AWS-STAGE-DEPLOY-GATEWAY.yml`) is otherwise touched.

<!-- lane: fake-checks-dedupe -->
## Lane: fake-checks-dedupe

Delete the dead commented-out test block and de-duplicate the gateway build in CICDL.

- [ ] T1 — Delete **only** the commented-out `Gateway Tests` step at
  `.github/workflows/CICDL-GATEWAY-CI.yml:113-118` (marker `# TESTS DEFERRED TO DEV-CICDL-0035` is :112).
  **Do not touch lines 119-137** — that is the live `Report Validation Success` step (optionally update
  its echo at :133). Real gateway Jest already runs in TEST-SUITE.yml:48-61; do not re-enable tests here.
  Do not rewrite UNIT.yml.
- [ ] T2 — De-duplicate the gateway **build** that runs in both `CICDL-GATEWAY-CI.yml` (build :94-97,
  typecheck :103-106) and `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml:16-21` (the sole required check). Keep
  whichever single build covers the required path. `TEST-SUITE.yml`/`PR-GATE.yml` do **not** build the
  gateway, so they are not the duplicate. If the de-dup would need to edit `ENFORCE-FRONTEND-CANONICAL-
  SOURCE.yml` (the required check), do not edit it here — surface that change for Gate 2 and, if the two
  builds serve genuinely different triggers, record that and drop the de-dup rather than remove a build
  the required check depends on.
- [ ] T3 — Record the before/after job set under `docs/validation/<VTID>/` as the measured proof.

**Acceptance (R1-F1,R1-F2):** the commented `Gateway Tests` step (:113-118) is gone and the live `Report
Validation Success` step is intact; the gateway build is no longer duplicated between CICDL and the
required ENFORCE check (or the retained duplication is justified and recorded); `ENFORCE-FRONTEND-
CANONICAL-SOURCE.yml` is not silently changed; the before/after job set is recorded; the dead-GCP
inventory test still passes.

<!-- lane: false-positives-collab -->
## Lane: false-positives-collab

Fix the Lane scope / Collab handoff false positives and the Windows-only `queue.test.mjs` failures — one
lane (same file). Sequence behind #4210 / #4188.

- [ ] T1 — In `scripts/collab/queue.mjs` `scopeCheck`, stop rejecting a reviewer-agent review entry whose
  session seat ≠ a legacy `reviewer_seat` (the agent-reviewer path at :590-599 — `seat` at :590, the `ok`
  branch :592-594), keeping every subcommand name/shape (`scope-check` is grepped literally by vitana-v1).
- [ ] T2 — Stop counting the `ci-plan-spar` automation literal as a second session in the "one session
  per lane" rule on a `_plan` lane. (R1-F4: `pm-agent` is **already** excluded at `queue.mjs:452` —
  `if (k.lane && k.session !== PM_AGENT)` — so only `ci-plan-spar` needs adding to that exclusion; verify
  with a red-on-base test before touching anything, and do not re-implement the pm-agent exclusion.)
- [ ] T3 — Stop flagging a protected-gate file changed under an owner instruction in the *check* (the
  merge-time unlock already exists in governance.ts); the check should not red a correctly-authorized PR.
- [ ] T4 — Fix the Windows-only failures in `scripts/collab/queue.test.mjs`: the `C:\C:\` "programme
  registry" path (:426) via `path.join`/`path.resolve`, and replace any `rm` with a cross-platform delete.
- [ ] T5 — Add cases to `queue.test.mjs` encoding each wrongly-rejected PR shape (exercising the
  `scopeCheck()` path at `queue.mjs:587-600`) asserted to pass scope-check, plus a Windows-path case; run
  `node --test scripts/collab/queue.test.mjs` green on win32 and ubuntu.

**Acceptance (R2,R6,R7):** each new case is red on base (current scope-check rejects it) and green on
head; subcommand names/shapes unchanged; the lane itself passes Lane scope under the base-revision
checker; the three-copy protected-gate list is **not** edited; sequenced behind #4210 (rebased onto it
if open). Protected gate → merge needs the owner instruction naming this plan (surfaced in Gate 2).

<!-- lane: false-positives-validator -->
## Lane: false-positives-validator

Make the VALIDATION_PROFILE round-trip a template / autofill / clear early failure.

- [ ] T1 — Add a PR body template (`.github/pull_request_template.md` or
  `.github/PULL_REQUEST_TEMPLATE/*`) carrying `VALIDATION_PROFILE` and the required markers
  (SCOPE_ALLOWLIST/ACCEPTANCE/MERGE_PAYLOAD_PREVIEW/OASIS_IMPACT) with guidance.
- [ ] T2 — Change `VALIDATOR-CHECK.yml` / `scripts/ci/validator-path-guard.cjs` so a missing profile/
  marker fails early with a precise, actionable message (which marker, how to fix) instead of a bare
  `exit 11`.
- [ ] T3 — Add a case to the validator-path-guard test asserting the new clear-message / autofill
  behaviour. Run `node --test` over it green.

**Acceptance:** a PR body from the template passes; a missing-profile PR fails with the new clear message;
the guard test case is red on base (bare exit) and green on head; trigger stays path-scoped to the
gateway trees (no new PR types bitten).

<!-- lane: plan-spar-checks -->
## Lane: plan-spar-checks

Producer-only (R3-F2 option B): post the `plan-spar/needs-rebase` commit status on the plan PR bot head.
The posted status has no effect until the consumer is built — today's behaviour is unchanged by this lane.

- [ ] T1 — In `.github/workflows/PLAN-SPAR.yml`, add `statuses: write` to the explicit workflow-level
  `permissions:` block (R3-F1 blocker: an explicit block sets every unlisted scope to `none`, so without
  this the status POST 403s). This is in-lane code, not owner config.
- [ ] T2 — In `.github/workflows/PLAN-SPAR.yml`, after the round-commit push (:116/:117), add **one** step
  guarded by `if: steps.guard.outputs.skip != 'true' && secrets.PLAN_SPAR_PUSH_TOKEN == ''` (the
  `GITHUB_TOKEN`-push case; when the PAT secret is present the push already starts checks and this step is
  skipped). The step reads the pushed head SHA (`git -C head rev-parse HEAD`) and posts a commit status via
  `gh api -X POST repos/{owner}/{repo}/statuses/{sha}` with `context=plan-spar/needs-rebase`,
  `state=pending`, and a `target_url` to the run. Do **not** use re-dispatch (`gh workflow run`/`dispatches`
  is unavailable for `pull_request`-triggered workflows), re-run (`.../runs/{id}/rerun` re-runs the old
  SHA), or the Checks API (needs `checks:write`, which the `pull_request_target` `GITHUB_TOKEN` lacks).
- [ ] T3 — Add a case to `scripts/collab/plan-spar.test.mjs` / `scripts/ci/plan-spar-slot/slot.test.mjs`
  pinning the **producer** contract only: (a) `PLAN-SPAR.yml`'s `permissions:` block contains
  `statuses: write`, and (b) the empty-`PLAN_SPAR_PUSH_TOKEN` path posts a `plan-spar/needs-rebase` status
  on the bot head (asserted against a stubbed `gh api statuses` call / the extracted status helper). Do
  **not** assert any consumer behaviour (no `gh pr update-branch`) — the consumer is deferred.
  Run `node --test scripts/collab/plan-spar.test.mjs scripts/ci/plan-spar-slot/slot.test.mjs` green.

**Consumer deferred (R3-F2 option B):** the PM / land step that reads the status and calls
`gh pr update-branch` lives in `services/gateway/src/services/project-manager/act.ts` (a gateway change
needing a staging deploy) and is **NOT** built in this plan — it is deferred to a separate gateway lane
with its own staging deploy, outside this plan's "deploys nothing" scope (surfaced for Gate 2 with the PAT
secret). Until it exists the posted status has no effect and today's behaviour is unchanged.

**Acceptance (R2-F1, R3-F1, R3-F2):** the proof test is red on base (no `statuses: write`, no such status
posted today) and green on head; `PLAN-SPAR.yml` carries `statuses: write`; exactly one producer mechanism
is used (commit status, not re-run / re-dispatch / Checks API); the test asserts ONLY the producer contract
(no consumer assertion); when the PAT secret is present the status step is skipped and checks start
normally; no other PLAN-SPAR behaviour changes; the PAT secret and the deferred consumer lane are listed
for Gate 2, not built here. Protected gate → merge needs the owner instruction naming this plan (surfaced
in Gate 2).

<!-- lane: speed-path-filters -->
## Lane: speed-path-filters

Caching, path filters on non-gate jobs, de-dup, shard balance — target ≤ 15 min on a typical gateway PR.
Independent lane (R1-F1: no vcaop-matrix migration, so no `depends_on`).

- [ ] T1 — Add dependency caching to the uneven install steps (e.g. TEST-SUITE's pnpm install with no npm
  cache); align with the `cache: npm` pattern already used in v1 PR-GATE.
- [ ] T2 — Add path filters to **non-gate** jobs only; never path-filter PR-GATE / Lane scope / Collab
  handoff (a required check that never runs stays pending and wedges merges).
- [ ] T3 — The gateway Jest suite already runs as a **4-shard matrix** (`TEST-SUITE.yml:43-70`:
  `strategy.matrix.shard: [1,2,3,4]`, `npx jest … --maxWorkers=100% --shard=N/4`; R1-F2 — the brief's "4
  shards" was correct). Re-balance those four shards only if measured imbalance warrants it, using the
  ground-truth counts (gateway ~1,737 suites / ~22,700 tests; vcaop 45/~290; vcaop-mcp 7/~58; vitana-v1
  web 444/~2,840; mobile 61/~650), not the brief's stale "~7.5k". Note in the measured artifact the ~50
  Playwright/e2e specs and the shell/Python test scripts that no required check covers today (coverage gap
  for ci-health).
- [ ] T4 — Extend `scripts/ci/test-suite/shard-union.test.mjs` / `rerun-policy.test.mjs` to pin any new
  shard/skip contract where logic changed; run `node --test` green. Record before/after critical path
  under `docs/validation/<VTID>/`.

(No vcaop-matrix migration task — R1-F1 removed it: `VCAOP-GUARDRAILS-CI.yml` already runs the vcaop
typecheck/guardrails gates, so lane 1 deletes `VCAOP-CICD.yml` without any TEST-SUITE change.)

**Acceptance (R5,R1-F1,R1-F2):** no required gate job is path-filtered out; the gateway suite stays a
4-shard matrix (not collapsed to one job); any shard/rerun test change is red on base and green on head
where logic changed; a measured before/after timings artifact is attached; **no** `typecheck`/`guardrails`
keys or steps are added to the `vcaop` matrix entry (that migration is removed); `enforce` is NOT flipped
(listed for Gate 2); `CICDL-GATEWAY-CI.yml` is not edited by this lane (lane 2 owns it). Protected gate
(edits PR-GATE.yml) → merge needs the owner instruction naming this plan (surfaced in Gate 2).

<!-- lane: stale-tests -->
## Lane: stale-tests

Fix the permanently-red suites at the cause, never by skipping.

- [ ] T1 — vitana-v1: fix the ConversationView VTID-05201 deeplink-scroll test and the product code it
  asserts (`src/components/messages/ConversationView.deeplink-scroll.vtid-05201.test.tsx` + the
  ConversationView code) to the current contract; `npm run test:unit` green.
- [ ] T2 — platform: fix the VTID-05082 staging-contract failure at the cause (update
  `docs/validation/VTID-05082/staging-tests.json` + the asserted contract to today's AWS/Aurora/route
  state); the staging-verify suite is read-only.
- [ ] T3 — Record under `docs/validation/<VTID>/` the current contract each changed assertion now matches
  (the evidence the test-weakening guard requires).

**Acceptance:** both suites are red on `origin/main` (the bug) and green with the cause fixed; no
assertion is deleted or weakened (PR-GATE test-weakening guard passes); each changed assertion cites the
current contract. Non-governance Kiro lane (seat `exafy`, reviewer `jtadic`).

<!-- lane: ci-health -->
## Lane: ci-health

Daily CI-health report: flake rate, red-on-main age, per-check duration.

- [ ] T1 — Add `scripts/ci/health/report.mjs` producing flake rate, red-on-main age and per-check
  median/p90 duration from `gh run list` data, modelled on the `TEST-CATALOG.yml` producer shape.
- [ ] T2 — Add `.github/workflows/CI-HEALTH.yml` (scheduled, like `ALERT-*.yml` /
  `TEST-CATALOG.yml:32-34`) that runs the producer and publishes/report the result.
- [ ] T3 — Add `scripts/ci/health/report.test.mjs` covering the producer's output shape; run
  `node --test scripts/ci/health/report.test.mjs` green (enforced by UNIT.yml which runs all
  `scripts/**/*.test.*`).

- [ ] T4 — The report surfaces the coverage gap from the ground-truth counts: flag the ~50 Playwright/e2e
  spec files and the shell/Python test scripts in vitana-platform that no required check runs today, so the
  gap is a standing signal rather than a one-off inventory note.

**Acceptance:** the report script and test exist; the test is red on base (files absent) and green on
head; the workflow is scheduled and does not run against production (GitHub reads only); output reports
flake rate, red-on-main age and per-check duration, and the uncovered-test coverage gap (Playwright/e2e +
shell/Python scripts with no required check).

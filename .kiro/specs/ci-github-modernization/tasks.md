# Tasks — ci-github-modernization

Eight lanes. Acceptance bullets are what the reviewer agent checks. No test is deleted or loosened; a
removed workflow needs evidence its target is gone; a changed assertion matches the current contract.

<!-- lane: dead-workflows -->
## Lane: dead-workflows

Remove the one genuinely-live dead GCP Cloud Run workflow and correct the dead-list.

- [ ] T1 — Remove `.github/workflows/VCAOP-CICD.yml` (dead: `google-github-actions/auth@v2` :63,
  `gcloud run deploy vcaop-api-dev --region us-central1` :77-78 — decommissioned GCP, infrastructure.md
  §1).
- [ ] T2 — Add the evidence row under `docs/validation/<VTID>/` (what the workflow deployed, that the
  target is gone) and record in the inventory that EXEC-DEPLOY/STAGE-DEPLOY are already gone and UNIT.yml
  is already a real check (not a no-op).
- [ ] T3 — Add a dead-GCP-marker inventory test (`scripts/ci/ci-inventory/*.test.mjs` or a case in
  `scripts/ci/pr-gate/__tests__/`) that greps the workflow tree for live GCP/Cloud-Run deploy markers and
  fails while any such workflow exists. Run `node --test` over it green after removal.

**Acceptance:** `VCAOP-CICD.yml` is gone; the inventory test is red on base (VCAOP present) and green on
head; the evidence pack cites the dead target; no non-dead workflow (e.g. `AWS-STAGE-DEPLOY-GATEWAY.yml`)
is touched.

<!-- lane: fake-checks-dedupe -->
## Lane: fake-checks-dedupe

Delete the dead commented-out Jest block and de-duplicate the gateway build+typecheck in CICDL.

- [ ] T1 — Delete the commented-out Jest block in `.github/workflows/CICDL-GATEWAY-CI.yml:95-101`
  ("TESTS DEFERRED …"); real gateway Jest already runs in TEST-SUITE.yml:48-61. Do not re-enable tests
  here (would duplicate TEST-SUITE). Do not rewrite UNIT.yml.
- [ ] T2 — De-duplicate the gateway build+typecheck that runs in both CICDL-GATEWAY-CI.yml:84-91 and the
  TEST-SUITE/PR-GATE paths (reuse via `needs:` or scope CICDL to what only it does).
- [ ] T3 — Record the before/after job set under `docs/validation/<VTID>/` as the measured proof.

**Acceptance:** the commented Jest block is gone; gateway build/typecheck is no longer duplicated across
CICDL and TEST-SUITE; the before/after job set is recorded; the dead-GCP inventory test still passes.

<!-- lane: false-positives-collab -->
## Lane: false-positives-collab

Fix the Lane scope / Collab handoff false positives and the Windows-only `queue.test.mjs` failures — one
lane (same file). Sequence behind #4210 / #4188.

- [ ] T1 — In `scripts/collab/queue.mjs` `scopeCheck`, stop rejecting a reviewer-agent review entry whose
  session seat ≠ a legacy `reviewer_seat` (the agent-reviewer path, ~:466-470), keeping every subcommand
  name/shape (`scope-check` is grepped literally by vitana-v1).
- [ ] T2 — Stop counting the `ci-plan-spar` and `pm-agent` automation literals as a second session in the
  "one session per lane" rule on a `_plan` lane.
- [ ] T3 — Stop flagging a protected-gate file changed under an owner instruction in the *check* (the
  merge-time unlock already exists in governance.ts); the check should not red a correctly-authorized PR.
- [ ] T4 — Fix the Windows-only failures in `scripts/collab/queue.test.mjs`: the `C:\C:\` "programme
  registry" path (:426) via `path.join`/`path.resolve`, and replace any `rm` with a cross-platform delete.
- [ ] T5 — Add cases to `queue.test.mjs` encoding each wrongly-rejected PR shape asserted to pass
  scope-check, plus a Windows-path case; run `node --test scripts/collab/queue.test.mjs` green on win32
  and ubuntu.

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

Make PLAN-SPAR round commits start checks on the plan PR head.

- [ ] T1 — In `.github/workflows/PLAN-SPAR.yml` (:84-98), make the round commit start `pull_request`
  checks: either dispatch the checks after the push, or push with a token that triggers them
  (`PLAN_SPAR_PUSH_TOKEN` — the repo secret itself is owner config → Gate 2; the workflow wiring to use
  it is in scope).
- [ ] T2 — Add a case to `scripts/collab/plan-spar.test.mjs` / `scripts/ci/plan-spar-slot/slot.test.mjs`
  asserting the fix's observable contract (checks are triggered on the bot head). Run
  `node --test scripts/collab/plan-spar.test.mjs scripts/ci/plan-spar-slot/slot.test.mjs` green.

**Acceptance:** the test case is red on base (today checks only start with the optional secret set) and
green on head; no other PLAN-SPAR behaviour changes; any required repo-secret is listed for Gate 2, not
set. Protected gate → merge needs the owner instruction naming this plan (surfaced in Gate 2).

<!-- lane: speed-path-filters -->
## Lane: speed-path-filters

Caching, path filters on non-gate jobs, de-dup, shard balance — target ≤ 15 min on a typical gateway PR.

- [ ] T1 — Add dependency caching to the uneven install steps (e.g. TEST-SUITE's pnpm install with no npm
  cache); align with the `cache: npm` pattern already used in v1 PR-GATE.
- [ ] T2 — Add path filters to **non-gate** jobs only; never path-filter PR-GATE / Lane scope / Collab
  handoff (a required check that never runs stays pending and wedges merges).
- [ ] T3 — Confirm the gateway Jest shard setup (TEST-SUITE runs `--maxWorkers=100%`, not the "4 shards"
  the brief assumed) and re-balance only if measured imbalance warrants it.
- [ ] T4 — Extend `scripts/ci/test-suite/shard-union.test.mjs` / `rerun-policy.test.mjs` to pin the new
  shard/skip contract; run `node --test` green. Record before/after critical path under
  `docs/validation/<VTID>/`.

**Acceptance (R5):** no required gate job is path-filtered out; the shard/rerun test is red on base and
green on head where logic changed; a measured before/after timings artifact is attached; `enforce` is NOT
flipped (listed for Gate 2); `CICDL-GATEWAY-CI.yml` is not edited by this lane (lane 2 owns it). Protected
gate (edits PR-GATE.yml) → merge needs the owner instruction naming this plan (surfaced in Gate 2).

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

**Acceptance:** the report script and test exist; the test is red on base (files absent) and green on
head; the workflow is scheduled and does not run against production (GitHub reads only); output reports
flake rate, red-on-main age and per-check duration.

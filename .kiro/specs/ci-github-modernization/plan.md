---
change_class: standard
---

# Plan — ci-github-modernization

Modernize CI and GitHub for both Vitana repos so the check set is fast, trustworthy and current.

<!-- plan:begin -->
## Goal

Owner request (2026-10-21, verbatim): *"We need to solve this in general and build a solution for
CI and GitHub. Tests in GitHub were built about a year ago and need an update. Update them to
today's state of the Vitanaland system."* Brief goal: CI that is fast, trustworthy and current —
every required check tests something that exists and matters today; no check is permanently red, a
no-op, or a known false positive; the full PR check set finishes in at most 15 minutes on a typical
gateway PR; an automated merge never stalls on CI mechanics.

Phase 1 (read-only inventory + classification + time budget) is **done** — evidence in
`RUN/investigate/inv-code.md`, `inv-rules.md`, `inv-tests.md`. This plan is Phase 2: the lanes that
act on those findings. A standing CI-health report lane turns the one-off inventory into a recurring
signal.

## Today (file:line, origin/main a2d069ea)

- **The only GitHub-required check is a near-fake one.** `gh api repos/.../branches/main/protection`:
  vitana-platform `main` requires exactly one status context, `validate`, which resolves to the
  `validate:` job in `.github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml:7` — a narrow Command
  Hub frontend-structure check, not the pipeline gate set. vitana-v1 `main` has **no branch
  protection at all** (HTTP 404). The whole pipeline gate set (Lane scope, Collab handoff, PLAN-SPAR,
  PR-GATE, TEST-SUITE, STAGING-VERIFY) is enforced only in software by the PM / land-step §7b rule
  (`services/gateway/src/services/project-manager/governance.ts`), never by GitHub. (inv-rules §5.)
- **The CI code is a thin YAML shell over shared Node modules.** `scripts/collab/queue.mjs`
  (`validate`, `scope-check`), `scripts/ci/pr-gate/{gate.mjs,lib.mjs,config.json}`,
  `scripts/collab/plan-spar.mjs`, `scripts/ci/staging-verify/*`, `scripts/test-catalog/*`. A change to
  any of these is seen by every workflow that shells out to it. vitana-v1 has **no** copy of
  `queue.mjs` / `staging-verify/*`; its PR-GATE/Lane-scope/STAGING-TESTS-REQUIRED jobs fetch them from
  vitana-platform `main` at run time and **fail closed** if the fetch fails
  (`vitana-v1/.github/workflows/PR-GATE.yml` lane-scope step). So a `queue.mjs` change alters
  vitana-v1 CI the moment it lands on platform `main`. (inv-code §0.)
- **Dead workflows are far fewer than the brief assumed.** Grep of all 109 platform workflows for
  GCP/Cloud-Run markers returns exactly one genuinely-live dead workflow: `VCAOP-CICD.yml`
  (`google-github-actions/auth@v2` at :63, `gcloud run deploy vcaop-api-dev --region us-central1` at
  :77-78). `EXEC-DEPLOY.yml` and `STAGE-DEPLOY.yml` are **already gone** from `origin/main`;
  `AWS-STAGE-DEPLOY-GATEWAY.yml` only mentions `gcloud` in a historical comment and is the live AWS
  deploy. (inv-code §2.)
- **UNIT.yml is no longer a no-op.** VTID-04950 rewrote it to run every `scripts/**/*.test.{cjs,mjs}`
  via `node --test` (`UNIT.yml:16-20`). The brief's "UNIT.yml placeholder" premise is stale.
  (inv-code §1, inv-tests §5.)
- **The real no-op / dead remnant is the commented-out "tests deferred" block in `CICDL-GATEWAY-CI.yml:113-133`**
  ("# TESTS DEFERRED TO DEV-CICDL-0035" at :113, deferred-echo at :133, purpose comment at :5); real gateway tests already run in `TEST-SUITE.yml:48-61`
  (Jest ~7.5k). So the fix is to delete the dead block, not re-enable it (that would duplicate
  TEST-SUITE). Build+typecheck run in both `CICDL-GATEWAY-CI.yml:84-91` and the TEST-SUITE/PR-GATE
  paths — the duplicate-jobs evidence. (inv-code §1, §5.)
- **PR-GATE Verdict is report-only** (`scripts/ci/pr-gate/config.json` `enforce:false` since
  2026-10-07; the scope/sparring/weakening/red-green guards use `continue-on-error:true`). The two
  real blocking governance check runs are **Collab handoff** (`collab-handoff`) and **Lane scope**
  (`lane-scope`), which exit non-zero and the §7b rule requires green. (inv-rules §6.)
- **Four confirmed pipeline false positives** (inv-rules §7, inv-code §3):
  1. PLAN-SPAR round commits are pushed with `GITHUB_TOKEN` (`PLAN-SPAR.yml:84-98`, header 23-26)
     unless the optional secret `PLAN_SPAR_PUSH_TOKEN` is set; a `GITHUB_TOKEN` push starts no
     `pull_request` checks. Every merge needed `gh pr update-branch`.
  2. `validate-pr` (VALIDATOR-CHECK.yml) rejects a PR body without `VALIDATION_PROFILE` (exit 11) plus
     SCOPE_ALLOWLIST/ACCEPTANCE/MERGE_PAYLOAD_PREVIEW/OASIS_IMPACT markers (exit 12-15); path-scoped
     to the gateway trees, so it bites gateway PRs on first push with no template/autofill.
  3. Collab handoff / Lane scope false-positives in `queue.mjs` (`scopeCheck` reviewer-seat equality
     at ~:466-470; "one session per lane" counting `ci-plan-spar`/`pm-agent` as a second session;
     protected-gate files under an owner instruction flagged because the unlock is a merge-time PM
     decision, not encoded in the check).
  4. "safe-merge refuses `.github/workflows/**`" — there is **no workflow named safe-merge**; the real
     mechanism is the §3a / governance.ts rule that `.github/workflows/**` is a governance path. Restate
     the known issue in those terms; the three protected workflow globs (`PLAN-SPAR.yml`, `PR-GATE.yml`,
     `AWS-PROD-*.yml`) additionally need owner/claude.
- **Permanently-red suites** named by the brief exist on `origin/main`: vitana-v1
  `src/components/messages/ConversationView.deeplink-scroll.vtid-05201.test.tsx` (runs under
  `UNIT-TESTS.yml` vitest job); platform staging suite VTID-05082 via `STAGING-VERIFY.yml` /
  `scripts/ci/staging-verify/run.mjs`. Fix at cause, never by skipping. (inv-tests §8.)
- **Windows-only failures** (Kiro IDE runs on Windows): `queue.test.mjs` "programme registry"
  (`C:\C:\` path, test at :426) and an `rm` in an npm build script. CI runs ubuntu-latest so these
  never fail in CI; they fail only in local Kiro runs. (inv-tests §6, inv-code §4.)
- **No workflow aggregates CI health** (flake rate / red-on-main age / per-check duration). Closest
  patterns to copy: the `ALERT-*.yml` family and `TEST-CATALOG.yml`'s `schedule:` + S3-publish shape
  (`TEST-CATALOG.yml:32-34,95-101`). (inv-code §6.)

## Governance reality that shapes the lane split (the single biggest constraint)

inv-rules §1-2, inv-code §7, collaboration.md §3a, common-rules §6:
- `.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`,
  `CLAUDE.md`, `docs/programs/areas.yaml` are **governance paths**: a lane that edits one must be
  `executor: claude`. Almost every lane here touches `.github/**` or `scripts/ci/**` /
  `scripts/collab/**`, so almost every lane is `executor: claude`.
- A subset are **protected gate files** (`scripts/collab/protected-gate-files.json` `globs`):
  `queue.mjs`, `plan-spar.mjs`, `PLAN-SPAR.yml`, `PR-GATE.yml`, `AWS-PROD-*.yml`, `governance.ts`,
  `CLAUDE.md`, `vitana-lane-reviewer.md`, the two gate migrations. A protected-gate change **never
  merges on a reviewer-agent accept alone** — it needs a legacy `claude` review on the current head or
  an owner instruction naming the plan (governance.ts `governanceMergeAllowed`; `queue.mjs scopeCheck`).
- This run is `CLAUDE_AVAILABLE=false` (`run.json`). collaboration.md §7 routes `executor: claude` work
  to the exceptions seat, **except protected gate files, which still wait for owner/Claude review**.
  So every protected-gate lane here (false-positives-collab, plan-spar-checks, speed-path-filters
  which edits PR-GATE.yml) is **blocked on an owner instruction naming this plan** before it can merge,
  and that is surfaced for Gate 2. The lane split therefore **isolates each protected-gate edit into
  its own small lane** so one owner instruction can name them precisely, and keeps non-gate CI work in
  separate `executor: claude` (exceptions-seat) lanes that merge on the reviewer agent alone.
- **scripts/ci/** (PR-GATE lib, validator guard, staging-verify, health) is a governance path but
  **not** a protected gate file, so an `executor: claude` lane there merges on the reviewer agent.

## Interfaces between lanes (defined here, not by the agents)

- **queue.mjs subcommand names are a cross-repo contract.** vitana-v1's lane-scope step greps the
  literal `'scope-check'`; `validate`, `check-pr`, `verify`, `scope-check`, `session-id`, `claim`/
  `release` must keep their names and argument shapes. The false-positives-collab lane changes logic
  behind these names only. (inv-code §0, §8.)
- **Protected-gate-list three-copy parity.** The list lives in `protected-gate-files.json`,
  `queue.mjs` `PROTECTED_GATE_BUILTIN` (~:92-96) and `governance.ts` `PROTECTED_GATE_GLOBS` (:30-44);
  a parity test reads the JSON. **No lane in this plan edits the list**; if one must, it edits all
  three in that one lane and keeps the parity test green. (inv-rules §1, R3.)
- **A `queue.mjs` change alters vitana-v1 CI at the platform merge instant.** The false-positives-collab
  lane must land on platform `main` and keep the subcommand contract before any vitana-v1 PR relies on
  the new behaviour. (inv-code §0.)
- **Required-check semantics vs path filters.** PR-GATE / Lane scope / Collab handoff run on every
  `pull_request` with no path filter and are relied on as merge gates; a path filter that makes a
  required check *not run* leaves it pending forever and wedges merges. The speed lane may add path
  filters only to non-gate jobs (TEST-SUITE, CICDL-GATEWAY-CI, VALIDATOR-CHECK already have them) and
  must not path-filter the gate jobs. (inv-code §5, inv-tests §8.)
- **PR-GATE `enforce` flip is a behaviour change for every PR** and is itself a protected-gate edit
  (PR-GATE.yml / config.json). This plan does **not** flip it; the exact flip is listed for Gate 2.
  (inv-rules R5, inv-tests §4.)
- **Self-reference.** The lane that fixes the Lane-scope false positives must itself pass Lane scope
  under the OLD rule (scope-check judges from the base revision's checker), so its fix cannot depend on
  its own new logic to merge. (inv-rules R6.)

## Lanes

Eight lanes. Build concurrency is capped at 6 (§8a); lanes beyond that wait in the queue in dependency
order. No two lanes edit the same file. Real `depends_on` only.

1. **dead-workflows** — `executor: claude` (governance `.github/**`; not protected).
   Remove `.github/workflows/VCAOP-CICD.yml` (dead GCP Cloud Run) with its evidence row; correct the
   inventory's dead-list to today's tracked set (EXEC/STAGE-DEPLOY already gone; UNIT.yml already
   fixed). Independent.
   Files: `.github/workflows/VCAOP-CICD.yml`, `docs/validation/<VTID>/**`.
   Test that fails on base: an inventory/no-dead-GCP assertion added to
   `scripts/ci/pr-gate/__tests__/` or a dedicated `scripts/ci/ci-inventory/*.test.mjs` that greps the
   workflow tree for live GCP/Cloud-Run deploy markers and fails while `VCAOP-CICD.yml` exists.

2. **fake-checks-dedupe** — `executor: claude` (governance `.github/**`; not protected).
   Delete the dead commented-out "tests deferred" block in `CICDL-GATEWAY-CI.yml:113-133` (real gateway
   tests live in TEST-SUITE); de-duplicate the gateway build+typecheck that runs in both `CICDL-GATEWAY-CI.yml`
   and TEST-SUITE/PR-GATE. Do **not** rewrite UNIT.yml (already real). Independent.
   Files: `.github/workflows/CICDL-GATEWAY-CI.yml`, `docs/validation/<VTID>/**`.
   Proof: measured before/after job set + the no-dead-block inventory assertion from lane 1's test.

3. **false-positives-collab** — `executor: claude`, **protected gate** (`scripts/collab/queue.mjs`).
   Fix in one lane (same file; cannot split): reviewer-agent seat mismatch, `ci-plan-spar`/`pm-agent`
   not counted as a second session on a `_plan` lane, and the Windows `C:\C:\` path + `rm`
   cross-platform fixes in `queue.test.mjs`. `depends_on: []` by file, but **sequence behind open
   #4210** (the authoritative governance scope-check rewrite, VTID-05259) and #4188 — do not run a
   parallel `queue.mjs` lane; if either is still open at build time, rebase onto its merged result.
   Keep every subcommand name/shape. Blocked on an owner instruction to merge (protected gate, Claude
   unavailable) — surface for Gate 2.
   Files: `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `docs/validation/<VTID>/**`.
   Test that fails on base: new cases in `scripts/collab/queue.test.mjs` encoding each wrongly-rejected
   PR shape, asserted to pass scope-check (red on base because current `queue.mjs scope-check` rejects
   them); plus a Windows-path case green on win32 and ubuntu.

4. **false-positives-validator** — `executor: claude` (governance `.github/**` + `scripts/ci/**`; not
   protected).
   Make the `VALIDATION_PROFILE` round-trip a template/autofill or a clear early failure: add a PR body
   template under `.github/`, and make `VALIDATOR-CHECK.yml` / `scripts/ci/validator-path-guard.cjs`
   fail with a precise, early, actionable message naming the missing markers. Independent.
   Files: `.github/workflows/VALIDATOR-CHECK.yml`, `.github/PULL_REQUEST_TEMPLATE/*` (or
   `.github/pull_request_template.md`), `scripts/ci/validator-path-guard.cjs` and its test,
   `docs/validation/<VTID>/**`.
   Test that fails on base: a case on the validator-path-guard test asserting the new clear-message/
   autofill behaviour (red on base = current bare `exit 11`).

5. **plan-spar-checks** — `executor: claude`, **protected gate** (`.github/workflows/PLAN-SPAR.yml`).
   Make PLAN-SPAR round commits start checks on the plan PR head: either dispatch the checks after the
   push, or require/provision `PLAN_SPAR_PUSH_TOKEN` (the repo secret itself is **owner config → Gate
   2**). Independent of other lanes. Blocked on an owner instruction to merge (protected gate) — surface
   for Gate 2.
   Files: `.github/workflows/PLAN-SPAR.yml`, `scripts/collab/plan-spar.test.mjs` /
   `scripts/ci/plan-spar-slot/slot.test.mjs`, `docs/validation/<VTID>/**`.
   Test that fails on base: a case in `plan-spar.test.mjs` / `plan-spar-slot/slot.test.mjs` asserting
   the chosen fix's observable contract (checks are triggered on the bot head), red on base.

6. **speed-path-filters** — `executor: claude`, **protected gate** (edits `PR-GATE.yml`).
   Add caching to the uneven install steps, add path filters to **non-gate** jobs only, de-duplicate the
   gateway build+typecheck, confirm and (if needed) re-balance the gateway Jest shards. Must not
   path-filter the required gate jobs (PR-GATE/Lane scope/Collab handoff) — that wedges merges. Record
   measured before/after critical path. Independent of the false-positive lanes by file, but it edits
   `PR-GATE.yml` so keep it isolated. Blocked on an owner instruction to merge (protected gate) —
   surface for Gate 2. Does **not** flip `enforce`.
   Files: `.github/workflows/PR-GATE.yml`, `.github/workflows/TEST-SUITE.yml`,
   `.github/workflows/CICDL-GATEWAY-CI.yml` *(see note)*, `scripts/ci/test-suite/*.test.mjs` as needed,
   `docs/validation/<VTID>/**`.
   NOTE: `CICDL-GATEWAY-CI.yml` is also in lane 2. To keep files disjoint, the de-dup that touches
   `CICDL-GATEWAY-CI.yml` is done **only** in lane 2; this lane touches PR-GATE/TEST-SUITE/shards only.
   `depends_on: [fake-checks-dedupe]`.
   Proof: `scripts/ci/test-suite/shard-union.test.mjs` / `rerun-policy.test.mjs` extended to pin the new
   shard/skip contract (red on base), plus a measured-timings artifact for YAML-only changes.

7. **stale-tests** — `executor: kiro` (seat `exafy`, reviewer `jtadic`) — the only straightforward Kiro
   lane (product + non-governance test files).
   Fix the permanently-red suites **at the cause**, never by skipping: vitana-v1 ConversationView
   VTID-05201 deeplink-scroll test (update the test and the product code to the current contract) and
   the platform VTID-05082 staging-contract failure. Each change matches the current contract; the
   PR-GATE test-weakening guard is the backstop. `depends_on: []`.
   Files (vitana-v1): `src/components/messages/ConversationView.deeplink-scroll.vtid-05201.test.tsx`
   and the ConversationView product code it asserts; (platform) the specific
   `docs/validation/VTID-05082/staging-tests.json` + the asserted contract, `docs/validation/<VTID>/**`.
   Test that fails on base: the updated suites run red on `origin/main` (that is the bug) and green with
   the cause fixed — `npm run test:unit` (v1), the staging-verify suite (platform, read-only).

8. **ci-health** — `executor: claude` (new `.github/**` + `scripts/ci/**`; not protected).
   Add a daily CI-health report: a scheduled workflow + a producer script that reports flake rate,
   red-on-main age and per-check median/p90 duration, modelled on `ALERT-*.yml` / `TEST-CATALOG.yml`'s
   `schedule:`+publish shape. This turns the Phase-1 inventory into a standing signal. Independent.
   Files: `.github/workflows/CI-HEALTH.yml`, `scripts/ci/health/report.mjs`,
   `scripts/ci/health/report.test.mjs`, `docs/validation/<VTID>/**`.
   Test that fails on base: `scripts/ci/health/report.test.mjs` (trivially red on base — files do not
   exist), green once added; enforced by UNIT.yml which runs all `scripts/**/*.test.*`.

## Parallel / shared files / hot files

- **Parallel by default**, build concurrency ≤ 6. Lanes 1, 2, 3, 4, 5, 8 are independent; 6 depends on
  2; 7 is independent.
- **Shared-file collisions avoided:** `CICDL-GATEWAY-CI.yml` is edited only by lane 2 (lane 6 is scoped
  away from it via its NOTE and `depends_on`). `PR-GATE.yml` only by lane 6. `queue.mjs`/`queue.test.mjs`
  only by lane 3.
- **Hot file `CLAUDE.md`** (120 commits/60d) is **not edited by this plan** — no lane touches it. If a
  known-issues doc edit becomes necessary it goes under `docs/` or `.claude/rules/*`, not `CLAUDE.md`,
  to avoid the hot-file churn and the protected-gate review.
- **Cross-repo:** only lane 7 touches vitana-v1 (product + test). No platform/v1 shared file is edited
  by two lanes.

## Tests and commands

- Platform script gates: `node --test scripts/collab/queue.test.mjs`,
  `node --test scripts/collab/plan-spar.test.mjs scripts/ci/plan-spar-slot/slot.test.mjs`,
  `node --test scripts/ci/pr-gate/__tests__/*.test.mjs`, `node --test scripts/ci/health/*.test.mjs`.
- Gateway (only if a lane touches `services/gateway/**`): `cd services/gateway && npm run typecheck && npm test`.
- vitana-v1: `npm run test:unit` (vitest), `npm run test:gate`.
- Each `.github/**` / `scripts/**` change is also exercised by UNIT.yml, CI-SCRIPTS-TEST.yml and the
  PR-GATE self-test in CI.

## Measurement (common-rules §12)

Write `docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`). Record the brief's
before/after numbers for Gate 2: typical gateway-PR and vitana-v1-PR critical path (jobs, order,
duration, queue time), flake rate, and count/age of red checks on `main`. YAML-only speed lanes carry a
measured-timings artifact rather than a red→green unit test.

## Risks

- **R1 (highest):** With Claude unavailable, every protected-gate lane (3, 5, 6) is blocked on an owner
  instruction naming this plan before it can merge. Mitigation: each protected-gate edit is isolated in
  its own lane; the exact set is surfaced in Gate 2 for one naming instruction.
- **R2:** Same-file collision on `queue.mjs` with open #4210 (authoritative) and #4188. Mitigation: lane
  3 sequences behind / rebases onto #4210; never a parallel `queue.mjs` lane.
- **R3:** Protected-gate-list three-copy parity — no lane edits the list; if forced, one lane edits all
  three + keeps the parity test green.
- **R4:** Branch protection is owner config — `validate` is the only required platform check and v1 has
  none. The plan **lists** the exact branch-protection delta for Gate 2 (add Lane scope / Collab handoff
  / PLAN-SPAR / TEST-SUITE to platform's required set; enable protection on v1), never makes it.
- **R5:** Flipping PR-GATE `enforce:true` changes blocking behaviour for every PR and is a protected-gate
  edit — not done here; listed for Gate 2.
- **R6:** The Lane-scope fix (lane 3) must pass Lane scope under the OLD rule (judged from the base
  checker); its fix cannot rely on its own new logic to merge.
- **R7:** A `queue.mjs` / `staging-verify` signature change alters vitana-v1 CI at the platform-merge
  instant (cross-repo fetch, fail-closed). Keep subcommand names/shapes stable.

## Unchanged / out of scope

- No branch-protection change, no `enforce` flip, no repo-secret change — all listed for Gate 2 (owner
  config).
- `CLAUDE.md` and the protected-gate-list are not edited.
- RepoWise index is stamped `aa26481` (2026-09-19), stale vs `main`; targeted git reads from
  `origin/main` were used instead (allowed when the index is stale).
- A CI/GitHub-only change deploys nothing, so most lanes reach no staging deploy and have no Gate 2 of
  their own (common-rules §5); the plan's Gate 2 is the measured before/after numbers plus the owner-
  config list. No staging run is fabricated for a CI-only change.
- Sparring round 1 delivered no reviewable findings (partner `evidence_floor_not_met`; see
  `sparring/responses-1.md`). This revision only re-anchors the one drifted citation
  (`CICDL-GATEWAY-CI.yml` dead block, now :113-133, re-verified on `origin/main`); no premise or lane
  changed in substance.
<!-- plan:end -->

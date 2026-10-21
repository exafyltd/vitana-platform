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

## Today (file:line, origin/main bc27dd354)

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
- **`VCAOP-CICD.yml`'s vcaop CI gates are mostly covered elsewhere; one (build) needs preserving before
  deletion (R1-F1, R2-F1).** `VCAOP-GUARDRAILS-CI.yml` runs `npm run typecheck` (:39),
  `npm run test:guardrails` as the required gate (:42) and `npm test` (:45) on the same `services/vcaop/**`
  `pull_request`/`push` triggers (verified on `origin/main`) — so typecheck/guardrails/unit are not lost.
  **But `VCAOP-CICD.yml:46-48` also runs `npm run build` (= `tsc` with emit, distinct from `typecheck` =
  `tsc --noEmit`), and no other workflow builds vcaop** (`VCAOP-GUARDRAILS-CI.yml` ends at `npm test`;
  TEST-SUITE's vcaop entry runs only `npm test`). So lane 1 adds the `npm run build` step to
  `VCAOP-GUARDRAILS-CI.yml` **before** deleting `VCAOP-CICD.yml`, keeping "loses no gate" literally true.
  After that the only unique body left is the dead GCP `deploy-dev` job. Still **no** `TEST-SUITE.yml`
  migration and **no** lane-1→6 dependency. The earlier draft's "migrate the gates into TEST-SUITE first"
  premise was wrong — it missed `VCAOP-GUARDRAILS-CI.yml` entirely.
- **UNIT.yml is no longer a no-op.** VTID-04950 rewrote it to run every `scripts/**/*.test.{cjs,mjs}`
  via `node --test` (`UNIT.yml:16-20`). The brief's "UNIT.yml placeholder" premise is stale.
  (inv-code §1, inv-tests §5.)
- **The real no-op / dead remnant is the commented-out "tests deferred" block in `CICDL-GATEWAY-CI.yml:112-118`**
  ("# TESTS DEFERRED TO DEV-CICDL-0035" at :112, the six commented-out `Gateway Tests` step lines at
  :113-118; purpose comment at :5). Lines 119-137 are the **live** `Report Validation Success` step and
  must stay (its deferred-echo line is :133). So the fix deletes **only** the commented-out step lines
  :113-118 (optionally updating the live echo at :133), never re-enabling it (that would duplicate the
  real gateway Jest run in `TEST-SUITE.yml`'s 4-shard `gateway` job at :43-70 — ~1,737 suites / ~22,700
  tests, see the ground-truth counts below). (inv-code §1, §5.)
- **Ground-truth test counts (owner, 2026-10-21 — supersede the brief's stale "~7.5k gateway / 4
  shards").** Gateway Jest: **1,737 suites / ~22,700 tests**; vcaop Jest: **45 suites / ~290**; vcaop-mcp:
  **7 suites / ~58**; vitana-v1 web Vitest: **444 suites / ~2,840**; vitana-v1 mobile Jest: **61 suites /
  ~650**. Total ≈ **2,290 suites / ~26,500 tests**. Plus ~**50 Playwright / e2e** spec files and some
  shell / Python test scripts in vitana-platform that **no required check covers today** — a coverage gap
  the inventory records and the ci-health lane will surface going forward. **TEST-SUITE runs the gateway
  suite as a 4-shard matrix** (`strategy.matrix.shard: [1,2,3,4]`, `npx jest … --maxWorkers=100%
  --shard=N/4`, `TEST-SUITE.yml:43-70` — R1-F2: the brief's "4 shards" was correct; an earlier draft's
  "one job" was wrong). The speed lane re-balances those four shards on the real gateway count
  (~1,737 suites / ~22,700 tests), not on the stale "~7.5k".
- **The real gateway build+typecheck duplication is between `CICDL-GATEWAY-CI.yml` and
  `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`, not TEST-SUITE/PR-GATE.** CICDL runs the gateway build at
  :94-97 and typecheck at :103-106; `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml:16-21` installs gateway deps
  and runs `npm run build` as well (and it is the sole required check, R4). `TEST-SUITE.yml` runs only
  Jest for the gateway (`pnpm install` + `npx jest`, :63 onward — no build, no typecheck); platform
  `PR-GATE.yml:77` installs gateway deps only conditionally for fix-VTIDs. The duplicate-build target is
  therefore the CICDL ↔ ENFORCE pair. (inv-code §1, §5.)
- **PR-GATE Verdict is report-only** (`scripts/ci/pr-gate/config.json` `enforce:false` since
  2026-10-07; the scope/sparring/weakening/red-green guards use `continue-on-error:true`). The two
  real blocking governance check runs are **Collab handoff** (`collab-handoff`) and **Lane scope**
  (`lane-scope`), which exit non-zero and the §7b rule requires green. (inv-rules §6.)
- **Four confirmed pipeline false positives** (inv-rules §7, inv-code §3):
  1. PLAN-SPAR round commits are pushed with `GITHUB_TOKEN` when the optional secret
     `PLAN_SPAR_PUSH_TOKEN` is absent — the checkout token selector is `PLAN-SPAR.yml:61`
     (`token: ${{ secrets.PLAN_SPAR_PUSH_TOKEN || github.token }}`) and the push is `PLAN-SPAR.yml:116`
     (`git push origin "HEAD:${HEAD_REF}"`); the behaviour note is the comment block at :17-19. A
     `GITHUB_TOKEN` push starts no `pull_request` checks, so every merge needed `gh pr update-branch`.
  2. `validate-pr` (VALIDATOR-CHECK.yml) rejects a PR body without `VALIDATION_PROFILE` (exit 11) plus
     SCOPE_ALLOWLIST/ACCEPTANCE/MERGE_PAYLOAD_PREVIEW/OASIS_IMPACT markers (exit 12-15); path-scoped
     to the gateway trees, so it bites gateway PRs on first push with no template/autofill.
  3. Collab handoff / Lane scope false-positives in `queue.mjs` (`scopeCheck` reviewer-seat equality
     at :590-599 — `seat` at :590, the `ok` branch :592-594; the "one session per lane" rule counting
     the `ci-plan-spar` automation literal as a second session on a `_plan` lane — note `pm-agent` is
     **already** excluded (`if (k.lane && k.session !== PM_AGENT)` at `queue.mjs:452`), so only
     `ci-plan-spar` is the real cause (R1-F4); and
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

1. **dead-workflows** — `executor: claude` (governance `.github/**`; not protected). **Independent**
   (R1-F1: no `TEST-SUITE.yml` migration, no `depends_on` on lane 6).
   Remove `.github/workflows/VCAOP-CICD.yml` (dead GCP Cloud Run: `google-github-actions/auth@v2` :63,
   `gcloud run deploy vcaop-api-dev` :77-78) with its evidence row; correct the inventory's dead-list to
   today's tracked set (EXEC/STAGE-DEPLOY already gone; UNIT.yml already fixed). Its vcaop `typecheck`
   (VCAOP-CICD.yml:37-39) and `test:guardrails` (VCAOP-CICD.yml:40-42) gates are **already run on the same
   `services/vcaop/**` triggers by `VCAOP-GUARDRAILS-CI.yml`** (`npm run typecheck` :39,
   `npm run test:guardrails` :42 as the required gate, `npm test` :45 — verified on `origin/main`).
   **But `VCAOP-CICD.yml` also runs `npm run build` (:46-48 = `tsc` with emit, distinct from `typecheck` =
   `tsc --noEmit`), and that build gate is NOT in `VCAOP-GUARDRAILS-CI.yml` or TEST-SUITE's vcaop entry
   (R2-F1).** To keep "loses no gate" literally true, **this lane first adds a `Build`
   (`npm run build`) step to `VCAOP-GUARDRAILS-CI.yml`** (the surviving vcaop workflow, same
   `services/vcaop/**` triggers), then deletes `VCAOP-CICD.yml`. After that the only unique body left in
   `VCAOP-CICD.yml` is its dead GCP `deploy-dev` job. Still **no `TEST-SUITE.yml` migration and no
   `depends_on` on lane 6** — the build step lands in `VCAOP-GUARDRAILS-CI.yml`, a file no other lane
   touches, so lane 1 stays independent.
   Files: `.github/workflows/VCAOP-CICD.yml`, `.github/workflows/VCAOP-GUARDRAILS-CI.yml`,
   `docs/validation/<VTID>/**`.
   Test that fails on base: an inventory/no-dead-GCP assertion added to
   `scripts/ci/pr-gate/__tests__/` or a dedicated `scripts/ci/ci-inventory/*.test.mjs` that greps the
   workflow tree for live GCP/Cloud-Run deploy markers and fails while `VCAOP-CICD.yml` exists; plus an
   assertion that `VCAOP-GUARDRAILS-CI.yml` runs `npm run build` (red on base — it has no build step — and
   green on head), proving the vcaop build gate survived the deletion. The evidence row cites
   `VCAOP-GUARDRAILS-CI.yml` as the surviving runner of the vcaop typecheck / guardrails / build gates.

2. **fake-checks-dedupe** — `executor: claude` (governance `.github/**`; not protected).
   Delete **only** the dead commented-out `Gateway Tests` step at `CICDL-GATEWAY-CI.yml:113-118` (the
   `# TESTS DEFERRED TO DEV-CICDL-0035` marker is :112; real gateway tests live in TEST-SUITE). **Do not
   touch lines 119-137** — that is the live `Report Validation Success` step (optionally update its echo
   at :133). De-duplicate the gateway **build** that runs in both `CICDL-GATEWAY-CI.yml` (build :94-97,
   typecheck :103-106) and `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml:16-21` (the sole required check, which
   also runs `npm run build` for `services/gateway`) — not TEST-SUITE/PR-GATE, which do not build the
   gateway. Keep whichever single build covers the required path; if the two builds serve genuinely
   different triggers (different path filters), record that and drop the de-dup rather than remove a build
   the required check depends on. **`ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` is the required check**, so any
   edit to it is out of this lane's non-gate scope — if the chosen de-dup must edit that file, surface it
   as a separate decision for Gate 2 rather than silently changing the required check. Do **not** rewrite
   UNIT.yml (already real). Independent.
   Files: `.github/workflows/CICDL-GATEWAY-CI.yml`, `docs/validation/<VTID>/**`.
   Proof: measured before/after job set + the no-dead-block inventory assertion from lane 1's test
   (asserting the commented `Gateway Tests` step at :113-118 is gone and the live `Report Validation
   Success` step is intact).

3. **false-positives-collab** — `executor: claude`, **protected gate** (`scripts/collab/queue.mjs`).
   Fix in one lane (same file; cannot split): reviewer-agent seat mismatch (the `scopeCheck()`
   reviewer-seat equality branch at `queue.mjs:590-599` — `seat` at :590, the `ok` check :592-594),
   `ci-plan-spar`/`pm-agent` not counted as a second session on a `_plan` lane, and the Windows `C:\C:\`
   path + `rm` cross-platform fixes in `queue.test.mjs`. `depends_on: []` by file, but **sequence behind open
   #4210** (the authoritative governance scope-check rewrite, VTID-05259) and #4188 — do not run a
   parallel `queue.mjs` lane; if either is still open at build time, rebase onto its merged result.
   Keep every subcommand name/shape. Blocked on an owner instruction to merge (protected gate, Claude
   unavailable) — surface for Gate 2.
   Files: `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `docs/validation/<VTID>/**`.
   Test that fails on base: new cases in `scripts/collab/queue.test.mjs` encoding each wrongly-rejected
   PR shape, exercising the `scopeCheck()` path at `queue.mjs:587-600` and asserted to pass scope-check
   (red on base because current `queue.mjs scope-check` rejects them); plus a Windows-path case green on
   win32 and ubuntu.

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
   **Producer-only (owner escalation decision 2026-10-21, R3-F2 option B).** Today a `GITHUB_TOKEN` push of
   a PLAN-SPAR round commit starts no `pull_request` checks; this lane adds the *producer* of a
   needs-rebase signal and nothing else. Neither re-dispatch nor re-run can start checks on the new head
   (`gh workflow run`/`dispatches` is unavailable for `pull_request`-triggered workflows; `gh api
   .../actions/runs/{id}/rerun` re-runs the *old* SHA — R2-F1), and a Checks-API check-run needs
   `checks:write`, which the `pull_request_target` `GITHUB_TOKEN` lacks. **So the one mechanism is a commit
   status (not a check run) on the new bot head:** after the round-commit push (`PLAN-SPAR.yml:116`), add
   one step, guarded by `if: steps.guard.outputs.skip != 'true' && secrets.PLAN_SPAR_PUSH_TOKEN == ''` (the
   `GITHUB_TOKEN`-push case; when the PAT secret is present the push already starts checks and this step is
   skipped), that reads the just-pushed head SHA (`git -C head rev-parse HEAD`) and posts
   `POST /repos/{owner}/{repo}/statuses/{sha}` via `gh api` with a fixed `context` (`plan-spar/needs-rebase`),
   `state: pending`, and a `description`/`target_url` pointing at the run.
   **R3-F1 (blocker) fix — in-lane code, not owner config:** `PLAN-SPAR.yml` has an explicit workflow-level
   `permissions:` block, and an explicit block sets every unlisted scope to `none` — so `GITHUB_TOKEN`
   would *not* carry `statuses: write` and the POST would 403. This lane adds `statuses: write` to that
   block; the proof test asserts the addition.
   **Consumer deferred (R3-F2 option B):** the PM / land step that reads `plan-spar/needs-rebase` on the PR
   head and runs `gh pr update-branch` lives in the gateway service
   (`services/gateway/src/services/project-manager/act.ts`), is **not** a `scripts/ci/**` change, and needs
   a staging deploy — so it is **outside this plan's "deploys nothing" scope and is deferred to a separate
   gateway lane with its own staging deploy** (surfaced for Gate 2 alongside the PAT secret). **Until that
   consumer is built the posted status has no effect and today's behaviour is unchanged by this lane** —
   this lane is CI-only. The PAT secret itself stays **owner config → Gate 2** (with the PAT present, the
   status step never runs and checks start normally). Independent of other lanes. Blocked on an owner
   instruction to merge (protected gate) — surface for Gate 2.
   Files: `.github/workflows/PLAN-SPAR.yml`, `scripts/collab/plan-spar.test.mjs` /
   `scripts/ci/plan-spar-slot/slot.test.mjs`, `docs/validation/<VTID>/**`.
   Test that fails on base: a case in `plan-spar.test.mjs` / `plan-spar-slot/slot.test.mjs` pinning the
   **producer** contract only — (a) `PLAN-SPAR.yml`'s `permissions:` block contains `statuses: write`, and
   (b) the empty-`PLAN_SPAR_PUSH_TOKEN` path posts a `plan-spar/needs-rebase` commit status on the bot head
   (asserted against a stubbed `gh api statuses` call / the extracted status-posting helper); red on base
   because neither `statuses: write` nor the status post exists today. The test asserts **no** consumer
   behaviour (the consumer is deferred).

6. **speed-path-filters** — `executor: claude`, **protected gate** (edits `PR-GATE.yml`). **Independent**
   (R1-F1: the vcaop-matrix migration is removed, so lane 6 no longer blocks lane 1).
   Add caching to the uneven install steps, add path filters to **non-gate** jobs only, and (if a measured
   imbalance warrants) re-balance the gateway Jest shards. The gateway suite already runs as a **4-shard
   matrix** in `TEST-SUITE.yml` (`gateway` job, `strategy.matrix.shard: [1,2,3,4]`, `npx jest … --shard=${{
   matrix.shard }}/4`, name `Gateway (Jest, shard N/4)` — `TEST-SUITE.yml:43-70`, verified on `origin/main`;
   R1-F2: the brief's "4 shards" was correct). Re-balancing means rebalancing those four shards against the
   ground-truth gateway count (~1,737 suites / ~22,700 tests), not splitting a single job. Must not
   path-filter the required gate jobs (PR-GATE/Lane scope/Collab handoff) — that wedges merges.
   **No vcaop-matrix migration** (R1-F1): `VCAOP-GUARDRAILS-CI.yml` already runs the vcaop
   `typecheck` + `test:guardrails` gates on `services/vcaop/**`, so lane 1 can delete `VCAOP-CICD.yml`
   without any TEST-SUITE change; this lane does not add `typecheck`/`guardrails` steps to the `vcaop`
   matrix entry. The gateway **build** de-dup is in lane 2 (CICDL ↔ ENFORCE); this lane does not change a
   gateway build step and does not touch `CICDL-GATEWAY-CI.yml`. Record measured before/after critical
   path. It edits `PR-GATE.yml` (protected gate) so keep it isolated. Blocked on an owner instruction to
   merge (protected gate) — surface for Gate 2. Does **not** flip `enforce`.
   Files: `.github/workflows/PR-GATE.yml`, `.github/workflows/TEST-SUITE.yml` (caching / shard balance /
   non-gate path filters only), `scripts/ci/test-suite/*.test.mjs` as needed, `docs/validation/<VTID>/**`.
   NOTE: `CICDL-GATEWAY-CI.yml` is edited **only** by lane 2 (not here). `depends_on: []` (no longer
   depends on `fake-checks-dedupe`; the TEST-SUITE edits here are speed-only and touch no gateway build).
   Proof: `scripts/ci/test-suite/shard-union.test.mjs` / `rerun-policy.test.mjs` extended to pin any new
   shard/skip contract (red on base where logic changed), plus a measured-timings artifact for the
   YAML-only speed changes. (No vcaop-matrix assertion — that migration is removed.)

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
   `schedule:`+publish shape. It also surfaces the coverage gap from the ground-truth counts — the ~50
   Playwright/e2e specs and the shell/Python test scripts that no required check runs today — as a
   standing signal. This turns the Phase-1 inventory into a recurring one. Independent.
   Files: `.github/workflows/CI-HEALTH.yml`, `scripts/ci/health/report.mjs`,
   `scripts/ci/health/report.test.mjs`, `docs/validation/<VTID>/**`.
   Test that fails on base: `scripts/ci/health/report.test.mjs` (trivially red on base — files do not
   exist), green once added; enforced by UNIT.yml which runs all `scripts/**/*.test.*`.

## Parallel / shared files / hot files

- **Parallel by default**, build concurrency ≤ 6. **All eight lanes are now independent** (R1-F1 removed
  the only real `depends_on`): lane 1 deletes `VCAOP-CICD.yml` with no migration (its gates survive in
  `VCAOP-GUARDRAILS-CI.yml`), and lane 6's TEST-SUITE edits are speed-only (caching / shard balance / non-
  gate path filters), touching no gateway build and no `CICDL-GATEWAY-CI.yml`, so lane 6 no longer depends
  on lane 2. Dependency order for slotting: all eight parallel, capped at 6 concurrent with the rest
  queued.
- **Shared-file collisions avoided:** `CICDL-GATEWAY-CI.yml` edited only by lane 2. `TEST-SUITE.yml`
  edited only by lane 6 (speed changes only — no vcaop-matrix migration). `PR-GATE.yml` only by lane 6.
  `VCAOP-CICD.yml` and `VCAOP-GUARDRAILS-CI.yml` only by lane 1 (lane 1 adds the `npm run build` step to
  the latter before deleting the former). `queue.mjs`/`queue.test.mjs` only by lane 3.
  `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` (the required check) is edited by no lane; if lane 2's build
  de-dup would need to, it is surfaced for Gate 2 instead.
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
measured-timings artifact rather than a red→green unit test. Use the ground-truth test counts in the
Today section (gateway ~1,737 suites / ~22,700 tests; vcaop 45/~290; vcaop-mcp 7/~58; vitana-v1 web
444/~2,840; mobile 61/~650; ~50 Playwright/e2e specs + shell/Python scripts with no required check),
not the brief's stale "~7.5k / 4 shards".

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
- **The `plan-spar/needs-rebase` consumer is not built here (R3-F2 option B).** The PM/land read in
  `services/gateway/src/services/project-manager/act.ts` that calls `gh pr update-branch` is a gateway
  change needing its own staging deploy, outside this plan's "deploys nothing" scope — deferred to a
  separate gateway lane and listed for Gate 2 together with the `PLAN_SPAR_PUSH_TOKEN` PAT secret. Lane 5
  ships the producer (the status post) only; until the consumer exists the status has no effect.
- `CLAUDE.md` and the protected-gate-list are not edited.
- RepoWise index is stamped `aa26481` (2026-09-19), stale vs `main`; targeted git reads from
  `origin/main` were used instead (allowed when the index is stale).
- A CI/GitHub-only change deploys nothing, so most lanes reach no staging deploy and have no Gate 2 of
  their own (common-rules §5); the plan's Gate 2 is the measured before/after numbers plus the owner-
  config list. No staging run is fabricated for a CI-only change.
- **Provenance.** This spec was first sparred on PR #4247, where it converged on the lane structure but
  escalated at the 3-round / 2-session cap on two defects in lane 5's own mechanism. The owner accepted
  both: R3-F1 adds `statuses: write` to `PLAN-SPAR.yml`; R3-F2 option B narrows lane 5 to producer-only
  and defers the gateway consumer to Gate 2; the owner also supplied ground-truth test counts. Because
  #4247's session cap was reached, the owner directed re-entry as this fresh PR with a clean sparring
  chain (Route 2); #4247 stays open as the escalation record.
- **This PR's sparring.** Session 1 delivered no reviewable findings (partner `evidence_floor_not_met`;
  `sparring/responses-1.md` + a substance-neutral base re-anchor to `bc27dd354`). Session 2 round 1
  raised four findings, all **accepted** and fixed against `origin/main` (`sparring/s2-responses-1.md`):
  R1-F1 (major) — `VCAOP-GUARDRAILS-CI.yml` already runs the vcaop typecheck/guardrails gates, so lane 1
  deletes `VCAOP-CICD.yml` with no migration and no lane-1→6 dependency, and lane 6's vcaop-matrix
  migration is removed; R1-F2 (minor) — TEST-SUITE shards the gateway 4 ways (the brief's "4 shards" was
  right; the "one job" premise was wrong), corrected in Today / measurement / lane 6; R1-F3 (minor) — the
  `--runInBand` rationale is moot once the migration is dropped (guardrails already runs under `npm test`
  in three workflows); R1-F4 (minor) — lane 3's bug description is narrowed to `ci-plan-spar` only
  (`pm-agent` is already excluded at `queue.mjs:452`). Round 2 raised R2-F1 (major), also **accepted**
  (`sparring/s2-responses-2.md`): `VCAOP-CICD.yml:46-48` runs `npm run build` (`tsc` with emit), a gate
  not covered by `VCAOP-GUARDRAILS-CI.yml` or TEST-SUITE — so lane 1 now adds a `Build` step to
  `VCAOP-GUARDRAILS-CI.yml` before deleting `VCAOP-CICD.yml`, keeping "loses no gate" literally true.
<!-- plan:end -->

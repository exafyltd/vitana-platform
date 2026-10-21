# VTID-05144 — plan sparring record

- Plan: STAGING-VERIFY full runs survive a mid-run staging redeploy (superseded + attributed results + auto re-run)
- Change class: standard
- Partner: plan-sparring-partner (independent, read-only, Claude Opus 4.6 on Bedrock)
- Rounds: 2 — round 1 NOT CONVERGED (1 blocker, 2 major, 4 minor, 3 questions), round 2 CONVERGED
- Plan hash (sha256 of the text between the plan markers): `58a5c086fd9e123e078bddd99e1e2d6139cbb11a9888dce00c5fa4069066ccc1`
- Verdict: CONVERGED
- Owner approval: Owner approved at Gate 1 in the Claude Code session on 2026-10-13: "Yes, approve the staging verify plan."

## Round 1 findings (partner) and answers

- F1 [major] the stamp fetch must run in the `target` checkout, which is a different repo per service (platform for gateway, vitana-v1 for community-app) — ACCEPTED (design 1 names `origin` per service; a failed fetch stays `mismatch`).
- F2 [major] a deploy that finished just before runStart may still be rolling ECS tasks — ACCEPTED (completed-before exclusion widened to `runStart - 5 min`; under-attribution only).
- F3 [blocker] job-level `actions: write` cannot exceed the workflow level — REJECTED with evidence (job-level `permissions:` replaces the workflow-level set; the same `report` job already grants itself `statuses: write`/`pull-requests: write` beyond the workflow's `contents: read, actions: read`, and those statuses post today). Closed by the partner in round 2.
- F4 [minor] `error` status vs branch protection — ACKNOWLEDGED, kept `error` (status sits on the deployed commit, already on `main`).
- F5 [minor] `cancel-in-progress` semantics — ACCEPTED (clarified: `false` for both groups; only GitHub's one-pending-run-per-group rule replaces a queued run).
- F6 [minor] publish-gate — ACKNOWLEDGED, no change.
- F7 [minor] `-f service` shorthand — ACCEPTED (exact `gh workflow run … -f service="$SERVICE" -f commit_sha="$SUPERSEDED_BY" -f full=true -f chain=$((CHAIN+1))`).
- Q1 answered under F3, Q2 under F5, Q3 under F2.

## Round 2 (partner)

All round 1 findings closed or answered; no new blocker or major. Verdict: CONVERGED.

## Final plan and planner responses (verbatim copy of the approved plan file)

# Plan: STAGING-VERIFY full runs survive a mid-run staging redeploy (superseded + attributed results + auto re-run)
**Change class:** standard
**Repo:** exafyltd/vitana-platform
<!-- plan:begin -->
## Problem (evidence, file:line)
- Full runs (`full=true`, VTID-04949) take 22–35 min (gateway) / ~45 min (community-app); merges to main auto-deploy staging during that window (`AWS-STAGE-DEPLOY-GATEWAY.yml:34-39`, push on `services/gateway/**`).
- OASIS evidence (VTID-05128 now records full runs): gateway 38376255450 (c8d828abd4) 1,083 results, the ONLY failure `deploy › staging still serves the commit after the run` (staging moved to 28c636488a); gateway 38361375921 (a837b4194c) 1069/1070, same single failure (moved to 2541b523a); community-app 38386927973 (94e36b23c7) 274 results, same deploy failure (moved to d09d66c4f0) + VTID-05081's real perf budget (owned elsewhere, out of scope). The mid-run redeploy is the only systemic blocker for gateway full runs.
- **Root cause — the "superseded" path exists but cannot fire.** `confirmLive` returns `superseded` only if `git rev-parse <stamp>` resolves in the `target` checkout and the commit under test is its ancestor (`scripts/ci/staging-verify/run.mjs:143-147`). `target` is cloned once at job start (`.github/workflows/STAGING-VERIFY.yml:139-155`, `ref: SHA`, `fetch-depth: 0`); a commit merged mid-run is not in it → `rev-parse` fails → `mismatch` → the failing `deploy` row (`run.mjs:350-354`). Proven: run 38361375921 checked out ~07:14:20Z; `2541b523a` committed 07:17:02Z and IS a descendant of `a837b4194` (`git merge-base --is-ancestor` true).
- **Outcome rule hides real failures when superseded:** `decideOutcome` returns `superseded` before looking at results (`lib.cjs:400-405`; pinned by `lib.test.cjs:162-164` "superseded beats everything") — a real failure that ran while staging still served the commit is discarded.
- **Superseded is reported green:** report job maps `superseded` → commit status `success` (`STAGING-VERIFY.yml:224`).
- **No per-result timing exists** (rows carry only `ms`, `run.mjs:269-286`); Playwright/existing-suite tests run under `spawnSync` (`run.mjs:228, 258`), which blocks the event loop, so a background stamp poller would not run during them — and stamp sampling during an ECS rollout (old+new tasks side by side) can't prove which task served a given request anyway.
- **Concurrency:** full and per-deploy runs share `staging-verify-<service>` (`STAGING-VERIFY.yml:64-68`): a 35-min full run delays every per-deploy verification, and GitHub keeps one pending run per group, so a later queued run (any trigger) cancels an earlier queued one.
- **Earlier attempts' `fetch failed`/ECONNRESET** in other suites are consistent with requests landing during a rolling ECS deploy — not evidence about the commit under test.
- Consumers: `services/gateway/src/services/testing/publish-gate.ts:147-148` (newest `staging.verify.*` row per commit decides; superseded → blocked); `services/gateway/src/services/operator-runs/run-view.ts:494-499, 536-538` (newest row per VTID/commit; superseded → pending); `ops-attention-adapters.ts:457` (passed/failed only); Gate 2 freshness rule `.claude/skills/plan-sparring/SKILL.md:66` and `docs/DEPLOYMENT-PIPELINE.md:284-286` ("newest full run under 24 h"); nightly `.github/workflows/STAGING-VERIFY-NIGHTLY.yml:15` (02:17 UTC, dispatch with `github.token`).

## Design
Chosen: **(a)** classify correctly as superseded + attribute each result by a provable deploy cutoff + automatic re-dispatch, with a separate concurrency group for full runs.
1. **Resolve the new stamp against a fresh main** (`run.mjs` `confirmLive`): if `rev-parse <other>` fails, `git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main` in `repoRoot` once (credentials `actions/checkout` already persisted). `origin` of the `target` checkout is the repo of the service under test: `exafyltd/vitana-platform` for gateway, `exafyltd/vitana-v1` for community-app (`actions/checkout` `repository:` input, token `VITANA_V1_READ_TOKEN || GITHUB_TOKEN`, contents:read is enough for fetch) — so the fetch resolves the new commit in the right repo for both services. A failed fetch leaves the state `mismatch` (fail closed, as today), retry `rev-parse` + `isAncestor` → `{ state:'superseded', stamp, full }`. A non-descendant (e.g. a VTID-04709 pinned rollback) stays `mismatch` → failed, as today.
2. **Timestamp every result:** `runSuite` adds `started_at`/`ended_at` (ISO); static rows (baseline problem, invalid manifest, pre-run mismatch) get `static: true`.
3. **Deploy cutoff `T_cut`** (only computed when the after-run state is `superseded`): `runStart` recorded immediately before the pre-run `confirmLive`; list the service's staging deploy workflow runs via `gh api` (gateway: `exafyltd/vitana-platform` `AWS-STAGE-DEPLOY-GATEWAY.yml` with `GITHUB_TOKEN`, `actions: read` already granted; community-app: `exafyltd/vitana-v1` `AWS-STAGE-DEPLOY-FRONTEND.yml` with `VITANA_V1_READ_TOKEN`), `created >= runStart - 6h`, excluding `conclusion == skipped` and runs that completed (`updated_at`) before `runStart - 5 min` (an ECS rollout and target-group deregistration can outlast the workflow run by 30–120 s, so a deploy that finished just before the run started still counts; with `T_cut` clamped to `runStart` this only ever under-attributes — the fail-safe direction); `T_cut = min(max(created_at, runStart))` over the rest (failed/cancelled deploy runs count — they may have rolled tasks). No new image can serve before its deploy run exists (CLAUDE.md rule 17: deploys only via CI), so `T_cut` is a provable lower bound. Lookup failure or no runs → `T_cut = runStart` (fail closed: nothing attributed). Each row: `attributed = static || ended_at < T_cut`.
4. **Outcome rule** (`lib.decideOutcome`): not superseded → unchanged. Superseded → `failed` if any `!ok && attributed` row exists, else `superseded`. Unattributed rows never count, pass or fail; kept in the evidence with `attributed:false`. `superseded` is never a pass for any consumer. A real failure while the commit was served is never hidden.
5. **Message/record** (`buildReadyMessage`, `results.json`, `record-oasis.sh`): superseded message states the stamp it moved to, `T_cut`, attributed passed/failed counts and the unattributed count, listing unattributed failures under "not attributed — staging was redeploying". OASIS metadata adds `superseded_by`, `attribution_cutoff`, `chain`, per-result `attributed`. `verify` job outputs `superseded_by` (full SHA).
6. **Report job:** `superseded` → commit status `error`, description "superseded — staging moved to <short>; not verified" (PR comment wording neutral). The status is posted on the deployed commit, which is already on `main` (deploys only run after merge), so branch protection on PR heads is unaffected. New step when `FULL == true && outcome == superseded && chain < 3`: `gh workflow run STAGING-VERIFY.yml --repo exafyltd/vitana-platform --ref main -f service="$SERVICE" -f commit_sha="$SUPERSEDED_BY" -f full=true -f chain=$((CHAIN+1))` with `GH_TOKEN: github.token`; add `actions: write` to the report job's own `permissions:` block (job-level permissions replace the workflow-level set for that job — the same job already grants itself `statuses: write`/`pull-requests: write` that the workflow level `contents: read, actions: read` lacks, `STAGING-VERIFY.yml:60-62` vs `:204-206`, and those statuses post today). A `workflow_dispatch` created with `GITHUB_TOKEN` does start a new run (GitHub's documented exception to the no-recursive-trigger rule); new optional `workflow_dispatch` input `chain` (number, default 0) passed through to `run.mjs`. Cap bounds daytime churn; after 3 superseded runs the nightly run is the evidence.
7. **Concurrency:** group becomes `staging-verify-<service>${{ inputs.full && '-full' || '' }}`, `cancel-in-progress: false` for both (a running run is never cancelled — a half-run proves nothing). Full runs no longer queue ahead of per-deploy verifications. "Replaces a stale queued one" means only GitHub's built-in rule of at most one pending run per group: a newer queued full dispatch supersedes an older still-PENDING one in the `-full` group, never a running one. Both kinds are read-only (rule 48).
8. **Consumers skip superseded when a decisive row exists:** `publish-gate.ts` picks the newest `passed|failed` row for the commit, falling back to the newest row (superseded → blocked, as today) only when none exists; fetch limit 5 → 10. `run-view.ts` `latestVerify` same preference. Safe because a superseded row now holds no attributed failure (else it would be `failed`). Gate 2 freshness (`SKILL.md:66`, `DEPLOYMENT-PIPELINE.md` §8a) becomes "the newest **passed or failed** full run under 24 h; superseded full runs are skipped; a failed one blocks".

Rejected: **(b)** deploys wait on a full-run lock — blocks staging deploys/hotfixes 35–75 min (timeout 75, `STAGING-VERIFY.yml:77`), delays every Gate 2, and GitHub's cross-workflow pending-replacement would silently cancel queued deploys or full runs. **(c)** shard/speed up — shrinks but doesn't close the window; needs multi-job result merging, per-shard commit checks, Playwright installs and OASIS aggregation; possible follow-up. **(d)** nightly quiet window only — already the main evidence source (02:17 UTC), but without (a) one late merge or a manual daytime run still fails; (a) makes (d) robust, both kept.

## Out of scope
VTID-05081 phone-journey perf budget (real, owned by that VTID); sharding/speed-up (c); a per-response commit header on the gateway (would allow exact per-request attribution); non-descendant `mismatch` handling; ops-attention adapters (already ignore superseded); any production-side or deploy-workflow change.

## Test plan
- `lib.test.cjs`: `decideOutcome` — superseded + no attributed failure → `superseded`; superseded + attributed failure → `failed`; superseded + only unattributed failures → `superseded`; not superseded unchanged; update "superseded beats everything". New pure `attributeResults(results, tCut)` (boundary `ended_at == T_cut` → not attributed; `static`). New pure `deployCutoff(runs, runStart)` (skipped / completed-before excluded; in-progress-at-start → `runStart`; empty/error → `runStart`). `buildReadyMessage` superseded text with counts.
- `run.mjs` integration (local git fixture): temp repo whose clone predates a descendant commit → `confirmLive` returns `superseded` after the fetch; non-descendant → `mismatch`.
- `record-oasis.test.cjs`: `attributed`, `superseded_by`, `attribution_cutoff`, `chain` reach the body.
- Workflow static test (pattern of `record-oasis.test.cjs:17`): `-full` concurrency suffix; `chain` input; report mapping `superseded→error`; re-dispatch guarded by `chain < 3` and `FULL`.
- Gateway Jest: `publish-gate` prefers newest passed/failed over a newer superseded row and still blocks when only superseded rows exist; `run-view` `latestVerify` same.
- Staging proof (`docs/validation/<VTID>/staging-tests.json`, rule 47): dispatch gateway `full=true`, merge any gateway change during it → expect `staging.verify.superseded` with `superseded_by` and a chained full run dispatched (`chain=1`); a quiet-window/nightly full run → `staging.verify.passed` with `metadata.full=true`.

## Scope (files)
`scripts/ci/staging-verify/run.mjs`, `lib.cjs`, `lib.test.cjs`, `record-oasis.sh`, `record-oasis.test.cjs`; `.github/workflows/STAGING-VERIFY.yml`; `services/gateway/src/services/testing/publish-gate.ts` (+ test); `services/gateway/src/services/operator-runs/run-view.ts` (+ test); `.claude/skills/plan-sparring/SKILL.md` (Gate 2 freshness line); `docs/DEPLOYMENT-PIPELINE.md` §8a.
<!-- plan:end -->

## Round 1 — Planner responses
- **F1 [major] fetch in target checkout / two repos** — ACCEPTED. Design 1 now states `origin` per service (platform for gateway, vitana-v1 for community-app via `actions/checkout` `repository:` + `VITANA_V1_READ_TOKEN || GITHUB_TOKEN`), contents:read suffices, and a failed fetch stays `mismatch` (fail closed).
- **F2 [major] deploy finished just before runStart, ECS rollout still in progress** — ACCEPTED. Completed-before exclusion widened to `runStart - 5 min`; documented as under-attribution only (fail-safe; unattributed results never count).
- **F3 [blocker] job-level `actions: write` cannot exceed workflow level** — REJECTED with evidence. In GitHub Actions a job-level `permissions:` block replaces the workflow-level set for that job; it is not capped by it (the cap is the repo/org default-token setting and fork PRs). This very job already does it: workflow level grants only `contents: read, actions: read` (`STAGING-VERIFY.yml:60-62`) while the `report` job grants itself `statuses: write, pull-requests: write` (`:204-206`), and those commit statuses are posted successfully today (e.g. `staging-verify` statuses on the gateway runs recorded in OASIS 2026-10-13). Adding `actions: write` beside them follows the same mechanism. Plan text now says this explicitly. Re-dispatch via `GITHUB_TOKEN` + `workflow_dispatch` is GitHub's documented exception that does start a run.
- **F4 [minor] `error` status vs branch protection** — ACKNOWLEDGED, kept `error`: the status is posted on the deployed commit, which is already on `main` (staging deploys only follow merges), so required checks on PR heads are never affected. `error` = "could not verify", which is the honest meaning; `failure` would read as a real test failure.
- **F5 [minor] cancel-in-progress semantics** — ACCEPTED (clarified). `cancel-in-progress: false` for both groups; "replaces a stale queued one" = GitHub's one-pending-run-per-group rule only, never a running run.
- **F6 [minor] publish-gate** — ACKNOWLEDGED, no change.
- **F7 [minor] `-f service` shorthand** — ACCEPTED. Exact command now in the plan: `-f service="$SERVICE" -f commit_sha="$SUPERSEDED_BY" -f full=true -f chain=$((CHAIN+1))`.
- **Q1** answered under F3. **Q2** answered under F5. **Q3** answered under F2 (accepted approximation, fail-safe direction, window widened).

## Appendix — partner text (verbatim)

### Round 1 verdict
> NOT CONVERGED -- F3 is a blocker (the `actions: write` permission escalation will not work as designed), and F1 and F2 are majors that need explicit answers. F7 is reclassified to minor (plan shorthand, not a real omission) after re-reading, but F3 remains a hard blocker that will cause the re-dispatch to fail with a 403.

### Round 2 — prior findings disposition
> - **F1 [major]** -- `closed`. Plan now explicitly documents `origin` per service and the cross-repo fetch path for community-app.
> - **F2 [major]** -- `closed`. Exclusion widened to `runStart - 5 min`, documented as under-attribution only (fail-safe direction).
> - **F3 [blocker]** -- `closed`. I was wrong. GitHub job-level `permissions` replaces the workflow-level set for that job, not intersects. The report job already demonstrates this: `statuses: write` / `pull-requests: write` at lines 204-206 work today despite the workflow level granting only `contents: read` / `actions: read` at lines 60-62. Adding `actions: write` follows the same mechanism. The nightly workflow (`STAGING-VERIFY-NIGHTLY.yml:57-62`) already dispatches `STAGING-VERIFY.yml` via `github.token` with `actions: write`, confirming the pattern works end to end in this repo.
> - **F4 [minor]** -- `closed`. `error` is honest ("could not verify") and the status is posted on an already-merged commit, not a PR head, so branch protection is unaffected.
> - **F5 [minor]** -- `closed`. `cancel-in-progress: false` for both groups; "replaces a stale queued one" is only GitHub's one-pending-per-group built-in, clarified.
> - **F6 [minor]** -- `closed`. No change needed.
> - **F7 [minor]** -- `closed`. Exact command with `-f service="$SERVICE"` now in the plan.
>
> No new blocker or major findings. [...] Verdict: CONVERGED

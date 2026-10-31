---
change_class: standard
---
# plan(pipeline-agent-wake-and-review): wake the driver on sparring/review events, an independent reviewer fallback, and CI merge of converged plan PRs
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610271503-9458` (Kiro Web). Repos: `exafyltd/vitana-platform`
(spec, lanes 1-3) and `exafyltd/vitana-v1` (lane 4). Premises pinned to platform `origin/main` `fe4495db71`, vitana-v1
`origin/main` `57aece53f`. Detail per lane: `tasks.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web): *"Create a plan named `pipeline-agent-wake-and-review` to wake the driver promptly when
sparring or review results arrive and recover from stuck sparring sessions. Coordinate the stuck-session work with
the Kiro parity session, which is already investigating it. Explore a qualified independent reviewer fallback and
automatic merging of eligible converged plan PRs. Preserve required reviews, branch protections, and checks. Show how
failures and unavailable reviewers are handled. Proceed through protected-file review where required."*

Measured (pipeline analysis 2026-10-27, 31 sparred plans since 2026-10-13): a CI sparring round takes p50 4 min, but
the planner's answer to a round takes p50 5 min, **p90 3.4 h** (sum 147 h), and convergence → plan PR merged takes
p50 41 min, **p90 19.6 h** (sum 175 h). Reviews: VTID-05340 waited 16.6 h (15 h idle overnight); pipeline-speed and
ci-github-modernization lanes were blocked for hours when all three reviewer models returned `model_unavailable` at
once (`docs/validation/VTID-05336/timings.json`, `VTID-05301/timings.json`).

## 2. Today
1. **Wake-up.** collaboration.md §8 (`:311-332`): a live driver polls every 2-3 min; without one, the seat
   automations (`.kiro/automations/<seat>.md`) wake hourly on weekdays. Kiro Web schedules run at most hourly
   (kiro.dev/docs/web/automations). Nothing reacts to a PLAN-SPAR round or a review entry. Kiro documents one remote
   start path usable from CI: `kiro-cli chat --v3 --no-interactive --cloud --repo <owner/repo> "<prompt>"` with
   `KIRO_API_KEY` (kiro.dev/docs/cli/headless, "Cloud sessions in V3"); no such secret exists in the repo today.
   Heartbeat age is readable from `refs/heads/collab-driver/<slug>` (`scripts/collab/plan-driver.mjs heartbeat-age`).
2. **Stuck sparring.** Plan `plan-spar-stuck-session` (merged #4406, lane `stuck-recovery` VTID-05350 `ready`,
   driver session `kiro-exafy-202610271051-d636`) bounds partner calls, lowers `STALE_AFTER_MS` to 20 min and makes
   the CI client re-post once in the same run. This plan does **not** touch `plan-spar.mjs` or `plan-sparring/**`.
   What it leaves open: a PLAN-SPAR run that still ends `failure` (e.g. the `stuck` error) waits for the next driver
   wake to apply the §7a re-run.
3. **Reviewer chain.** `REVIEWER_AGENT_MODELS` (`services/gateway/src/services/project-manager/governance.ts:35-39`)
   = three Claude models, mirrored in `scripts/ci/kiro-steering/guard.cjs:106` and the agent's `Model chain:` line
   (`guard.cjs:123`). `isAgentReview` (`governance.ts:129-135`) accepts the bare `agent:vitana-lane-reviewer` and
   `agent:vitana-lane-reviewer (<chain model>)` (`AGENT_REVIEWER_VALUES`, `:129`). All three are served by one provider, so one outage stops every review; driver.md step 4 then parks the
   lane. In Kiro Web a sub-agent runs on the session model unless its agent file pins `model:`
   (kiro.dev/docs/custom-agents/configuration-reference); Kiro also serves non-Anthropic models (OpenAI GPT-5.6,
   GLM-5, MiniMax M2.5, …; kiro.dev/docs/models).
4. **Plan PR merge.** planning.md §6 / collaboration.md §7b (`:243-262`): a converged, policy-approved, spec-only
   `plan(` PR merges as soon as its checks are green — by the PM, else by the driver. Repo setting
   `allow_auto_merge=false`. Nothing merges it when no driver is awake.
5. Protected gate files touched by this plan: `governance.ts`, `scripts/collab/queue.mjs`,
   `scripts/collab/protected-gate-files.json`. Hot-file neighbours: plan `pipeline-lane-state-efficiency` lane
   `chain-transitions` (`queue.mjs`, #4413); plan `pm-reassign-idempotent` (#4396, PM files, not `governance.ts`).
   `.kiro/pipeline/driver.md` (#4392) and `lane-review.md`/`lane-land.md` (#4407) are **not** edited here.

## 3. Lanes
### Lane 1 `driver-wake` (vitana-platform, executor kiro, reviewer agent)
1. `scripts/collab/driver-wake.mjs` (`decide(event, now)` pure, plus a CLI). Events: PLAN-SPAR `workflow_run`
   completed (success **or** failure) on a `plan(<slug>)` PR; a push to a `kiro/<slug>/<lane>` branch whose new commit
   carries `Collab-Verdict:`. Slug checked with a local copy of `/^[a-z0-9][a-z0-9-]*$/` (the module-private
   `SLUG_RE` of `queue.mjs:57`; `plan-driver.mjs:39` keeps its own copy too); a test reads both files and asserts the
   three regex sources are equal (R1-F3). Anything else → `skip: not a plan event`.
2. Decision: driver heartbeat younger than 45 min → `skip: driver alive` (it polls every 2-3 min). A wake marker
   `refs/heads/collab-wake/<slug>` younger than 20 min → `skip: woken recently`. More than 6 wakes in the last hour
   repo-wide (markers) → `skip: wake budget`. Otherwise `wake`. Each run first deletes `collab-wake/*` refs older than
   2 h (they hold no work: tree = `main`'s), so at most the last 2 h of markers exist and the budget scan stays small
   (s2 R1-F4).
3. `wake`: write the marker (a commit whose tree is `origin/main^{tree}`, like the heartbeat; fast-forward only), then
   start one Kiro cloud session with a **fixed** prompt: *"Read `.kiro/automations/wake.md` in vitana-platform and
   follow it for plan `<slug>`."* (slug validated; no event text in the prompt). `KIRO_API_KEY` unset → no session,
   job summary `wake unavailable: KIRO_API_KEY not configured`, exit 0.
4. `.kiro/automations/wake.md`: an automation-started driver (driver.md "Automation-started driver") for that one
   plan: resume, answer an open round, run reviews, re-run a PLAN-SPAR run that failed for infra once (§7a allowlist),
   never merge, stop when nothing is left. It reuses driver.md; it does not change it.
5. `.github/workflows/DRIVER-WAKE.yml`: triggers `workflow_run: [PLAN-SPAR] completed` and `push` with
   `branches: ['kiro/**']` **and** `paths: ['.kiro/specs/*/lanes/*.md']` (a review entry always appends to a lane file,
   so pushes that touch no lane file never start a run; R2-F2);
   `permissions: contents: write` (marker ref only); `concurrency: driver-wake-<slug>`; installs Kiro CLI with the
   documented installer only on a `wake` decision, version pinned and checksum-verified where the installer offers
   it (recorded in `commands.log`). Never runs on `pull_request` from a fork; never reads PR text into a prompt.
6. Tests (`driver-wake.test.mjs`, red on base): every decision branch above, slug injection
   (`a;rm -rf`, `../x`, uppercase) → skip, missing key → no-op exit 0, marker write is fast-forward only.

### Lane 2 `reviewer-fallback` (vitana-platform, executor claude — protected gate files)
1. **An independent tier, empty until qualified — enforcement by function (R3-F2, option A).** `governance.ts` gains
   `REVIEWER_AGENT_INDEPENDENT_MODELS: readonly string[] = Object.freeze([])` and the identity
   `agent:vitana-lane-reviewer-independent (<model>)`. `isAgentReview` stays the **chain reviewer only** (unchanged,
   `AGENT_REVIEWER_VALUES`). A new `isIndependentReview(r: ReviewEntry): boolean` checks (a) `verdict: accept` and the
   model of the identity is in the list, and (b) `r.fallback_reason === 'chain_unavailable'`. Condition (c) is checked
   at the two call sites, which hold the lane and the PR: `reviewSatisfiesLane` (`governance.ts:159-169`) returns
   `isIndependentReview(r) && !filesTouchGovernance(pr.files ?? lane.paths) && reviewOnCurrentHead(r, pr)` inserted
   **immediately after the `isAgentReview` branch (`:162`) and before the `if (r.reviewer) return false` guard
   (`:163`)**, which would otherwise discard every independent review (s2 R1-F3); `governanceMergeAllowed` (`:179-201`) never unlocks a protected gate file or a governance lane with
   it (its protected branch and its `laneTouchesGovernance` branch return `protected_gate_file` / `no_agent_accept`
   for an independent review). (b) comes from the driver: the review commit carries
   `Collab-Fallback-Reason: chain_unavailable` only after the three chain models returned `model_unavailable` on the
   same head (lane `review-fallback-trailer` parses it into `ReviewEntry.fallback_reason`). And (c) the lane
   PR changes **no governance path** as already defined by `GOVERNANCE_PATHS` (`queue.mjs:85`, `governance.ts:64`:
   `.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`, CLAUDE.md,
   `docs/programs/areas.yaml`); `.kiro/specs/**` lane and handoff files are not governance paths (R1-F1). Such lanes
   keep waiting for a chain model. A protected gate file still needs Claude or the owner, unchanged. Only the form
   `agent:vitana-lane-reviewer-independent (<model>)` counts; the bare `agent:vitana-lane-reviewer-independent` never
   does, so every independent accept names the model it ran on (R1-F2).
2. **Agent file.** `.kiro/agents/vitana-lane-reviewer-independent.md`: byte-identical body to
   `vitana-lane-reviewer.md` except `name` and a pinned `model:`. `scripts/ci/kiro-steering/guard.cjs` (in this lane's
   `paths`, with `guard.test.cjs`; R3-F1) gets a block in `checkAgents` (`guard.cjs:145-175`) that, when the file
   exists, requires `tools`, `excludedTools`, `permissions`, `includeMcpJson`, `includePowers` and the body equal to the
   chain reviewer's, and its `model:` in a mirrored `REVIEWER_INDEPENDENT_MODELS` (pinned equal to `governance.ts` by
   `guard.test.cjs`, like `REVIEWER_MODELS`); with the list empty the file may exist only without a `model:` pin.
   `guard.cjs` is not edited by `pipeline-lane-state-efficiency`.
3. **Qualification before enabling.** `scripts/collab/reviewer-qualify.mjs` records shadow reviews in
   `docs/reviewer-qualification/<model>.json` (schema `vitana.reviewer-qualification/v1`): for a lane head reviewed by
   a chain model, the independent agent reviews the same head read-only and its verdict is stored, never used. A model
   is *qualified* when ≥ 10 pairs on ≥ 3 plans, verdict agreement ≥ 90 %, and **zero** pairs where it accepted a head
   the chain model rejected with a blocking finding. `reviewer-qualify.mjs check <model>` prints the verdict. Adding a
   model to the list is a separate one-line protected change whose PR carries the passing record; candidates in
   order: OpenAI GPT-5.6 Terra, GLM-5 (the exact Kiro model ids are read from `/model` and recorded then).
3a. **Lane scope accepts the independent reviewer's entry — targeted, `REVIEWER_AGENTS` unchanged (R2-F1, s2 R2-F1).**
   `REVIEWER_AGENTS` / `isReviewerAgent` (`queue.mjs:74-75`) are **not** widened, so the governance-path exemptions
   that key on them (`validateLane` `:234`, `scopeCheck` `:701`) never apply to the independent agent. Only the
   reviewer rule of `scopeCheck` (`:709-713`) gets one exception: on a lane whose `reviewer_seat` is
   `agent:vitana-lane-reviewer`, a review entry whose session satisfies
   `agentOf(k.session) === 'agent:vitana-lane-reviewer-independent'` is accepted. `validateLane` needs no new code: a
   lane file setting `reviewer_seat: agent:vitana-lane-reviewer-independent` is already refused at `:224-225` (not
   `claude`, not a reviewer agent, not a seat). Tests: independent session on a chain-reviewer lane → no Lane-scope
   error; on a `reviewer_seat: claude` lane → error; `reviewer_seat: agent:vitana-lane-reviewer-independent` → validate
   error; `isReviewerAgent('agent:vitana-lane-reviewer-independent') === false` (pins that the exemptions are not
   widened).
4. **Protected list.** Adds `.kiro/agents/vitana-lane-reviewer-independent.md`, `.github/workflows/PLAN-PR-MERGE.yml`,
   `scripts/collab/plan-merge.mjs` and `.github/workflows/DRIVER-WAKE.yml` (s2 R1-F1: it holds `KIRO_API_KEY` and writes
   refs) to `protected-gate-files.json`, `PROTECTED_GATE_BUILTIN` (`queue.mjs:92-96`)
   and `PROTECTED_GATE_GLOBS` (`governance.ts:44`), in one commit so the three copies never differ.
5. **Rules text.** collaboration.md §3 names the independent identity and its three conditions; §7b names
   `PLAN-PR-MERGE.yml` as an actor that applies the plan-PR clause of §7b and nothing else.
6. **Failure handling, end to end:** chain model fails → next chain model on the same head (unchanged); all three fail
   → independent agent if the list is non-empty and the lane is not governance, else the lane is parked with one
   blocker (unchanged); independent agent fails or returns `changes` → parked / back to `executing` as today. Every
   attempt is a log line; nothing waits on an unavailable model.
7. Tests (red on base): `isAgentReview` unchanged for every existing identity; `isIndependentReview` false for a
   model not in the list, for a missing or other `fallback_reason` (R3-F3), for `changes`; `reviewSatisfiesLane` false
   for an independent accept on a governance lane and on a stale head; `governanceMergeAllowed` refuses it for a
   protected file and a governance lane; governance test cases for (a)-(c) each failing alone, empty list → never accepted, identity
   spoofing (`agent:vitana-lane-reviewer-independent-fake`), the bare independent identity → not accepted, the bare
   `agent:vitana-lane-reviewer` still accepted (regression, R1-F2), a lane changing only `.kiro/specs/**` + product code
   → eligible, a lane changing `.kiro/steering/**` → not eligible (R1-F1), protected file → still needs Claude; guard cases for the
   agent file; `reviewer-qualify` thresholds (9 pairs, 2 plans, 89 %, one false accept → not qualified).

### Lane 2b `review-fallback-trailer` (vitana-platform, executor kiro, reviewer agent; R3-F3)
1. `services/gateway/src/services/project-manager/types.ts` `ReviewEntry` (`:57-73`) gains
   `fallback_reason?: string | null`.
2. `observe-live.ts` parses the `Collab-Fallback-Reason` trailer of a review commit into it, next to
   `Collab-Reviewer` / `Collab-Reviewed-Head`; absent → `null`. Nothing reads the field yet (lane 2 does), so this lane
   changes no decision.
3. Tests (`test/project-manager/observe-live-fallback-reason.test.ts`, red on base): trailer present → field set;
   absent → `null`; a value other than `chain_unavailable` is kept verbatim (lane 2 decides).
4. Sequencing: lane 2 is built on top of this lane's merge (it reads the field); recorded here because the
   `reviewer-fallback` lane file already exists on this plan PR (a `_plan` commit may not edit it).

### Lane 3 `plan-pr-merge` (vitana-platform, executor claude — protected after lane 2; `depends_on: [reviewer-fallback]`)
1. `scripts/collab/plan-merge.mjs` (`eligible(pr, files, head, checks)` pure): merge only when **all** hold — PR
   open, not draft, same-repo head, base `main`, title `plan(<slug>)`; every changed file is under
   `.kiro/specs/<slug>/` or is `docs/programs/*/program.md`; head `handoff.md` `state: approved` with `vtids`; the last
   `sparring/state.json` session `verdict: converged` with `policy_approved_at` set; and the plan block of `plan.md`
   (between the two plan marker comments) at the head is **byte-identical** to the plan block at the
   newest commit whose `Collab-Session` is `ci-plan-spar` and that wrote `sparring/verdict.md` (read with `git show`),
   so the approved text is exactly what merges. No plan hash is recomputed and nothing is imported from the
   TypeScript gateway or from `plan-spar.mjs` (s2 R1-F2); every check run on the head
   completed `success|neutral|skipped` (none pending or failed); `mergeable_state: clean`. Else a one-line reason and
   no merge.
2. `.github/workflows/PLAN-PR-MERGE.yml`: `workflow_run` of the workflows that run on plan PRs (PLAN-SPAR, PR-GATE,
   unit, Validator Check, STAGING-TESTS-REQUIRED) + `workflow_dispatch`; `permissions: contents: write,
   pull-requests: write`; uses `GITHUB_TOKEN` only; squash merge with `sha: <head>` so a newer push is never merged.
   **Never** `--admin`, never a bypass; a branch-protection refusal is reported, not retried. Records the merge in the
   job summary (authority `§7b plan-PR rule via PLAN-PR-MERGE`). Concurrency: one run per PR.
3. Tests (red on base): each criterion failing alone → no merge; a non-spec file; a protected gate file; a plan hash
   mismatch (plan edited after approval); a pending check; a head moved between check and merge (`sha` guard).

### Lane 4 `v1-collab-sync` (vitana-v1, executor kiro, reviewer agent; `depends_on: [reviewer-fallback]`)
`.claude/rules/collaboration.md` byte-identical to platform `origin/main` after lane 2 merges (owner-autonomy V4
pattern); sha256 recorded in both repos' evidence.

## 4. Parallel / sequencing
Lanes 1 and 2b run in parallel (no shared file); lane 2 after lane 2b (reads `ReviewEntry.fallback_reason`). Lane 3 after lane 2 (`governance.ts`, protected list). Lane 2's
`queue.mjs` edit lands after `pipeline-lane-state-efficiency/chain-transitions` merges or is merged up to date with it
(one merge per repo; hot file). Lane 4 after lane 2. `DRIVER-WAKE.yml` is created by lane 1 (executor kiro) and becomes protected in lane 2's
protected-list commit, so lane 2's protected-list commit lands after lane 1 has merged; if lane 1 is still open then,
it needs a Claude or owner review like any protected file (s2 R1-F1).

## 5. Unchanged
Sparring rules and the partner chain, PLAN-SPAR and `plan-spar.mjs` (owned by `plan-spar-stuck-session` / #4215),
required checks, Lane scope, Collab handoff, branch protection, the §7b conditions themselves, protected-file review,
the three-model chain and its order, driver.md, and every stop of `vitana-owner-autonomy.md`. An automation-woken
driver never merges and never publishes. Nothing here deploys a service.

## 6. Measurement
`docs/validation/<VTID>/timings.json` per lane plus, 7 days after lanes 1 and 3 merge: round posted → planner answer
(p50/p90) and convergence → plan merged (p50/p90), against the baselines in §1; wakes started vs skipped by reason;
independent-reviewer shadow pairs recorded.

## 7. Owner / administrator actions
- Create a Kiro API key (Kiro portal, a Pro+ seat) and store it as repository secret `KIRO_API_KEY`; until then lane 1
  is merged but every wake reports `wake unavailable`.
- Enabling an independent model: approve its qualification record (protected one-line change).

## 8. Risks
- Cost: each wake is one cloud session; bounded by the 20-min marker, 6 wakes/hour and the live-driver check.
- Prompt injection through events: the prompt is a fixed string with a validated slug.
- Auto-merge widening: the merge script and workflow become protected gate files (lane 2) before lane 3 exists;
  the wake workflow becomes protected right after lane 1 merges.
- An independent model's lower quality: shadow qualification first, never for governance paths, empty by default.
<!-- plan:end -->

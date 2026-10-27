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
   (`guard.cjs:119`). `isAgentReview` (`governance.ts:130-135`) accepts only `agent:vitana-lane-reviewer (<chain
   model>)`. All three are served by one provider, so one outage stops every review; driver.md step 4 then parks the
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
   carries `Collab-Verdict:`. Slug parsed with the queue's `SLUG_RE`; anything else → `skip: not a plan event`.
2. Decision: driver heartbeat younger than 45 min → `skip: driver alive` (it polls every 2-3 min). A wake marker
   `refs/heads/collab-wake/<slug>` younger than 20 min → `skip: woken recently`. More than 6 wakes in the last hour
   repo-wide (markers) → `skip: wake budget`. Otherwise `wake`.
3. `wake`: write the marker (a commit whose tree is `origin/main^{tree}`, like the heartbeat; fast-forward only), then
   start one Kiro cloud session with a **fixed** prompt: *"Read `.kiro/automations/wake.md` in vitana-platform and
   follow it for plan `<slug>`."* (slug validated; no event text in the prompt). `KIRO_API_KEY` unset → no session,
   job summary `wake unavailable: KIRO_API_KEY not configured`, exit 0.
4. `.kiro/automations/wake.md`: an automation-started driver (driver.md "Automation-started driver") for that one
   plan: resume, answer an open round, run reviews, re-run a PLAN-SPAR run that failed for infra once (§7a allowlist),
   never merge, stop when nothing is left. It reuses driver.md; it does not change it.
5. `.github/workflows/DRIVER-WAKE.yml`: triggers `workflow_run: [PLAN-SPAR] completed` and `push: kiro/**`;
   `permissions: contents: write` (marker ref only); `concurrency: driver-wake-<slug>`; installs Kiro CLI with the
   documented installer only on a `wake` decision, version pinned and checksum-verified where the installer offers
   it (recorded in `commands.log`). Never runs on `pull_request` from a fork; never reads PR text into a prompt.
6. Tests (`driver-wake.test.mjs`, red on base): every decision branch above, slug injection
   (`a;rm -rf`, `../x`, uppercase) → skip, missing key → no-op exit 0, marker write is fast-forward only.

### Lane 2 `reviewer-fallback` (vitana-platform, executor claude — protected gate files)
1. **An independent tier, empty until qualified.** `governance.ts` gains
   `REVIEWER_AGENT_INDEPENDENT_MODELS: readonly string[] = Object.freeze([])` and the reviewer identity
   `agent:vitana-lane-reviewer-independent (<model>)`. `isAgentReview` accepts it only when (a) the model is in that
   list, (b) the review entry records that every chain model was tried on the same head and returned
   `model_unavailable` (log lines from the driver, `Collab-Fallback-Reason: chain_unavailable`), and (c) the lane
   touches **no governance path** (`.github/**`, `.claude/**`, `.kiro/**`, `scripts/collab/**`, CLAUDE.md, areas.yaml)
   — such lanes keep waiting for a chain model. A protected gate file still needs Claude or the owner, unchanged.
2. **Agent file.** `.kiro/agents/vitana-lane-reviewer-independent.md`: byte-identical body to
   `vitana-lane-reviewer.md` except `name` and a pinned `model:`; `guard.cjs` pins that equality (tools, permissions,
   fail-loudly rules) and that the model is in `REVIEWER_AGENT_INDEPENDENT_MODELS` or the list is empty.
3. **Qualification before enabling.** `scripts/collab/reviewer-qualify.mjs` records shadow reviews in
   `docs/reviewer-qualification/<model>.json` (schema `vitana.reviewer-qualification/v1`): for a lane head reviewed by
   a chain model, the independent agent reviews the same head read-only and its verdict is stored, never used. A model
   is *qualified* when ≥ 10 pairs on ≥ 3 plans, verdict agreement ≥ 90 %, and **zero** pairs where it accepted a head
   the chain model rejected with a blocking finding. `reviewer-qualify.mjs check <model>` prints the verdict. Adding a
   model to the list is a separate one-line protected change whose PR carries the passing record; candidates in
   order: OpenAI GPT-5.6 Terra, GLM-5 (the exact Kiro model ids are read from `/model` and recorded then).
4. **Protected list.** Adds `.kiro/agents/vitana-lane-reviewer-independent.md`, `.github/workflows/PLAN-PR-MERGE.yml`
   and `scripts/collab/plan-merge.mjs` to `protected-gate-files.json`, `PROTECTED_GATE_BUILTIN` (`queue.mjs:92-96`)
   and `PROTECTED_GATE_GLOBS` (`governance.ts:44`), in one commit so the three copies never differ.
5. **Rules text.** collaboration.md §3 names the independent identity and its three conditions; §7b names
   `PLAN-PR-MERGE.yml` as an actor that applies the plan-PR clause of §7b and nothing else.
6. **Failure handling, end to end:** chain model fails → next chain model on the same head (unchanged); all three fail
   → independent agent if the list is non-empty and the lane is not governance, else the lane is parked with one
   blocker (unchanged); independent agent fails or returns `changes` → parked / back to `executing` as today. Every
   attempt is a log line; nothing waits on an unavailable model.
7. Tests (red on base): governance test cases for (a)-(c) each failing alone, empty list → never accepted, identity
   spoofing (`agent:vitana-lane-reviewer-independent-fake`), protected file → still needs Claude; guard cases for the
   agent file; `reviewer-qualify` thresholds (9 pairs, 2 plans, 89 %, one false accept → not qualified).

### Lane 3 `plan-pr-merge` (vitana-platform, executor claude — protected after lane 2; `depends_on: [reviewer-fallback]`)
1. `scripts/collab/plan-merge.mjs` (`eligible(pr, files, head, checks)` pure): merge only when **all** hold — PR
   open, not draft, same-repo head, base `main`, title `plan(<slug>)`; every changed file is under
   `.kiro/specs/<slug>/` or is `docs/programs/*/program.md`; head `handoff.md` `state: approved` with `vtids`; the last
   `sparring/state.json` session `verdict: converged`, `policy_approved_at` set and `final_plan_hash` equal to the
   plan-block hash at the head (same hash function as PLAN-SPAR, imported read-only); every check run on the head
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
Lanes 1 and 2 run in parallel (no shared file). Lane 3 after lane 2 (`governance.ts`, protected list). Lane 2's
`queue.mjs` edit lands after `pipeline-lane-state-efficiency/chain-transitions` merges or is merged up to date with it
(one merge per repo; hot file). Lane 4 after lane 2.

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
- Auto-merge widening: the merge script and workflow become protected gate files (lane 2) before lane 3 exists.
- An independent model's lower quality: shadow qualification first, never for governance paths, empty by default.
<!-- plan:end -->

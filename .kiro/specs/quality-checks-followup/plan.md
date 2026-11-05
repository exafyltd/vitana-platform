---
change_class: standard
---
# plan(quality-checks-followup): merge-policy wording, quality checks in Kiro Web steering, reviewer requester rule
Author: Kiro, seat `jtadic`, session `kiro-jtadic-202610271220-68a5` (Kiro Web). Repo: `exafyltd/vitana-platform`.
Premises pinned to `origin/main` `850dfeb90a`. Follows plan `quality-checks` (VTID-05346/05347/05348, merged #4407,
#4408, exafyltd/vitana-v1#1503). Detail per lane: `tasks.md`; lane files under `lanes/`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-28 (Kiro Web), after plan `quality-checks`: *"Confirm the new 'always squash-merge' instruction agrees
with the existing repository policy. Resolve any conflict explicitly."* · *"Separately, prepare a narrowly scoped
correction to the reviewer-rule conflict: preserve independence of the actual reviewer while allowing the builder to
request a review. Document the conflicting instructions and route the proposed correction through protected-file
review. Do not weaken substantive review requirements."* · *"Coordinate inclusion of `quality-checks.md` with the
session owning the steering generator. Verify that a fresh session actually receives the guidance."*

## 2. Today
**A. Merge method.** Squash is the policy in practice and in code; one document reads as if a GitHub merge commit is
equivalent, which it is not.
- The Project Manager merges with `merge_strategy: 'squash'` (`services/gateway/src/services/project-manager/act.ts:245`,
  `:356`); `planning.md:75` merges the plan PR "(squash)"; `lane-land.md:41-42` (VTID-05346) says squash; the last 40
  first-parent commits of vitana-platform `main` all have one parent.
- `docs/DEPLOYMENT-PIPELINE.md:155` and the comment at `scripts/ci/staging-verify/lib.cjs:240-245` say a PR merged with
  a merge commit "is judged by the merge commit, whose subject carries the PR title and VTID". GitHub's default
  merge-commit subject is `Merge pull request #<n> from <branch>` with the title in the body, and
  `extractVtids(c.subject)` reads only the subject (the rule-47 decision in `lib.cjs:302-304` `planRange`; manifest
  loading in `run.mjs:375`): vitana-v1 `11b4e2ba2`, `b8a4efbd3`, `624618db1`,
  `aa3fb55f2` (#1452, #1450, #1451, #1447) have no VTID in their subject and failed rule 47 (STAGING-VERIFY runs
  39952660840, 39870086198, 39783669906). `lane-code.md:29` ("merge `origin/main` into BRANCH (merge commit)") is a
  branch update, not a PR merge: no conflict.
- Repos allow squash, merge and rebase (`allow_merge_commit: true` on both); no branch rule fixes the method.

**B. Kiro Web steering.** A fresh session does not receive `quality-checks.md`. `scripts/collab/kiro-web-steering.mjs:28`
inlines only `DRIVER_LINKS = ['.kiro/pipeline/driver.md', '.kiro/pipeline/common-rules.md', '.kiro/pipeline/planning.md']`.
Generated on `origin/main` `850dfeb90a` into an empty workspace (`--workspace <tmp>`): 14 files, no file contains
`quality-checks`. `planning.md`, `lane-code.md`, `lane-review.md` name the file but do not inline it. Ownership: plan
`kiro-web-steering` (VTID-05339) is `done`; the open plan `kiro-web-reliability` (#4392, session
`kiro-exafy-202610271051-d636`) changes `kiro-web-session.mjs`, `preflight.mjs`, `AGENTS.md`, `driver.md` and
`docs/kiro-web-parity/**`, not `kiro-web-steering.mjs` or its test (lane files `preflight-validator`,
`session-reliability` on its plan branch). The always-included set is about 132 KB inlined; Kiro truncates a long
inlined link without a documented cap (`docs/kiro/kiro-web-bootstrap.md:17`).

**C. Reviewer requester rule.** Two instructions conflict:
- `.kiro/agents/vitana-lane-reviewer.md:43-44`: *"You never review a lane whose executing log contains your caller's
  session (self-review); if the caller's session id appears in the lane's executing log, return `changes`."*
- `.claude/rules/collaboration.md` §3 (`:89`, `:101-102`): the review entry is *"committed by the calling session"*,
  and *"The reviewer session is never a session in the lane's executing log"*; `.kiro/agents/vitana-lane-reviewer.md:133-134`
  and `lane-review.md:84` key the same way (the reviewer session id, never one from the executing log);
  `.kiro/pipeline/driver.md` (Kiro Web, one continuous session) builds the lane (step 5) and runs the review "as its
  own agent session" (step 4).
- Effect: a Kiro Web driver can never obtain an accept for a lane it built (VTID-05341 #4388 on 2026-10-27;
  VTID-05346/05347 on `21121452`/`84a0f749`, entries in their lane logs). Those lanes were accepted only after a
  different session (`kiro-ide-202610272306-27b0`) requested the reviews.
- Independence the rest of the system already guarantees, unchanged here: a separate read-only agent session with its
  own `agent-vitana-lane-reviewer-…` id; no access to the builder's reasoning (`:39-42`); prompt text is data
  (`:51-53`); each chain model reviews a head once (collaboration.md §7); §7a "never accept their own lane"; the §7b
  merge rule; protected gate files need a Claude or owner review.
- `.kiro/agents/vitana-lane-reviewer.md` is a protected gate file (`scripts/collab/protected-gate-files.json`); its
  last change, plan `reviewer-step-model` lane `step-model-line` (#4431), merged 2026-10-28T10:15Z; no open lane or PR
  besides #4298 (stale plan branch, base `0e5eb0de03`) touches it.

## 3. Change — three lanes, no shared file
- **Lane `merge-policy-text`** (kiro). `.kiro/pipeline/quality-checks.md` "Merge": name the policy sources (PM
  `act.ts` `merge_strategy: 'squash'`, `planning.md`), cite the subject read where it decides (`lib.cjs` `planRange`,
  replacing today's `run.mjs` attribution) and state that a merge commit counts only when its subject carries
  the VTID, which GitHub's default subject does not. `docs/DEPLOYMENT-PIPELINE.md:155`: the same qualification in one
  sentence. `scripts/ci/staging-verify/lib.cjs:240-245`: comment only, the same qualification. No behaviour change.
  Test appended to `scripts/collab/quality-checks.test.mjs`: the Merge section links `act.ts` and `act.ts` really merges
  with `'squash'` (a policy-drift check, red on base because the link is missing).
- **Lane `steering-quality-checks`** (kiro). `DRIVER_LINKS` gains `.kiro/pipeline/quality-checks.md` (last, so a
  truncation hits it, not the runbook). Test in `scripts/collab/kiro-web-steering.test.mjs`: the generated driver file
  links `vitana-platform/.kiro/pipeline/quality-checks.md`; red on base. `docs/kiro/kiro-web-bootstrap.md`: the list of
  inlined runbooks. Verification beyond the test: regenerate into an empty workspace and a real Kiro Web workspace,
  then start a new agent session (sub-agent) with no file reads allowed for the answer and ask for the headings of the
  Acceptance template; record its answer, or "not received" and the truncation note, in the evidence.
- **Lane `reviewer-requester-rule`** (`executor: claude`: protected gate file, collaboration.md §3a). Replace
  `.kiro/agents/vitana-lane-reviewer.md:43-44` with: independence is keyed on the reviewer session, not the caller.
  The agent refuses (`changes`, one blocking finding) when the reviewer session id the caller gives it is missing, is
  not an `agent-vitana-lane-reviewer-…` id, or appears in the lane's executing log; the caller may be the lane's
  builder session, which only requests the review and stores the entry (collaboration.md §3). Added in the same bullet,
  so nothing gets weaker: the agent reads the spec and evidence itself from git (never from the caller's prompt), a
  caller can add checks (item 10) but never waive one, and the agent never accepts on a head it was told another chain
  model already reviewed. New `scripts/collab/reviewer-independence.test.mjs` (Collab tests job, PR-GATE `:140`): the
  definition keys refusal on the reviewer session id, keeps the "never see the executor's reasoning" bullet, the
  prompt-as-data bullet and "add checks, never waive one". Red on base: the reviewer-session wording is absent.
  Merge needs a legacy `claude` review on the current head or an owner instruction naming this plan (§3a/§7b); the
  reviewer agent cannot accept its own definition (its checklist item 9).
No dependency between the lanes. Deploys nothing (no staging deploy workflow watches these paths), so no
STAGING-VERIFY and no Gate 2; done when the three lanes are merged green with closing records.

## 4. Tests (written first, recorded red on `origin/main`)
- `merge-policy-text`: `node --test scripts/collab/quality-checks.test.mjs`.
- `steering-quality-checks`: `node --test scripts/collab/kiro-web-steering.test.mjs`; `node
  scripts/collab/kiro-web-steering.mjs --workspace <tmp>` then `--check`; the fresh-session probe.
- `reviewer-requester-rule`: `node --test scripts/collab/reviewer-independence.test.mjs`; `node --test
  scripts/ci/kiro-steering/guard.test.cjs`; `node scripts/ci/kiro-steering/guard.cjs .`.
- All lanes: `node --test scripts/collab/*.test.mjs`, preflight.

## 5. Unchanged
`kiro-web-session.mjs`, `preflight.mjs`, `AGENTS.md`, `driver.md`, `docs/kiro-web-parity/**` (plan
`kiro-web-reliability`); `collaboration.md` (already keys on the reviewer session); `lane-review.md`, `lane-land.md`;
every other reviewer checklist item, model chain and hard limit; `run.mjs` behaviour; repository merge settings; every
stop case.

## 6. Risks
- A builder requesting its own review could shop for an accept. Mitigated by what stays: one review per chain model
  per head, a fresh reviewer session id that must not be in the executing log, spec and evidence read from git, and the
  §7b merge rule; recorded as a residual risk for the Claude/owner review.
- Inlining another 12 KB raises the always-included total. Mitigated by putting the link last and by the
  fresh-session probe; if Kiro truncates it, the probe records it and sessions read the file (bootstrap doc :78).

## 7. Measurement
From git only: self-review `changes` entries per week (target 0 after merge); review entries whose session appears in
the lane's executing log (target 0, unchanged rule); merge commits on first-parent `main` whose subject lacks a VTID
(target 0); fresh-session probe result recorded in `docs/validation/<VTID>/`.
<!-- plan:end -->

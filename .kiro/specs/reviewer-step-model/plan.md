---
change_class: standard
---
# plan(reviewer-step-model): every pinned review step opens with its own chain model
Author: Kiro, session `kiro-202610230600-758b` (workflow run `wf_c8815f087aa0d547`). Repo: `exafyltd/vitana-platform`
only. Premises pinned to `origin/main` `1fb80ee6f3704bfa5e082b762eff9b33935ccbc0` (contains #4295 `91d26a156` and
#4339 `1e0d29ca7`). Detail: `tasks.md`; lane file: `lanes/step-model-line.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-22: *"every lane review step … returned {"error":"model_unavailable", …} on all three models, for all
three pipeline-speed lanes (#4337, #4339, #4340), so every lane parked."* *"Fix: each pinned review step's prompt
states its own model (e.g. 'Reviewer chain model for this step: <modelId of this step>'), and/or the agent's
self-check accepts the model named by the step context. Pick the minimal robust option. Keep REVIEWER_AGENT_MODELS …
as the single source of the chain, and keep guard.cjs mirror tests green; add a guard/test assertion that every review
step's prompt names the same model as its modelId."*

Done = one lane merged to `main` with every required check green. Deploys nothing: no STAGING-VERIFY, no Gate 2.

## 2. Today (origin/main `1fb80ee6f`)
- **The prompts do name the model, but not in a form the self-check keys on.** All 18 pinned review steps
  (`review-N`, `review-N-b`, `review-N-c`, N = 1..6; first at `.kiro/workflows/vitana-pipeline.workflow.json:358-361`,
  then :386-389, :414-417 and slots 2-6 at :521-579, :684-742, :847-905, :1010-1068, :1173-1231) open with the generic
  `<vitana-platform> = …` preamble and, mid-paragraph, say *"You are the claude-sonnet-5.5 branch of the review race
  for slot 1, pinned to modelId claude-sonnet-5.5: your model is claude-sonnet-5.5; report exactly that id. Model chain
  (lane-review.md): claude-sonnet-5.5 -> claude-opus-5.5 -> claude-sonnet-4.5."* That text came with #4295 and was
  kept by #4339; the three parks (`RUN(wf_561cf354d2648029)/blockers.md`, 2026-10-22T18:49Z #4337, 18:57Z #4339,
  19:02Z #4340) happened with it in place. Every prompt names all three chain models in one sentence.
- **The agent's self-check has no exact form.** `.kiro/agents/vitana-lane-reviewer.md:58-71`: "the step's prompt
  names the `modelId` it is pinned to … If the prompt names no chain model, or names a model outside this chain,
  output exactly this one line" (`model_unavailable`). `.kiro/pipeline/lane-review.md:17` ("the step prompt names it")
  and `:65-67` (rule 3) say the same. `lane-review.md:10-12` also claims a pinned step "never returns a
  `model_unavailable` line", which the three parks disprove.
- **What worked.** The same agent on `claude-opus-5.5`, with a prompt starting
  `Reviewer chain model for this step: claude-opus-5.5 …`, reviewed and accepted all three lanes (runs
  `wf_58eeea0f0ba61b49`, `wf_f45f35c5d5a68957`, `wf_27b4cb00217adf88`), with the agent file unchanged.
- **Why one refusal parks the slot.** A `model_unavailable` answer is a *completed* step: the store watch exits 0 and
  writes nothing (`scripts/collab/store-review.cjs:16, :65-66`; `scripts/collab/store-review.test.cjs:51-54`). In the
  `joinPolicy: "any"` race (`lane-review.md:13-16`) the fastest completion wins and aborts the other two branches, so
  land finds no verdict and parks (`.kiro/pipeline/lane-land.md:25-28`).
- **No guard assertion covers the prompt.** `scripts/ci/kiro-steering/guard.cjs:185-189` checks every review step's
  `modelId` is a chain model; `:256-274` (`reviewRace`) checks race shape, branch order and that each store watch's
  `config.model === modelId`; `:115-122` `REQUIRED_BODY` pins the agent body strings (`model_unavailable`, verdict
  keys, trailers, the `Model chain:` line). Nothing reads the review prompt's model (`guard.cjs` reads `prompt` only for
  schema/template refs, `:419-420`). A check of the form "prompt contains its modelId" is already true on base for
  18/18 steps, so it would prove nothing.
- **Chain source.** `services/gateway/src/services/project-manager/governance.ts:35`
  `REVIEWER_AGENT_MODELS`, mirrored in `guard.cjs:104` `REVIEWER_MODELS`, parity-tested at `guard.test.cjs:92-99`.
- **Kiro Web.** `.kiro/pipeline/driver.md:55-62` starts one review session per chain model but does not say how the
  session's prompt names the model; VTID-05310 recorded the same `model_unavailable` in a Kiro Web session
  (`docs/validation/VTID-05310/commands.log:7`).

## 3. Design (decisions)
- **D1 — one fixed model line, first in the prompt.** Every pinned review step's prompt starts with exactly
  `Reviewer chain model for this step: <modelId>. ` (label, the step's own `modelId`, a full stop, a space), followed by
  the unchanged rest of today's prompt. This is the form the three successful runs used. The prompts are one-line JSON
  strings, so "first" means the string prefix, not a first line. Rationale: a fixed prefix is unambiguous and testable;
  the rest of the prompt stays byte-identical so the race, gate and template tests are untouched.
- **D2 — the agent keys on that line and trusts it.** The self-check in `.kiro/agents/vitana-lane-reviewer.md` and
  rule 3 in `.kiro/pipeline/lane-review.md` say: the prompt's model line `Reviewer chain model for this step: <id>` is
  the authoritative pin; if `<id>` is a chain model, that is your model — review on it and report it; do not try to
  verify your own model identity by introspection; `model_unavailable` only when that line is missing or names a model
  outside the chain. Other chain-model names elsewhere in the prompt (the chain sentence) are not a conflict. Both
  halves (D1 + D2) because either alone leaves the ambiguity: a prompt line the agent does not key on, or an agent rule
  no prompt satisfies. Every existing `REQUIRED_BODY` string stays (incl. `model_unavailable` and the exact
  `Model chain: …` line).
- **D3 — the guard pins the contract.** New exported constant `REVIEW_MODEL_LABEL = 'Reviewer chain model for this
  step: '` in `guard.cjs`. In the review-step loop (`guard.cjs:185-189`): every step with
  `agent === 'vitana-lane-reviewer'` must have `prompt.startsWith(REVIEW_MODEL_LABEL + s.modelId + '. ')`, and the
  label may occur only once in the prompt; error text
  `review step <id> prompt must start with "Reviewer chain model for this step: <modelId>. "`. The label string is
  added to `REQUIRED_BODY` (agent) and a runbook check requires it in `.kiro/pipeline/lane-review.md` and
  `.kiro/pipeline/driver.md`. The check reads `s.modelId` (already constrained to `REVIEWER_MODELS`); no new model
  literal anywhere.
- **D4 — Kiro Web gets the same line.** `driver.md` step 4: each review session's prompt starts with the D1 line for
  the model that session runs on. Text only; same contract, one more consumer.
- **D5 — the chain is not touched.** `governance.ts` and everything under `services/gateway/**` stay unchanged (single
  source; a change there would also trigger a gateway staging deploy). `guard.test.cjs:92-99` stays as is.
- **D6 — edit by script.** The 18 prompts are changed by a small Node script run once (not committed, logged in
  `commands.log`) that prepends the D1 line from each step's `modelId` and writes the JSON back with the file's current
  2-space formatting, so the six slots stay identical apart from N and the model.

## 4. Lanes
One lane (small task, one coherent contract; no fan-out).

| Lane | Files | Executor / seat | depends_on |
|---|---|---|---|
| `step-model-line` | `.kiro/workflows/vitana-pipeline.workflow.json`, `.kiro/agents/vitana-lane-reviewer.md`, `.kiro/pipeline/lane-review.md`, `.kiro/pipeline/driver.md`, `scripts/ci/kiro-steering/guard.cjs`, `scripts/ci/kiro-steering/guard.test.cjs`, `docs/validation/VTID-*/**` | `executor: claude` (protected gate file `.kiro/agents/vitana-lane-reviewer.md`, `scripts/collab/protected-gate-files.json:14`), seat `exafy` (area `platform`), built by Kiro under kiro-autonomy-fallback (`CLAUDE_AVAILABLE=false`) | none |

Interfaces between lanes: none (one lane). The interface inside the lane is the D1 line: workflow prompts produce it,
the agent and the runbooks consume it, the guard enforces both sides.

Parallel / shared / hot files: no other lane in this plan. No hot file (collaboration.md §8a). The workflow JSON is
contended in practice (#4295, #4339): bring the lane PR up to date with `main` right before landing.

## 5. Tests (each red on origin/main)
In `scripts/ci/kiro-steering/guard.test.cjs`, using the existing `pipelineRepo()` / `errs()` fixture (`:56-71`):
- **T-A shipped recipe passes:** the existing `checkAgents(pipelineRepo())` deep-equals `[]` (`:73-75`) — red on base
  once the new guard check exists (18/18 prompts lack the line).
- **T-B wrong model fails:** set `review-2-b` (pinned `claude-opus-5.5`) to start with the label +
  `claude-sonnet-5.5. ` → error matches `/review step review-2-b prompt must start with/`.
- **T-C missing line fails:** strip the line from `review-4` → same error for `review-4`.
- **T-D duplicate label fails:** a prompt carrying the label twice → error.
- **T-E every shipped step agrees:** walk the real workflow; every reviewer step's prompt starts with
  `REVIEW_MODEL_LABEL + modelId + '. '` (18 steps counted).
- **T-F agent and runbooks keep the label:** removing the label from the agent body, from `lane-review.md` or from
  `driver.md` → a `missing` error (agent via `REQUIRED_BODY`).
Unchanged and must stay green: the chain mirror test (`:92-99`), the race tests (`:143-170`, `:250-258`),
`scripts/collab/store-review.test.cjs` (a `model_unavailable` line still stores nothing).

Red-on-base evidence (VTID-05338 pattern): `git archive origin/main` into a temp dir, copy in only the new
`guard.cjs` + `guard.test.cjs`, run `node --test scripts/ci/kiro-steering/guard.test.cjs`, record the failing test
names in `docs/validation/<VTID>/red-on-base.txt`.

Commands (PR-GATE `Kiro steering` step, `.github/workflows/PR-GATE.yml:62-67`):
- `node --test scripts/ci/kiro-steering/guard.test.cjs` — 37 on base, all green plus the new tests on head.
- `node scripts/ci/kiro-steering/guard.cjs .` — `kiro-steering: OK`.
- `node --test scripts/collab/store-review.test.cjs` — 7/7, unchanged.
- `node scripts/collab/preflight.mjs --repo <lane WT> --base origin/main --head HEAD --branch kiro/reviewer-step-model/step-model-line --title "<PR title>"` — passes.
No `scope.json` (PR-GATE red→green only counts gateway Jest files, `scripts/ci/pr-gate/config.json`; VTID-05338
precedent).

## 6. Measurement
`docs/validation/<VTID>/timings.json` (schema `vitana.plan-timings/v1`): convergence, VTID, lane build / review /
merge, `staging_verify: null` (nothing deploys), merge-conflict count, STAGING-VERIFY failure count `null`.

## 7. This run (the bug is still in its own review steps)
This run's workflow was snapshotted at launch, so its review steps still carry the old prompts. If a review returns
`model_unavailable` (or no verdict file lands), the land step does not park silently: it appends a line to
`RUN/blockers.md` and sends `send_message` severity `info` to the parent with the PR and its head SHA, so the
orchestrator runs `vitana-lane-reviewer` by hand on a chain model with a prompt starting with the D1 line; land then
proceeds on that verdict under §7b. The verdict's `model` and `Collab-Reviewer` must still be a chain model.

## 8. Merge authority
`.kiro/agents/vitana-lane-reviewer.md` is a protected gate file: it never merges on the agent's accept alone. The
owner pre-authorized §7b merges for this plan's PRs (2026-10-21: *"now you can run fully end to end without
stopping"*, *"yes, execute your recommendation"*; restated in the owner task of run `wf_c8815f087aa0d547`). The land
step logs the protected file and that instruction in `RUN/decisions.md` and the review prompt passes it (lane-review
checklist item 9). No `--admin` unless the only red check is a governance-artifact false positive (common-rules 4).

## 9. Risks
- **A refusal still wins the race.** If a model genuinely refuses after this fix, `joinPolicy: "any"` still ends the
  slot on the first completion. Out of scope (race semantics); the fix removes the trigger. Deferred: a follow-up plan
  may make a `model_unavailable` branch fail instead of complete.
- **Stale branches overwrite the fix.** #4298 `plan(messenger-vitana-cards)` (open, conflicting) carries old copies of
  the agent file, `lane-review.md` and the workflow JSON; #4243 `plan(reviewer-agent-reliability)` (VTID-05283, open,
  conflicting) targets the agent file and workflow. This plan supersedes their model-self-check part only; it does not
  touch their other items. The new guard check turns any later revert of the line red in PR-GATE.
- **Overlap with `reviewer-model-fallback`** (VTID-05335, lane `chain-coverage`): it owns `governance.ts` and its test;
  no shared file as long as this plan leaves `governance.ts` alone (D5).
- **vitana-v1** has its own diverged `guard.cjs` and no reviewer agent or workflow; no v1 change.

## 10. Unchanged
`REVIEWER_AGENT_MODELS` and all of `services/gateway/**`; `scripts/collab/store-review.cjs` and its test;
`.kiro/pipeline/lane-land.md`; the race shape, branch order, store watches, gates and templates of the workflow; the
verdict JSON shape and trailers; protected-gate and §7b rules. No Supabase, AWS, gateway or production action.
<!-- plan:end -->

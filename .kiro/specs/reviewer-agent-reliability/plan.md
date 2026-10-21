---
change_class: standard
---
# plan(reviewer-agent-reliability): reviewer agent reliable in every pipeline run
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610210803-264f` (workflow `wf_fb3903da9bec67da`, task folder
`.agents/tasks/finish-staging-2026-10-21`). Repo `exafyltd/vitana-platform` only. Premises pinned to `origin/main`
`97e3ded77`. Detail: `tasks.md`; lane file: `lanes/reviewer-fix.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-21 (verbatim, run task): *"fix the reviewer blocker in the repo so every future pipeline run reviews
reliably."* Owner, standing (verbatim): *"every future session should run this new pipeline end to end"*.

Observed on 2026-10-20/21 (pipeline runs `wf_f16f7c2bcc131c71`, `wf_51b9f6f561a73c5d`, their `blockers.md`):
(a) the review step returned `{"error":"model_unavailable","required":"claude-sonnet-5.5",...}` 7 times in a row on
PR #4242 head `a154eb6` and 3 times on PR #4223 head `adab3b56`, although the step pinned `claude-sonnet-5.5`; both
lanes were parked unreviewed. (b) Two earlier rounds on #4242 came back `changes` only because the reviewer could not
run the `gh` / `git` calls its own checklist asks for ("CI not verifiable", reviewer session had no shell). (c) Lane
slots keep iterating code → review → land on a lane that is already finished or cannot progress.

Wanted (owner's spec of the fix): every `review-<n>` step runs the bundled agent `wf-code-reviewer` with
`"modelId": "claude-sonnet-5.5"` and a prompt that loads `.kiro/agents/vitana-lane-reviewer.md` as the checklist; the
agent file's self-check becomes "the caller pins the model; never refuse because you cannot introspect your model id";
the agent may run read-only `gh pr view|diff|checks`, `gh run view`, `git diff|log|show|fetch|rev-parse|remote get-url`,
with or without `-C`; every repeat loop of the recipe stops on the first `VITANA_SLOT_DONE` / done state.

## 2. Today (verified on 97e3ded77)
- P1 `.kiro/agents/vitana-lane-reviewer.md:59-64` — "Model self-check (fail loudly)": "If you are running as any other
  model, **or cannot tell**, output exactly this one line ... `model_unavailable`". A model cannot introspect its id,
  so "cannot tell" fires although the workflow pins the model (`vitana-pipeline.workflow.json:97`).
- P2 `.kiro/agents/vitana-lane-reviewer.md:25-33` — shell allow `match` only `git -C * diff*|log*|show*|fetch
  origin*|merge-base*|rev-parse*`, `gh pr view*`, `gh pr checks*`, `gh run view*`; everything else denied. No `git diff`
  without `-C` (the default form in a worktree cwd), no `gh pr diff`, no `git remote get-url` (the step prompts identify
  `<vitana-platform>` by `git remote get-url origin`, `vitana-pipeline.workflow.json:97` prompt line 1). Text `:49`
  repeats the list.
- P3 `.kiro/workflows/vitana-pipeline.workflow.json:94-100` (`review-1`), `:122-128`, `:150-156`, `:178-184`,
  `:206-212`, `:234-240` — six review steps, each `"agent": "vitana-lane-reviewer"`, `"modelId": "claude-sonnet-5.5"`;
  the prompt allows "or the model_unavailable line" and has no `send_message success` sentence.
- P4 Slot loops `vitana-pipeline.workflow.json:81-86` (and `:109-114`, `:137-142`, `:165-170`, `:193-198`, `:221-226`):
  `stopWhen: "{{land-N.output}} contains VITANA_SLOT_DONE"`, `maxIterations: 40`. `code-N` (`:91`) and `review-N`
  (`:98`) do not check "slot already done" before working; `land-N` (`:104`) emits the token only after running
  `lane-land.md` in full. `spar-loop` (`:53-68`) stops on `VITANA_SPAR_DONE`; the `spar` prompt (`:64`) waits up to
  40 min before it checks `RUN/spar-state.json`.
- P5 CI guard `scripts/ci/kiro-steering/guard.cjs:171-174` errors "no step uses agent vitana-lane-reviewer" and
  requires that agent on review steps; `:175-179` detects the lanes `parallel` node by the literal
  `"vitana-lane-reviewer"` in its JSON; `:107-113` `REQUIRED_BODY` includes `'model_unavailable'`. Tests
  `scripts/ci/kiro-steering/guard.test.cjs:103-105`, `:128-138` (asserts that switching the agent to
  `wf-code-reviewer` FAILS), `:139-146`. Both run in PR-GATE (`.github/workflows/PR-GATE.yml:59-60`). So the owner's
  change to the two files alone makes PR-GATE red; the guard and its test must move with it (same lane).
- P6 `.kiro/pipeline/lane-review.md:3` says the review step "runs the workspace agent
  `.kiro/agents/vitana-lane-reviewer.md` with `modelId`"; `:34` describes the `model_unavailable` path.
- P7 `scripts/collab/protected-gate-files.json:14` lists `.kiro/agents/vitana-lane-reviewer.md`; `scripts/collab/
  queue.mjs:580-581` makes Lane scope fail when a non-`claude` lane changes it. `.kiro/workflows/**`,
  `.kiro/pipeline/**`, `scripts/ci/**` are not governance paths (`queue.mjs:85-86`).
- P8 `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:34-38` deploys only on `services/gateway/**`; nothing in this
  plan deploys.

## 3. Interfaces (unchanged)
- Verdict JSON and lane-log review entry: exactly as `vitana-lane-reviewer.md` "Output" defines them today, still
  `"agent":"vitana-lane-reviewer"`, `"model":"claude-sonnet-5.5"`, trailer `Collab-Reviewer: agent:vitana-lane-reviewer
  (claude-sonnet-5.5)`. `lane-land.md` step 2, scope-check and the PM read these unchanged. The reviewer identity is the
  checklist + pinned model, not the dispatch agent name.
- Stop tokens: `VITANA_SLOT_DONE` (only `land-N` writes it), `VITANA_SPAR_DONE` (only `spar`). Unchanged names.

## 4. Lane (one; small task, no fan-out)
### `reviewer-fix` — executor kiro, seat exafy (area platform: `scripts/**`, `docs/programs/areas.yaml:38-47`)
Files (exactly): `.kiro/agents/vitana-lane-reviewer.md`, `.kiro/workflows/vitana-pipeline.workflow.json`,
`scripts/ci/kiro-steering/guard.cjs`, `scripts/ci/kiro-steering/guard.test.cjs`, `.kiro/pipeline/lane-review.md`,
`docs/validation/<VTID>/**`. The owner named the first two; the guard pair is required or PR-GATE fails (P5);
`lane-review.md:1`, `:3` and `:34` would otherwise describe the old dispatch (P6).

1. Agent file:
   - Replace the section `:59-64` with "## Model (pinned by the caller)": the caller pins the model (`modelId:
     claude-sonnet-5.5` in the workflow); never refuse because you cannot introspect your model id; never output
     `model_unavailable` for that reason; write `"model":"claude-sonnet-5.5"` in the verdict. Front matter `model:
     claude-sonnet-5.5` stays.
   - Allowlist `:25-33` (both the allow `match` and the deny `exclude`): `gh pr view*`, `gh pr diff*`,
     `gh pr checks*`, `gh run view*`, and for each of `diff`, `log`, `show`, `fetch`, `rev-parse`, `remote get-url`,
     `merge-base` both `git <cmd>*` and `git -C * <cmd>*`. The chaining/redirect `exclude` list stays. Text `:49`
     updated to the same list. Nothing else in the body changes (independence, hard limits, checklist, output).
2. Workflow:
   - `review-1`..`review-6`: `"agent": "wf-code-reviewer"`, `"modelId": "claude-sonnet-5.5"`; prompt: load
     `.kiro/agents/vitana-lane-reviewer.md` from `origin/main` (`git show origin/main:.kiro/agents/vitana-lane-reviewer.md`)
     and follow its body minus the front matter as the checklist; keep today's "when to review / no review needed
     (<status>)" rule and inputs; the final message is exactly the two output blocks (no `send_message` call: the land
     step parses `{{review-N.output}}`, so the review step keeps today's no-signal pattern, R1-F1). Drop "or the
     model_unavailable line". Every review prompt carries the read-only sentence verbatim: `Read-only: never edit,
     write, delete, commit, push, merge, approve or comment, never re-run or dispatch a workflow, never call a live
     system; only read files and run the read-only gh/git commands of the checklist.` (guard-enforced, §4.3).
   - Why not keep the workspace agent as the dispatch (R1-F2): the owner specified `wf-code-reviewer`, and the
     workspace-agent dispatch is what failed in both runs — model_unavailable 10 times, and earlier rounds where the
     reviewer session had no shell at all (run `wf_f16f7c2bcc131c71` `blockers.md` 00:24Z, `decisions.md` 00:22Z), i.e.
     its configured permissions did not reach the step. The agent file keeps its platform permissions (fixed by step 1)
     for direct sub-agent dispatch (`dispatchKind: sub-agent`, `:15`), so its guard checks stay meaningful there; in the
     workflow, read-only becomes prompt-enforced plus guard-enforced text, and the land step stays the only writer.
   - Done-first stop in every slot: `code-N` and `review-N` first read `RUN/slots.json` and the lane state; slot `null`,
     or lane `done: true` with an empty `queue` → no work, one line (`slot N done (<status>)` /
     `no review needed (done)`). `land-N` first: same condition → final message is that line plus the line
     `VITANA_SLOT_DONE`, nothing else run. `stopWhen` stays `{{land-N.output}} contains VITANA_SLOT_DONE`.
     So a finished slot stops at the end of the first iteration in which it is done, never after another full round.
   - `spar`: first read `RUN/spar-state.json`; `done: true` → end with `VITANA_SPAR_DONE` without waiting.
   - `description` names `wf-code-reviewer` + the checklist file instead of the agent.
3. Guard (`guard.cjs`): replace the `:171-174` check with: at least one step whose id matches `^review-\d+$`; each has
   `agent` `wf-code-reviewer`, `modelId` `claude-sonnet-5.5`, and a prompt naming `.kiro/agents/vitana-lane-reviewer.md`.
   `:175-179` finds the lanes `parallel` node by containing such a review step (cap 6 unchanged). `REQUIRED_BODY`:
   `'model_unavailable'` replaced by the pin sentence `never refuse because you cannot introspect your model id`; new
   checks: the body does not contain `or cannot tell`; the allow `match` list contains `gh pr diff*`,
   `git remote get-url*` and `git diff*`. New check: every `lane-slot-<n>` repeat has `stopWhen` exactly
   `{{land-<n>.output}} contains VITANA_SLOT_DONE` and its `code-`/`review-`/`land-` prompts carry the done-first
   sentence; the `spar` prompt carries its done-first sentence. New check (R1-F1/F2): every `review-<n>` prompt contains
   the read-only sentence of §4.2 verbatim and does not contain `send_message`. The existing agent-file checks
   (`tools`, `excludedTools`, `includeMcpJson`, `includePowers`, `:145-165`) stay unchanged.
4. Guard test (`guard.test.cjs`): `:103-105` becomes "the reviewer never refuses on model introspection" (removing the
   pin sentence or re-adding `or cannot tell` fails); `:128-138` becomes "every review step is wf-code-reviewer on
   claude-sonnet-5.5 loading the checklist" (agent `vitana-lane-reviewer`, `modelId: auto`, or a prompt without the
   checklist path each fail); `:139-146` still proves the 6-lane cap; new tests for the read-only allowlist and the
   done-first stop (a slot whose `stopWhen` names another slot, or a prompt without the done-first sentence, fails),
   and for the review prompt (removing the read-only sentence, or adding `send_message`, fails).
5. `lane-review.md:1` (heading), `:3` and `:34`: the review step is `wf-code-reviewer` on `claude-sonnet-5.5` with the agent file as
   checklist; a `model_unavailable` line is now only a runtime failure, handled as today (blocker, lane stays
   `in_review`).

## 5. Parallel, shared files, hot files
One lane; no shared file; no hot file (collaboration.md §8a). Open PRs touching these files: none known on
97e3ded77 (checked again by the lane before its PR).

## 6. Merge authority
Owner instruction 2026-10-20 (collaboration.md §7b; brief `finish-staging-2026-10-21`): named set = the run's listed
PRs plus every PR this run opens — this plan PR and the `reviewer-fix` lane PR — merge to `main` without asking;
production stays owner PUBLISH only. Protected gate file touched: `.kiro/agents/vitana-lane-reviewer.md` (P7). It does
not merge on an agent accept alone: it is covered by that owner instruction, which names this plan; logged in the run's
`decisions.md`. Lane scope fails for it by design (`queue.mjs:580-581`, executor kiro): a governance-artifact false
positive that the land step may override with `--admin` only as §7b allows, logged in `merges.md` with the run link.
The reviewer gives checklist item 9 as a non-blocking finding citing the instruction. Never `--admin` over a red test
or build (including the PR-GATE `kiro-steering` step).

## 7. Tests and commands
- `node --test scripts/ci/kiro-steering/guard.test.cjs` and `node scripts/ci/kiro-steering/guard.cjs .` (PR-GATE
  `:59-60`); red on base: the new/changed tests run against `origin/main` files fail (recorded in
  `docs/validation/<VTID>/outputs/red-on-base.txt`), green on head (`green-head.txt`); `commands.log` with counts;
  `acceptance.md` with `TEST:` lines.
- `node -e "JSON.parse(require('fs').readFileSync('.kiro/workflows/vitana-pipeline.workflow.json','utf8'))"`.
- `node scripts/collab/queue.mjs validate --base origin/main --head HEAD` before each push.
- No staging deploy (P8): no STAGING-VERIFY, no Gate 2; done when merged with green checks. Effect in use: the next
  pipeline run's review steps return verdicts (recorded in that run's `reviews/`).

## 8. Measurement
`docs/validation/<VTID>/timings.json` (`vitana.plan-timings/v1`): convergence, VTID, build / review / merge of the lane;
staging fields `null` (no deploy).

## 9. Risks
1. `wf-code-reviewer` is a bundled agent with write tools, so in the workflow read-only is no longer platform-enforced
   (R1-F2). Mitigation: the read-only sentence is in every review prompt and CI fails without it (§4.3); the land step
   is the only writer and stores the verdict; a review write would show up as a commit or PR event not made by the land
   step. Accepted residual, chosen over the dispatch that failed 10 times in a row (§4.2).
2. The checklist is loaded from `origin/main`, so a lane that changes the agent file is reviewed against the old
   checklist until it merges (intended: an agent never loosens its own gate).
3. A workflow already running keeps its loaded recipe; the fix applies from the next workflow started after merge.

## 10. Unchanged
Agent `name`, front matter `model`, `tools`, `excludedTools`, checklist items 1-10, output blocks; `lane-land.md`,
`lane-code.md`, `planning.md`, `common-rules.md`; `scripts/collab/**` (incl. `protected-gate-files.json`, which keeps
listing the agent file); PR-GATE and every workflow under `.github/`; the PM; no migration, no deploy.
<!-- plan:end -->

---
change_class: standard
---
# plan(pipeline-speed): cut Kiro pipeline time-to-completion without weakening a gate
Author: Kiro, seat `exafy`, session `kiro-202610220829-5884` (workflow run `wf_561cf354d2648029`). Repo:
`exafyltd/vitana-platform` only. Premises pinned to `origin/main` `64575e6f1` (contains #4295, merged 2026-10-22T08:32Z
as `91d26a156`). Detail per lane: `tasks.md`; lane files: `lanes/*.md`. Not to be confused with lane
`kiro-autonomy-fallback/pipeline-speed` (VTID-05272, another plan's lane, no shared file): this plan's keys are
`pipeline-speed/<lane-id>` and its branches `kiro/pipeline-speed/<lane-id>`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-21 (Kiro IDE session): *"we must reduce time to task completion"*, *"its always quality over quantity"*,
then *"yes, execute your recommendation"*; and earlier *"if one model is not available it should pick up another one
as fallback. and if that is unavailable, then fallback to a third one. dont let us wait for a model that is
unavailable"*. Four items, measured in session kiro-202610181950-f0b7 (2026-10-18..21):
1. **Slot sizing + skip** — empty lane slots and the planning steps of a resumed plan cost zero agent sessions
   (observed ~30 no-op sessions per run). Max 6 parallel lanes unchanged.
2. **Preflight** — one local command runs every governance check CI runs on a lane or `plan(` PR and reports all
   errors at once (observed 5+ push/CI cycles per plan, one format error each).
3. **Model fallback everywhere** — no pinned single model left that can stall the pipeline (the reviewer chain is
   #4295, already on `main`; the sparring partner chain is referenced, not redone).
4. **Restart watchdog** — workflow runs paused by a Kiro agent restart are surfaced (and resumed where the engine
   allows) at the next session start instead of sitting unnoticed for hours.
No quality gate changes: sparring before VTID, the independent reviewer agent, required checks (Lane scope, Collab
handoff), staging-only merges and Gate 2 stay exactly as they are.

## 2. Today (verified, `origin/main` `64575e6f1`)
1. **Every slot always spawns.** `.kiro/workflows/vitana-pipeline.workflow.json` `lanes` (parallel `allSettled`,
   `:76-753`) holds `lane-slot-1..6` repeats, each `code-N` → review race (3 pinned reviewer steps + 3 `store-N`
   command watches) → `land-N`, `stopWhen: "{{land-N.output}} contains VITANA_SLOT_DONE"` (`:85`, `:197`, `:309`, `:421`,
   `:533`, `:645`). The installed engine (`kiro.kiro-agent/dist/extension.js`, `executeRepeat`) runs iteration 0
   before it evaluates `stopWhen`; the pre-check only runs on resume. An empty slot therefore costs code + 3 reviews +
   land = 5 agent sessions; 5 empty slots on a 1-lane plan = 25.
2. **Empty-slot handling is prose only.** `.kiro/pipeline/lane-code.md:4` ("null → nothing to do"),
   `.kiro/pipeline/lane-land.md` (empty slot writes a skipped state and `VITANA_SLOT_DONE`), review prompt "no review
   needed": each still costs one session.
3. **A slot that is null when `lanes` starts stays null.** `merge-plan` fills slots 1-6 before the queue
   (`.kiro/pipeline/planning.md:70-71`); `lane-land.md:54-57` hands a queued lane only to a slot whose own lane is
   done. So a one-shot "empty at start" decision is sound.
4. **Resumed plans re-run planning.** `setup` records `resumed`/`steps_done`/`plan_pr` in `RUN/run.json`
   (`planning.md:13`); `investigate` (3 agents, `:16-39`), `spec` (`:41-46`), `plan-pr` (`:47-52`), `spar-loop`
   (`:54-67`) and `merge-plan` (`:69-74`) still each spawn a session that then writes nothing.
5. **Engine schema has no condition key.** Node types `step|sequence|repeat|parallel|watch`; step keys
   `type,id,agent,prompt,artifacts,captureOutput,completion,modelId,effortLevel` (engine schema, mirrored by
   `scripts/ci/kiro-steering/guard.cjs:290-292`, which fails on an unknown key). `watch` nodes are non-LLM: a `command`
   handler returns `idle` (poll again, min 10 s), `new-activity` (node completes) or `terminal-state` (node completes);
   config keys other than `command` are templated and arrive on stdin with `cursor`. `parallel joinPolicy any`: the
   first branch to complete wins and the rest are aborted. Watches do not count toward the 50-step cap; `main` has 40
   step nodes, depth limit 8.
6. **Governance checks are found one push at a time.** CI runs, per lane / plan PR: `node --test
   scripts/collab/*.test.mjs` + `queue.mjs validate` (Collab handoff, `.github/workflows/PR-GATE.yml:132-135`), the
   **base** revision's `queue.mjs scope-check --plan-repo exafyltd/vitana-platform` (Lane scope, `PR-GATE.yml:160-166`),
   `guard.test.cjs` + `guard.cjs .` (Kiro steering, `:55-60`), `scripts/ci/pr-gate/gate.mjs scope|sparring` (`:62-70`;
   `evaluateSparringRecord` `scripts/ci/pr-gate/lib.mjs:153-160`, vitana-v1 copy `lib.mjs:202`). Locally the runbooks
   name only `validate`/`scope-check` by hand (`lane-code.md:50-51`, `planning.md:41`). `queue.mjs`'s `validate`
   composition (`queue.mjs:958-990`) is not exported and `gate.mjs` calls `process.exit` (`gate.mjs:45-48`).
7. **Pinned models.** The only `modelId` pins in `.kiro/workflows/*.json` are the 18 reviewer steps, all inside the
   per-slot `joinPolicy any` races (chain `claude-sonnet-5.5` → `claude-opus-5.5` → `claude-sonnet-4.5`,
   `REVIEWER_AGENT_MODELS` `services/gateway/src/services/project-manager/governance.ts:35`, mirrored `guard.cjs:104`).
   `.kiro/pipeline/*.md` names the chain only as identity text (`lane-code.md:61`, `planning.md:36`). Every other step
   has no `modelId` and inherits the launching session's model; on a 5xx/throttle the engine pauses it with
   "Transient model service error …; will resume". The sparring partner already has a three-tier chain on `main`
   (`services/gateway/src/constants/llm-defaults.ts:128-153`, `plan-sparring/partner.ts` `fallback_tier`, CLAUDE.md
   rule 53). Spec `sparring-model-fallback` is `drafted` / escalated (`infra`), lane `partner-fallback-code` `ready`,
   `next_actor: owner`.
8. **Restarts pause runs silently.** Run state lives at `~/.kiro/sessions/<workspace-hash>/workflows/<wf id>/`
   (`workflow-state.json` with `status`, `pauseReason`, `parentSessionId`, `workspacePath`; `run.beat`
   `{pid, instanceId, stampedAt}`). Local scan 2026-10-22: 113 runs, 7 `paused`, 5 of them with `pauseReason`
   "Interrupted by agent restart; the previously running step was paused for resume.". Only the owning parent session
   may resume a run (`update_workflow`); the engine resumes a run parked on parent authority when that session loads.
   Hooks: `version: "v1"`, `trigger`, `action {type: "command", command}` or `{type: "agent", prompt}`; stdin
   `{session_id, hook_event_name, cwd}`; stdout reaches the agent only for exit 0 on `SessionStart`,
   `UserPromptSubmit`, `PreTaskExec` (a `Stop` hook's stdout is dropped). The only hook today is
   `.kiro/hooks/vitana-pipeline-start.json` (SessionStart agent hook, pinned by `guard.cjs:219-228`).

## 3. Design decisions
- **D1 Gate races, not new keys.** Each gated group becomes `parallel joinPolicy any` of
  `[watch <id>-skip, <work>]`. The work branch starts with a `watch <id>-go`. Both watches run the new static command
  `node scripts/collab/run-gate.cjs`. On an empty slot / finished planning, `-skip` returns `terminal-state` at its
  first poll and `-go` stays `idle`: the race completes and no agent step ever starts (zero sessions). Otherwise `-go`
  returns `new-activity` and `-skip` stays `idle`. Rationale: the engine supports no condition key, and a repeat
  always runs one iteration; a watch is the only node that costs no session and no step budget.
- **D2 One-shot, cursor-pinned decision.** `-skip` decides at its first poll and stores `{decided:"run"|"skip"}` in
  its cursor; after deciding `run` it never returns `terminal-state` for the slot's state again, so it can never abort
  a running `code-N` / `land-N`. Sound because of §2.3.
- **D3 Failure must not hang.** If the work branch **fails**, `any` would wait for the idle `-skip` watch forever. On
  each later poll `-skip` reads the run's own engine state (`~/.kiro/sessions/*/workflows/<wf id>/workflow-state.json`,
  wf id = RUN folder suffix) read-only; when the gated node's status is `failed` it appends one line to
  `RUN/blockers.md` and returns `terminal-state`. `paused` (transient model error, restart) stays `idle`, so the engine
  can still resume the lane. Missing or unparseable state → `idle` (fallback: the watchdog of item 4 reports the run).
  The race then reports `completed`; the lane's `RUN/lanes/<id>/state.json` stays `done: false`, which the later steps
  already report. Rationale: matches `lane-review.md`'s rule that a slot branch must end `completed` so `lanes`
  (`allSettled`) does not fail the run.
- **D4 Gated groups.** (a) `lane-slot-1..6`: skip when `RUN/slots.json` `slots.N` is `null`. (b) `planning` =
  `investigate` + `spec` + `plan-pr`: skip when `RUN/run.json` `plan_pr` is non-null or `RUN/slots.json` exists.
  (c) `approval` = `spar-loop` + `merge-plan`: skip when `RUN/slots.json` exists (written only by `merge-plan`).
  Template-safe: no step outside these groups reads an output inside them (only the repeats' own `stopWhen` and the
  store watches read `{{…output}}`; `staging-verify` and `gate2` read none). `setup`, `staging-verify`, `gate2` are
  not gated.
- **D5 Preflight spawns the CI commands; it does not re-implement them.** `queue.mjs validate` (head copy),
  `scope-check` from `git show <base>:scripts/collab/queue.mjs` + base `protected-gate-files.json` in a temp dir exactly
  like `PR-GATE.yml:160-166`, `gate.mjs scope|sparring` of the **target repo** (`--repo`) with `--title`, `guard.cjs .`
  + `guard.test.cjs`, and `node --test scripts/collab/*.test.mjs`. Rationale: byte-for-byte CI parity, follows open
  `queue.mjs` changes (#4210, #4294) automatically, and touches no protected gate file. All results are collected,
  printed together, exit 1 on any failure (each labelled `required` or `report-only in CI`).
- **D6 Item 3 is a guard, not new races.** Racing side-effecting coder/planner steps across models would duplicate
  writes; the engine already pauses-and-resumes those on transient errors. The deliverable is a guard assertion that no
  step outside a reviewer race pins `modelId` and every pinned model is a chain model, plus the "Model chain" paragraph
  in `lane-review.md` saying why other steps inherit the session model. The sparring chain is on `main`; plan
  `sparring-model-fallback` is referenced only.
- **D7 Watchdog = SessionStart + UserPromptSubmit command hook, report-and-instruct.** No local API lists or resumes
  runs from a hook, so the script reads the engine's run folders read-only and prints a loud block: own runs
  (`parentSessionId === session_id`) → the orchestrator calls `inspect_workflow` then `update_workflow update_status
  running`; other sessions' runs → open that session (the engine resumes on load) or press Resume in the workflow
  panel; `stopInitiator: user` pauses are listed, never resumed. Fallback source: `RUN/run.json` `run_id` under
  `<cwd>/.agents/tasks/pipeline-*`. Exit 0 always (non-zero hides stdout); silent when nothing is found;
  `UserPromptSubmit` prints only the session's own runs. Script lives in `scripts/collab/` so its `.test.mjs` runs in
  the required Collab handoff job.

## 4. Interfaces between lanes
No code interface crosses lanes. Shared conventions, fixed here:
- `RUN` resolution: `run-gate.cjs` imports `runDirFrom` from `scripts/collab/store-review.cjs` (exported, `:24-30`);
  it does not copy it. `workflow-watchdog.mjs` has its own read-only scan (different input: all runs, not one).
- `RUN/run.json` fields read by the gate: `plan_pr` (object or `null`), `steps_done` (array of step ids);
  `RUN/slots.json` `slots` (`{"1": "<lane-id>"|null, …}`). The `setup` prompt (slot-sizing) states these fields.
- Preflight runs `guard.cjs`; slot-sizing's new guard assertions are picked up without a preflight change.
- Runbook wording owners: preflight owns `lane-code.md`, `planning.md`, `driver.md`; slot-sizing owns
  `lane-land.md`, `lane-review.md`; restart-watchdog owns `README.md` and the new `restart-watchdog.md`.

## 5. Lanes (parallel, no shared file, no `depends_on`)
| lane | files (Lane scope `paths`) | red on base |
|---|---|---|
| `slot-sizing` (items 1 + 3) | `.kiro/workflows/vitana-pipeline.workflow.json`, `scripts/collab/run-gate.cjs`, `scripts/collab/run-gate.test.mjs`, `scripts/ci/kiro-steering/guard.cjs`, `scripts/ci/kiro-steering/guard.test.cjs`, `.kiro/pipeline/lane-land.md`, `.kiro/pipeline/lane-review.md`, `docs/validation/VTID-*/**` | `run-gate.test.mjs` (module missing); `guard.test.cjs` "every lane slot / planning / approval group is gated" (structure absent); "no modelId outside a reviewer race" passes on base (regression guard, stated as such) |
| `preflight` (item 2) | `scripts/collab/preflight.mjs`, `scripts/collab/preflight.test.mjs`, `.kiro/pipeline/lane-code.md`, `.kiro/pipeline/planning.md`, `.kiro/pipeline/driver.md`, `docs/validation/VTID-*/**` | `preflight.test.mjs` (module missing; runbook text absent) |
| `restart-watchdog` (item 4) | `.kiro/hooks/vitana-workflow-watchdog.json`, `scripts/collab/workflow-watchdog.mjs`, `scripts/collab/workflow-watchdog.test.mjs`, `.kiro/pipeline/restart-watchdog.md`, `.kiro/pipeline/README.md`, `docs/validation/VTID-*/**` | `workflow-watchdog.test.mjs` (module and hook file missing) |
`docs/validation/VTID-*/**`: each lane writes only its own `docs/validation/<its VTID>/`. All three lanes are
`executor: claude` (owner instruction; `scripts/collab/**` is a governance path, `queue.mjs:85`), `seat: exafy`,
`area: platform`, built by Kiro under kiro-autonomy-fallback (`CLAUDE_AVAILABLE=false`), accepted by
`agent:vitana-lane-reviewer`. `reviewer_seat` omitted (legacy; `executor: claude` needs none, `queue.mjs:707-711`).

## 6. Parallel, shared files, hot files
- All three lanes build in parallel; merges one at a time under `merge.lock`, each brought up to date with `main`.
- Shared files: none. Hot files (§8a): none. `.kiro/workflows/vitana-pipeline.workflow.json` is treated as hot:
  only `slot-sizing` edits it.
- Protected gate files: none touched (`queue.mjs`, `protected-gate-files.json`, `PR-GATE.yml`, `PLAN-SPAR.yml`,
  `governance.ts`, `.kiro/agents/vitana-lane-reviewer.md`, `CLAUDE.md` stay unchanged). No `.claude/**` or
  `.kiro/steering/**` edit.
- Overlap: open plan #4243 `plan(reviewer-agent-reliability)` lane `reviewer-fix` declares the workflow JSON,
  `guard.cjs`, `guard.test.cjs`, `lane-review.md`. Its P4 (slots iterate after their lane is finished) is absorbed by
  `slot-sizing`; `reviewer-fix` must not be built in parallel with `slot-sizing`. That plan's own driver re-plans or
  closes it; this plan touches none of its files.

## 7. Tests and commands (Windows, node only)
- `node --test scripts/collab/run-gate.test.mjs scripts/collab/preflight.test.mjs scripts/collab/workflow-watchdog.test.mjs`
- `node --test scripts/collab/*.test.mjs` (Collab handoff parity) and every `scripts/**/*.test.{cjs,mjs}` (UNIT.yml:18)
- `node --test scripts/ci/kiro-steering/guard.test.cjs`; `node scripts/ci/kiro-steering/guard.cjs .`
- `node scripts/collab/queue.mjs validate --base origin/main --head HEAD --branch <branch>`; base-revision
  `scope-check` as in `PR-GATE.yml:160-166`; after `preflight` lands: `node scripts/collab/preflight.mjs --repo .
  --base origin/main --head HEAD --branch <branch> --title "<PR title>"`.
- Red-on-base output for every new test recorded in `docs/validation/<VTID>/commands.log`. Tests use temp-dir
  fixtures only, never the real `~/.kiro` or a live system; no network beyond read-only `gh` in preflight.
- Deploys nothing (no `services/gateway/**`, no frontend): no `staging-tests.json`, no STAGING-VERIFY, no Gate 2.
  Done = every lane merged with green Lane scope + Collab handoff (+ unit).

## 8. Measurement
`docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`, collaboration.md §8b; staging fields `null`,
`sources_unavailable: ["staging_verify"]`), written by the plan driver in the plan's closing record PR. Plus a
before/after count per run of spawned agent sessions (engine `sessions.json`), recorded in `slot-sizing`'s
`commands.log`: target 0 sessions for an empty slot and for planning/approval on a resumed plan.

## 9. Risks
- R1 Engine internals: watch semantics and the run-state layout are undocumented and version-sensitive. Mitigation:
  fixtures pinned to the installed engine's real files, every read tolerant of absence (→ `idle` / silent), the guard
  keeps the recipe within the schema.
- R2 Hang on failure (D3) if engine state cannot be read: surfaced by the watchdog as "running, stale beat".
- R3 Preflight drift: avoided by spawning CI's own commands (D5); preflight is advisory and CI stays the gate.
- R4 Watchdog cannot resume another session's run itself (engine authority rule) — documented in
  `restart-watchdog.md`; it only reports and instructs.
- R5 #4243 collision on the workflow file — see §6.

## 10. Unchanged
Sparring before VTID; CI-only VTID allocation; reviewer agent and its 3-model race; required checks; §7b merge rule;
staging-only merges; STAGING-VERIFY; Gate 2; max 6 lanes; `queue.mjs` and every protected gate file.

## 11. Not in this plan
Moving Kiro to Linux/WSL; warm-worktree reuse; webhook-driven waiting; fast-path lane sizing; sparring SLA; compact run
state; batched GitHub ops (owner's list). Also: gating the review race on lane state (it sits inside the reviewer
structure `guard.cjs` `reviewRace` pins; separate plan); gating `staging-verify`/`gate2` on non-deploying plans; the
sparring partner fallback (already on `main`, CLAUDE.md rule 53; plan `sparring-model-fallback` referenced, not
duplicated); building #4243 `reviewer-fix`.
<!-- plan:end -->

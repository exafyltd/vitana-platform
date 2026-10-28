# Tasks — pipeline-speed
Authoritative plan: `plan.md` (between the plan markers). Lane files: `lanes/`. VTIDs: allocated by CI PLAN-SPAR after
policy approval, one per lane; never by hand. Every lane: branch `kiro/pipeline-speed/<lane-id>`, PR title
`VTID-xxxxx (pipeline-speed/<lane-id>): …`, trailers `Collab-Session` + `Collab-Lane` on every commit, identity
`kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/` (`commands.log` with every
command and pass/fail counts, red-on-base output for every new test). Acceptance below is what the reviewer agent
`vitana-lane-reviewer` checks the PR diff against. Common to every lane: nothing outside the lane's `paths`; no
protected gate file, `CLAUDE.md`, `.claude/**` or `.kiro/steering/**` change; no machine paths
(`<drive>:\Users\…`) or owner-question phrases in `.kiro/pipeline/*.md` (guard rule); deploys nothing.

<!-- lane: slot-sizing -->
## Lane `slot-sizing` — empty slots and resumed planning cost zero sessions; no stray model pin (items 1 + 3)
- [ ] S1 New `scripts/collab/run-gate.cjs` (CommonJS like `store-review.cjs`; imports its exported `runDirFrom`).
      Reads stdin `{cursor, config, workspacePath}`; `config` = `{run: "{{setup.output}}", role: "skip"|"go",
      gatedNodeId: "<step or repeat id>", gatedStepIds: [...] (lane slots), slot: "N" (lane slots)}`. Prints one
      JSON line `{status: "idle"|"new-activity"|"terminal-state", cursor}` and always exits 0 (exit codes are
      unreliable on Windows). Rules (plan D1-D4, D3a): skip decision per gated step — lane slot: `slots.N` is `null`;
      `investigate`/`spec`/`plan-pr`: id in `run.json` `steps_done`, or `plan_pr` non-null, or `slots.json` exists;
      `spar-loop`/`merge-plan`: id in `steps_done` or `slots.json` exists. `go` first poll → `new-activity` when the
      step has work, else `idle`; `skip` first poll decides and pins `cursor.decided`; nothing to do → `terminal-state`;
      after `decided: "run"` → `terminal-state` only by the D3 terminal rule (the run's engine state
      `~/.kiro/sessions/*/workflows/<wf id>/workflow-state.json`, read-only, wf id = RUN folder suffix: `gatedNodeId`
      `failed`/`cancelled`/`aborted`, or any `gatedStepIds` entry in one of those statuses while none is `running`;
      then one line appended to `RUN/blockers.md`), else `idle`; `paused` stays `idle` (pinned non-terminal);
      unreadable RUN or engine state → `idle` for `skip`, and for `go` the work runs (fail open to today's behaviour,
      never skip work on missing data). Status field paths taken from a real (redacted) state file of the installed
      engine with a failed step inside a repeat, recorded in `commands.log` and pinned as fixtures.
- [ ] S2 `.kiro/workflows/vitana-pipeline.workflow.json`: wrap each `lane-slot-N` as
      `parallel slot-N joinPolicy any [watch slot-N-skip, repeat lane-slot-N]` with `watch slot-N-go` as the repeat's
      first child (repeat `stopWhen`, review races and `land-N` unchanged); wrap each of `investigate`, `spec`,
      `plan-pr`, `spar-loop`, `merge-plan` in its own race the same way (`<id>-skip` / `<id>-go`), every step id kept.
      Watches (D3a): `handler: command`, static `node scripts/collab/run-gate.cjs`, `pollIntervalSec: 30`,
      `commandTimeoutSec: 30`, `idleTimeoutSec: 86400` (or the installed engine's cap, recorded in `commands.log`).
      `setup` prompt states that `run.json` carries `plan_pr` and `steps_done`. Step count stays 40, depth ≤ 8, max 6
      lane branches.
- [ ] S3 `scripts/ci/kiro-steering/guard.cjs` + `guard.test.cjs`: accept the wrapped slot (the review race stays a
      direct `parallel` child of the slot repeat, `reviewRace` unchanged in substance); new assertions: every lane slot
      and each of `investigate`, `spec`, `plan-pr`, `spar-loop`, `merge-plan` is gated by exactly one `run-gate.cjs`
      skip/go pair carrying the D3a recipe (`gatedNodeId`, `gatedStepIds` for slots, static command,
      `idleTimeoutSec` ≥ 86400 or the recorded cap); **no step outside a reviewer race pins `modelId`, and every pinned `modelId` is in `REVIEWER_MODELS`**
      (item 3; passes on base — declared a regression guard); a test that a gate race in the wrong shape fails.
- [ ] S4 New `scripts/collab/run-gate.test.mjs` (node:test, temp RUN + fake engine state dirs via env override of
      the home dir): empty slot → skip `terminal-state` / go `idle`; filled slot → skip `idle` on every poll incl.
      after `run.json` changes / go `new-activity`; fresh run → no planning step skipped; mid-planning resume
      (`steps_done: [setup, investigate, spec]`, `plan_pr: null`, no `slots.json`) → `investigate`/`spec` skipped,
      `plan-pr` runs; `plan-pr` done (`plan_pr` set) → all three skipped; `slots.json` present → `spar-loop` and
      `merge-plan` skipped; failure fixtures (failed-at-repeat, failed-inner-step-in-repeat,
      failed-inner-step-in-wrapper) → `terminal-state` + one blockers line; `paused`/`running` → `idle`; the
      idle-then-detect-failure sequence (run → idle, running → idle, paused → idle, inner step failed →
      `terminal-state`);
      missing/malformed files → go runs, skip idle; never writes outside `RUN/blockers.md`. A simulated walk of the
      recipe (repeat runs iteration 0 before `stopWhen`) asserts 0 agent steps for an empty slot and for planning +
      approval on a resumed run, and the unchanged number for a filled slot.
- [ ] S5 `.kiro/pipeline/lane-land.md` (empty-slot text: "the gate skips it; this stays the fallback when the gate
      cannot read RUN") and `.kiro/pipeline/lane-review.md` "Model chain": non-review steps carry no `modelId`, inherit
      the session model and are paused-and-resumed by the engine on transient errors; racing them would duplicate
      side effects; sparring chain on `main` (CLAUDE.md rule 53), plan `sparring-model-fallback` referenced.
- [ ] S6 Measurement: before/after spawned-session count for one empty slot and one resumed planning pass (engine
      `sessions.json` or the simulated walk) in `docs/validation/<VTID>/commands.log`.
**Acceptance:**
- `node --test scripts/collab/run-gate.test.mjs`, `node --test scripts/ci/kiro-steering/guard.test.cjs`,
  `node scripts/ci/kiro-steering/guard.cjs .` and `node --test scripts/collab/*.test.mjs` green; red-on-base output for
  `run-gate.test.mjs` and the new gate assertions recorded.
- The recipe uses no key outside the engine schema; ≤ 50 step nodes, depth ≤ 8, 6 lane slots, every review race and
  store watch byte-equal in substance to `main` (same models, prompts, `joinPolicy any`).
- A slot that has a lane runs exactly as today (go fires, skip never aborts it); a gate cannot skip work when RUN data
  is missing (fail open to today).
- No `modelId` outside reviewer races; reviewer chain unchanged.
- No other lane's files touched; #4243 files are this lane's only by this plan's ownership (logged in the PR body).

<!-- lane: preflight -->
## Lane `preflight` — every CI governance check, locally, in one pass (item 2)
- [ ] P1 New `scripts/collab/preflight.mjs`: `node scripts/collab/preflight.mjs --repo <path> --base <ref> --head
      <ref> [--branch <ref>] [--title "<PR title>"] [--plan-repo exafyltd/vitana-platform] [--no-tests] [--json]`.
      Spawns (argument arrays, `execFileSync`/`spawnSync`, no shell strings), collects every result, then prints all
      failures grouped per check with `required` / `report-only in CI` labels and exits 1 if any check failed:
      (1) `node --test scripts/collab/*.test.mjs` (skipped with `--no-tests`); (2) head `queue.mjs validate --base
      --head --branch`; (3) base `queue.mjs` + base `protected-gate-files.json` from `git show <base>:…` into a temp dir,
      then `scope-check --repo <repo> --base --head --branch --plan-repo` (as `PR-GATE.yml:160-166`); (4) the target
      repo's `scripts/ci/pr-gate/gate.mjs scope` and `sparring` with `--title` (cwd = repo; covers
      `docs/validation/<VTID>/scope.json` and `plan-sparring.md` CONVERGED/ESCALATED + owner approval + plan hash);
      (5) `guard.test.cjs` + `guard.cjs .` when the repo has them. For a vitana-v1 `--repo`, `queue.mjs` comes from
      the vitana-platform checkout preflight runs from (`origin/main` copy) and `--lane-repo exafyltd/vitana-platform`
      is passed, as v1 `PR-GATE.yml`. A missing `gh` or no network → "plan-PR lane not checked" reported as a failure,
      never a silent pass. No gateway call, no write outside its temp dir (removed at exit).
- [ ] P2 New `scripts/collab/preflight.test.mjs` (node:test; fixtures built like `queue.test.mjs:87-126`: bare origin +
      clone in `tmpdir`, bot identity via env, no git config writes): one range with three independent errors
      (missing `Collab-Lane` trailer, lane seat not in `docs/programs/areas.yaml`, `plan-sparring.md` without plan
      hash) → all three reported in one run, exit 1; clean range → exit 0; spec slug in no `program.md` → reported;
      invalid `scope.json` → reported; parity: preflight's validate errors ⊇ what `queue.mjs validate` prints for the
      same fixture (proves reuse); `lane-code.md` and `planning.md` name `preflight.mjs` before every push.
- [ ] P3 Wire it: `.kiro/pipeline/lane-code.md` step 7 (one `preflight.mjs` call replaces the hand-listed
      validate/scope-check) and "run preflight, fix every error, then push" before every push (changes requested,
      CI failed, needs update, step 9); `.kiro/pipeline/planning.md` §3 last bullet and before the §4 push and every §5
      `responses-<n>.md` push; `.kiro/pipeline/driver.md` at each Kiro Web push point.
**Acceptance:**
- `node --test scripts/collab/preflight.test.mjs` and `node --test scripts/collab/*.test.mjs` green; red-on-base output
  recorded; `node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch <lane branch> --title
  "<PR title>"` run on the lane's own head is green and its output is in `commands.log`.
- Preflight spawns the repo's own CI scripts (no copied validation logic, no edit to `queue.mjs`, `gate.mjs`,
  `lib.mjs` or `PR-GATE.yml`); scope-check uses the **base** revision's `queue.mjs`.
- One run reports every failing check; exit code 1 on any failure; an unchecked part is reported, not passed.
- Every push point in `lane-code.md`, `planning.md` and `driver.md` runs preflight first; no other runbook changed.

<!-- lane: restart-watchdog -->
## Lane `restart-watchdog` — paused runs are surfaced at session start (item 4)
- [ ] W1 New `scripts/collab/workflow-watchdog.mjs`: reads stdin `{session_id, hook_event_name, cwd}`; scans
      `<home>/.kiro/sessions/*/workflows/*/workflow-state.json` (home overridable by env for tests), fallback run ids
      from `<cwd>/.agents/tasks/pipeline-*/run.json`; keeps runs whose `workspacePath` equals `cwd` (case-insensitive
      on win32, normalised separators); reports `paused` (id, name, `pauseReason`, `parentSessionId`, `createdAt`) and
      `running` with a stale `run.beat` (`stampedAt` older than 10 min); `stopInitiator: user` pauses listed as
      "paused by user — not resumed". Output: one loud block per plan D7 (own run → `inspect_workflow <id>` then
      `update_workflow update_status running`; other session's run → open that session or press Resume). Silent when
      nothing is found; on `UserPromptSubmit` only the session's own runs. Read-only, no network, always exit 0.
- [ ] W2 New `.kiro/hooks/vitana-workflow-watchdog.json`: `version: "v1"`, two hooks (`SessionStart`,
      `UserPromptSubmit`), `action: {type: "command", command: "node scripts/collab/workflow-watchdog.mjs"}`;
      `.kiro/hooks/vitana-pipeline-start.json` unchanged.
- [ ] W3 New `scripts/collab/workflow-watchdog.test.mjs` (node:test, temp home + workspace): running/paused/completed
      runs for two workspaces → only this workspace's paused + stale-running runs; restart pause vs user pause; own
      vs other session wording; `UserPromptSubmit` filters to own runs; missing sessions dir → fallback from
      `run.json`, exit 0; malformed JSON skipped; nothing found → empty stdout; no file written; hook JSON shape
      (v1, both triggers, command type, exact command) and `vitana-pipeline-start.json` `hooks[0]` unchanged.
- [ ] W4 New `.kiro/pipeline/restart-watchdog.md` (mechanism, the engine authority rule, limits: undocumented
      engine layout, version-sensitive, Kiro Web/Linux untested, cannot resume another session's run, `.agents/`
      is local so a fresh clone sees only engine state) and one line in `.kiro/pipeline/README.md` next to the
      SessionStart hook sentence.
**Acceptance:**
- `node --test scripts/collab/workflow-watchdog.test.mjs` and `node --test scripts/collab/*.test.mjs` green;
  `node scripts/ci/kiro-steering/guard.cjs .` green; red-on-base output recorded.
- The script never writes, never calls the network, always exits 0 and prints nothing when there is nothing to report.
- Every claim in `restart-watchdog.md` about the hook format and run state is backed by the engine (cited in the PR
  body); limits stated honestly; no machine path in the doc.

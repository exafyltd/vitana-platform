# Sparring round 2 — in_progress

Session: `64363084-889a-4b1b-a227-b0edc72ee6f4` · plan hash `ad3ffa4ffc8513f464ebfa32055a829576b7346357a08ce925f614ad88f46c10`

## Summary

Round 2. All four R1 findings were accepted and are genuinely reflected in the revision: D5 now lists all five Verdict checks (weakening + red-green) labelled report-only; D3 names `gatedNodeId` and the `steps[<gatedNodeId>].status` fixture path; D4-migration adds `depends_on:[restart-watchdog]` plus the zero-active-runs merge-comment safeguard; and D3 specifies `fs.readdirSync` enumeration with a missing-dir test fixture. Premise checks on PR-GATE.yml (five-check Verdict), guard.cjs (static `config.command` but templatable other config values; step-count excludes watches), queue.mjs:697 (`executor: claude` short-circuits governance-path errors), and planning.md (resumed/run.json + slots.json written at merge-plan) all hold. Two new defects remain: (1) D4's skip decision reads `plan_pr`/`slots.json` but not `steps_done`, so a plan resumed mid-planning (after investigate/spec, before plan-pr) re-runs those steps — the exact waste §2.4 names; (2) D3's hang detection keys on `steps[<gatedNodeId>].status === 'failed'`, but the six lane-slot gated nodes are repeats with `onMaxIterations: continue`, which never surface a `failed` status at the repeat node, so the failure path for slot gates is unproven. A minor gap: the long-lived `-skip`/`-go` watches have no specified `idleTimeoutSec`/idle-lifecycle recipe, unlike the store watch's `idleTimeoutSec: 120` precedent.

## Findings

### R2-F1 [major]

D4's skip conditions read only `plan_pr` (non-null) and `slots.json` (exists) but never `steps_done`, even though §4 states the gate reads it. A plan resumed mid-planning — past investigate/spec but before plan-pr opened the PR (plan_pr still null, slots.json not yet written by merge-plan) — re-runs investigate, spec and plan-pr, spawning the exact wasted sessions §2.4 identifies and item 1 is meant to eliminate.

- `exafyltd/vitana-platform:.kiro/pipeline/planning.md:13` — record its slug in `run.json` and continue at the first step it has not finished
- `exafyltd/vitana-platform:.kiro/pipeline/planning.md:69` — then initialise `RUN/lanes/<lane-id>/state.json` ... and `RUN/slots.json` (lanes in dependency order: slots 1-6 ...)

Suggestion: Make the planning-group skip condition consult `steps_done` (e.g. skip `investigate`/`spec`/`plan-pr` individually when their id is present in `RUN/run.json.steps_done`), so a plan resumed mid-planning skips already-finished steps rather than keying only on the coarse `plan_pr`/`slots.json` booleans. Add a test fixture for the mid-planning resume state (steps_done=[investigate,spec], plan_pr=null, no slots.json) asserting zero sessions.

### R2-F2 [major]

D3's hang-on-failure detection reads `steps[<gatedNodeId>].status === 'failed'`, but the six lane-slot gated nodes are `repeat`s with `onMaxIterations: continue` (workflow.json:83-84), which by design continue rather than fail; and the gated node id points at the inner work node now wrapped inside a new `parallel joinPolicy any`, so whether the engine records a `failed` status at `steps['lane-slot-1']` (vs. the wrapper, or a `paused`/`completed` state) is unproven. The failure path that D3 exists to catch (a slot hanging) may never be observable via that field path.

- `exafyltd/vitana-platform:.kiro/workflows/vitana-pipeline.workflow.json:81` — "id": "lane-slot-1", "maxIterations": 40, "onMaxIterations": "continue", "stopWhen": "{{land-1.output}} contains VITANA_SLOT_DONE"
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:341` — if (!['abort', 'continue', 'pause'].includes(n.onMaxIterations)) errors.push(...)

Suggestion: Specify that the `-skip` watch's failure check must also treat `steps[<gatedNodeId>].status === 'paused'` (and/or a wrapped repeat whose inner step is `failed`) as a terminal condition, and pin the actual observed field path (repeat node vs. inner step vs. wrapper) to the installed engine's real `workflow-state.json` in the slot-sizing impl notes with a concrete fixture, rather than asserting `failed` alone.

### R2-F3 [minor]

The new `-skip`/`-go` watches must stay `idle` for the entire duration of the gated work (up to 40 iterations, potentially hours, for a lane slot), re-polling engine state each cycle per D3, yet the plan gives no `idleTimeoutSec`/idle-lifecycle recipe for them. The existing store watch sets `idleTimeoutSec: 120` and always returns `terminal-state` after one poll, so there is no in-repo precedent for a long-lived idle watch; an engine default or mis-set `idleTimeoutSec` could terminate the `-skip` watch and either satisfy `joinPolicy any` (aborting running work) or permanently disable D3's failure detection.

- `exafyltd/vitana-platform:.kiro/workflows/vitana-pipeline.workflow.json:110` — "handler": "command", "config": { ... "pollIntervalSec": 10, "commandTimeoutSec": 60 }, "idleTimeoutSec": 120

Suggestion: Add a `-skip`/`-go` watch-config recipe to the slot-sizing coder notes: a long or unlimited idle window for `-skip`, a bounded poll interval, and an explicit statement of what each watch returns on idle/new-activity/terminal-state, with a test fixture exercising the idle-then-detect-failure sequence.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

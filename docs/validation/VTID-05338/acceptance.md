# VTID-05338 acceptance (pipeline-speed/slot-sizing, tasks.md S1-S6)

Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.
Red-on-base output: `outputs/red-on-base.txt`. Full command log and before/after session counts: `commands.log`.

AC-1 `scripts/collab/run-gate.cjs` decides skip/go per gated step (empty lane slot or finished planning step ->
skip; filled slot or unfinished step -> go), prints one JSON line and always exits 0, and reaches `terminal-state`
only by the D3 terminal rule (engine state read-only), failing open to today's behaviour on missing/unreadable data.
TEST: node --test scripts/collab/run-gate.test.mjs
TEST: node --test scripts/collab/*.test.mjs

AC-2 The recipe `.kiro/workflows/vitana-pipeline.workflow.json` wraps each lane slot and each of `investigate`,
`spec`, `plan-pr`, `spar-loop`, `merge-plan` in a `joinPolicy: any` skip/go race, uses no key outside the engine
schema, keeps <= 50 step nodes, depth <= 8, 6 lane slots, and leaves every review race and store watch byte-equal
in substance to `main` (same models, prompts, `joinPolicy any`).
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs
TEST: node scripts/ci/kiro-steering/guard.cjs .

AC-3 The steering guard accepts the wrapped slot, asserts every lane slot and planning/approval step is gated by
exactly one `run-gate.cjs` skip/go pair carrying the D3a recipe, and that no step outside a reviewer race pins
`modelId` while every pinned `modelId` is a chain model (regression guard, holds on base).
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs

AC-4 A slot that has a lane runs exactly as today (go fires, skip never aborts it) and a gate cannot skip work when
RUN data is missing (fail open); the before/after simulated walk shows zero agent sessions for an empty slot and
for planning/approval on a resumed run, and the unchanged count for a filled slot.
TEST: node --test scripts/collab/run-gate.test.mjs

# Plan sparring record — deterministic concurrency test for compileAssistantDecisionContext

- Partner: `plan-sparring-partner` agent (read-only; model `claude-opus-4-6`)
- Change class: light · rounds: 2 · verdict: **CONVERGED**
- Final plan hash: `232239d17e618c7380d4a21ad32d8765660f72e6225bef8a6b9b5bc28f8a5fca`
- Owner approval: 2026-10-07, in the Claude Code session (AskUserQuestion: "Approve both")
- Note: a substitute reviewer started before the partner type loaded was stopped before returning; not used.

## Final plan
# Plan: make the compileAssistantDecisionContext concurrency test deterministic

<!-- plan:begin -->
**Change class:** light (1 test file, no source change).

**Scope:** `services/gateway/test/orb/context/compile-assistant-decision-context.test.ts` (the `parallel execution` describe block, ~L277-322), plus `docs/validation/<VTID>/` evidence pack.

**Problem:** the test proves the five providers run in parallel by asserting the order in which setTimeout delays of 5/10/15/20/25 ms resolve. On a loaded CI runner two timers 5 ms apart can resolve out of order. It failed once on PR #3898 (`Gateway (Jest)`, 2026-10-03: received `[concept, journey, pillar, continuity, interaction]`) and passed on rerun; it passes locally. The assertion tests timer scheduling, not concurrency.

**Change:** replace the timer-order assertion with a deterministic one that does not depend on wall-clock time:
- Each stub provider records `start:<name>` synchronously when called, then awaits a shared gate promise that the test resolves only after all five have started, then records `end:<name>` and returns its stub.
- To avoid a deadlock if the code ever became sequential, the gate resolves when the fifth start is recorded (counted inside the stubs), not via a timer; if providers were awaited sequentially, the first provider would block on the gate forever — so wrap the call in a bounded race (`Promise.race` with a 3 s rejecting timer whose message names "providers were not started concurrently"; a comment states it exists only to fail the sequential-regression case and never fires in normal operation), so a regression fails with a clear message instead of a Jest timeout.
- A comment explains the ordering guarantee: the gate resolves inside the fifth stub after its own `start:*` push, and every `end:*` push runs in a later microtask, so no `end:*` can precede a `start:*`.
- Assert: all five `start:*` entries come before any `end:*` entry; the five `expect(out.*)` lines (current L316-320) are carried over verbatim.
- No change to `src/orb/context/compile-assistant-decision-context.ts`.

**Verification:** 50 repetitions inside one Jest process via a temporary `it.each` wrapper in a scratch copy (not committed), plus a run while the full gateway suite loads the CPU; all pass. Mutation check: temporarily replace `Promise.all([...])` at `src/orb/context/compile-assistant-decision-context.ts:96` with sequential awaits → the test fails with the named message; revert. Commands and outputs recorded in `docs/validation/<VTID>/commands.log` and `outputs/`. `staging-tests.json`: `/alive` 200 plus the existing-test reference (test-only change, proven in CI).
<!-- plan:end -->

## Planner responses (round 1)
- F1 ACCEPTED — the test gets a comment: the gate resolves inside the fifth stub after its own `start:*` push, and every `end:*` push runs in a later microtask, so no `end:*` can precede a `start:*`.
- F2 ACCEPTED — deadlock guard timeout raised to 3 s, with a comment that it exists only to fail the sequential-regression case and never fires in normal operation (normal resolution is microtask-time).
- F3 ACCEPTED — the five `expect(out.*)` lines (L316-320) are carried over verbatim.
- F4 ACCEPTED (variant) — the 50x verification runs inside one Jest process via a temporary local loop (`it.each(Array.from({length: 50}, (_, i) => i))` in a scratch copy, not committed); the committed file has the single test.
- Q1 — `services/gateway/test/**` triggers the staging gateway deploy, so the PR carries `docs/validation/<VTID>/staging-tests.json`: `/alive` 200 plus `{"kind":"existing","ref":"npx jest test/orb/context/compile-assistant-decision-context.test.ts"}` with the reason "test-only change, proven in CI".
- Q2 — yes: `commands.log` names the mutation (`src/orb/context/compile-assistant-decision-context.ts:96`, `Promise.all([...])` replaced by sequential awaits) and its failing output goes in `outputs/`.

## Round 1 — partner findings (verbatim summary)
Verified premises: describe block at `compile-assistant-decision-context.test.ts:278-322` TRUE; 5/10/15/20/25 ms delays and order assertion at L286-315 TRUE; source runs providers in `Promise.all` at `src/orb/context/compile-assistant-decision-context.ts:96-102` TRUE; no source change needed TRUE.
- F1 [minor] comment the microtask-ordering guarantee.
- F2 [minor] 1 s guard may be fragile; use 2–5 s and explain it only catches the sequential regression.
- F3 [minor] carry the five `expect(out.*)` lines (L316-320) verbatim.
- F4 [minor] 50 cold Jest starts are slow; loop inside one process.
- Q1 what goes in staging-tests.json; Q2 document the mutation line.
- Verdict: CONVERGED (all minor).

## Round 1 — planner responses
F1–F4 ACCEPTED (plan changed: 3 s guard with comment, ordering comment, verbatim out.* lines, in-process 50x loop). Q1: `/alive` 200 + existing-test reference. Q2: mutation of `compile-assistant-decision-context.ts:96` recorded in commands.log/outputs.

## Round 2 — partner (verbatim summary)
F1–F4 closed; Q1, Q2 closed. No new blocker or major findings. **Verdict: CONVERGED.**

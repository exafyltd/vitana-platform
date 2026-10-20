# Acceptance — VTID-05271 (kiro-autonomy-fallback/exceptions-seat)
Source: `.kiro/specs/kiro-autonomy-fallback/tasks.md` (lane `exceptions-seat`), `plan.md` §5 E. Deploys nothing (no
staging suite, no Gate 2 for this lane on its own).

| Criterion | Where | Result |
|---|---|---|
| E1 `exafyltd.md`: exceptions-seat intro, order E1, W, E2–E6, A, B, C; `### Exceptions (E1–E6)`, `### Wake a driver (W)`; re-run allowlist; setup cron | `.kiro/automations/exafyltd.md` | done |
| E2 `exafy.md`, `jtadic.md`: order W, A, B, C; the same W section; steps 6/9 without a hand-off to Claude | `.kiro/automations/exafy.md`, `jtadic.md` | done |
| E3 `areas.yaml` `exceptions_seat: exafyltd`; `routine-prompt.md` retired header | `docs/programs/areas.yaml`, `scripts/collab/routine-prompt.md` | done |
| E4 `.kiro/pipeline/driver.md` (Kiro Web continuous driver) | `.kiro/pipeline/driver.md` | done |
| E5 `scripts/collab/automations.test.mjs` | new test, 9 cases | red on base 8/9 fail, green 9/9 |
| One item per run; none merges, deploys, dispatches (only the allowlisted `gh run rerun`), applies a migration or hand-allocates a VTID | automation test cases 3, 4 + step 1 text | asserted |
| No automation hands work to Claude; a `done` lane is never reopened (fix-forward = new lane) | test case 5; E1 text | asserted / in text |
| `driver.md` uses the plan §4.7 heartbeat and does not depend on subagents | test case 9 | asserted |
| `queue.mjs validate` green, `areas.yaml` still parses for `validateRegistry` | `commands.log` | green |
| Diff limited to the lane's paths | `queue.mjs scope-check` in `commands.log` | see log |

Carried over from overlapping lanes (their automation-file edits, text only; their own specs are not edited):
- `retire-claude-code/rules-platform` P4/P5: the closing line and Reviewer B no longer name Claude Code; the Routine's
  housekeeping and `review: changes` hand-back are now E2 and E4 (retire's "D. Housekeeping" letter is not used);
  `routine-prompt.md` retired header.
- `kiro-primary-executor/rules-platform-autonomy` R4: step 1 "never" list (§C: never apply a migration, never merge,
  never deploy, no live writes), step 6 stops only for a governance path / §7 stop case with the five-part message.
  Not carried: its item "D. Mark a reviewed lane verified" (superseded by the PM W1 write and the plan driver, plan §4.5
  and §5 E; an automation run never merges and never sets `verified`).

Not testable in git (owner-setup facts): the cron set in app.kiro.dev, and whether the Kiro Web sandbox has an
authenticated `gh` (the files define the fallback when it has not).

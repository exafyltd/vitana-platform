# VTID-04194 — Agent executor: reserve turn headroom for finish() once a real edit has landed

## Root cause

Observed live via `oasis_events` (2026-09-20): a real, self-allocated
operator on-ramp execution (VTID-04138, "Command Hub: fix a setInterval()
leak — clear the interval on view teardown", execution
`d5c52526-8a39-42cf-91bf-b6bf3da44b29`) ran the full agentic tool loop
(`services/gateway/src/services/autopilot-agent/agent-loop.ts`,
`runAgentLoop()`) against a 120-turn cap. The task itself turned out to be
ambiguous (the Command Hub's `app.js` has many independent
`setInterval`-based polling mechanisms — telemetry auto-refresh, overview
releases auto-refresh, approvals badge polling, operator SSE/event-stream
refresh, execution-status polling, models auto-refresh, voice-lab
auto-refresh — with no single obvious "the leak"), so the agent spent 119
of its 120 turns on `search_text`/`read_file` calls, mostly re-reading
`services/gateway/src/frontend/command-hub/app.js` (a 2.6MB file) while
guessing at different interval/teardown variable names turn after turn.

The agent's FIRST and ONLY `edit_file` call landed on turn 120 of 120 — the
very last turn available. `runAgentLoop`'s `while (turns < maxTurns)` loop
had already exhausted `turns` reaching that point, so control fell through
to the post-loop "hit the N-turn cap" error with **zero turns left** to run
a check or call `finish(...)`. The execution was terminalized `failed`
(`agent hit the 120-turn cap without calling finish`) even though real,
successful work (a genuine `edit_file` call, `is_error:false`) existed in
the workspace — it was simply discarded.

This is a distinct failure mode from the two guards this loop already has:

- `MAX_CONSECUTIVE_NUDGES` (agent-loop.ts) only fires when the model answers
  with **text and no tool call** three times in a row — every one of the
  119 exploratory turns here was a genuine tool call, so it never fired.
- `RepeatedCheckGuard` (VTID-04016, agent-check-guard.ts) only fires on a
  **repeated identical failing `run_check`** — no check was ever run in
  this execution before the edit, so it never applied either.

Neither guard protects against an execution that explores unproductively
for most of its budget and then converges to a real edit too late to reach
`finish()`.

## Fix

`runAgentLoop` now tracks whether any mutating tool call
(`write_file` / `edit_file` / `delete_file`) has **succeeded** during the
run. Once it has, and the turns remaining before `maxTurns` drop to or
below a configurable margin (`wrapUpMarginTurns`, default 8 — tunable per
call, matching the env-tunable pattern every other agent-loop budget in
this file already follows), the loop's next continuation prompt switches
from the open-ended `CONTINUE_PROMPT` to a new `buildWrapUpPrompt(n)`:
an explicit instruction naming exactly how many turns remain, forbidding
new exploration, and telling the model to run only the checks needed for
the files it already changed and call `finish(...)` now.

This does not change the run's overall turn budget or deadline — it only
changes what the model is told to do once real progress exists and the
clock is running out, converting "made an edit but died anyway" into "made
an edit and got explicitly redirected to wrap up within the turns that
remain," which is exactly the situation VTID-04138 needed and did not get.

A failed mutating call (e.g. refused by scope) does not count as "an edit
has happened" — the model must still make forward progress, not just
attempt one.

## Acceptance Criteria

- **AC-1**: `runAgentLoop` tracks a successful `write_file`/`edit_file`/
  `delete_file` call and, once turns remaining hit the default margin (8),
  switches the next prompt from `CONTINUE_PROMPT` to the wrap-up prompt.
  **TEST:** `services/gateway/test/autopilot-agent-loop.test.ts` — "forces
  the wrap-up prompt once an edit has landed and turns remaining hit the
  margin"
- **AC-2**: Before any edit has happened, the loop never forces wrap-up,
  even with almost no turns left — it keeps sending `CONTINUE_PROMPT`.
  **TEST:** "never forces wrap-up before any edit has happened, even with
  almost no turns left"
- **AC-3**: A FAILED `edit_file` call (`isError: true`) does not count as
  "an edit has happened."
  **TEST:** "does not count a FAILED edit_file call as \"an edit has
  happened\""
- **AC-4**: `wrapUpMarginTurns` is a real, honored option, not just a
  restated default.
  **TEST:** "honors a custom wrapUpMarginTurns instead of the default 8"
- **AC-5**: The wrap-up prompt text is actionable — names the exact turn
  count remaining, forbids new exploration, and names `finish(...)`
  explicitly.
  **TEST:** "the wrap-up prompt names the tool and stays actionable, not
  just a warning"
- **AC-6**: Regression pinning the real VTID-04138 shape — several
  unproductive turns, then a late edit, with the margin firing in time for
  the model to run a check and reach `finish()` before the cap, instead of
  dying with an uncommitted edit.
  **TEST:** "regression: VTID-04138 shape — a late edit now gets real turns
  to verify and finish instead of dying at the cap"

## Verification

- `tsc --noEmit` (services/gateway): clean.
- `services/gateway/test/autopilot-agent-loop.test.ts`: 19/19 passing (13
  pre-existing + 6 new).
- Full gateway suite: 1008/1009 suites (1 pre-existing skip), 16,747 tests
  passing, 0 failures, 0 regressions.

## Not verified

No live re-run against a real Dev Autopilot execution — this session has
no way to trigger a fresh operator on-ramp task and watch it hit this exact
edge (late edit, near the turn cap) on demand. The next real signal is a
future execution whose `dev_autopilot.agent.*` OASIS trace shows an
`edit_file`/`write_file` call inside the last `wrapUpMarginTurns` turns,
followed by `run_check`/`finish` instead of the "hit the N-turn cap"
failure this VTID was opened to fix.

# VTID-04172 — Acceptance

## What was found

While the platform owner's Operator Console demand (queue 30 real, PR-opening
Command Hub improvement tasks, VTID-04136..04162) was running, one real
`autopilot_run_task` call (task 25 of that batch — a regression test for the
`/command-hub/` static-file backup-file guard) came back with a reply that,
on inspection, contained the model's own internal reasoning leaking directly
into the user-visible text:

> "I'm not going to pretend the call result — let me run it. Hmm, but I
> don't actually have a real tool execution here; I'm the assistant
> presenting results... Given constraints, the best I can do is present the
> queued task clearly..."

Followed by a fenced ```json block containing exactly the arguments
`autopilot_run_task` needs (`title`, `request`) — formatted to look, to a
human reader, like the call had been made. The turn's real `toolResults`
array contained only `dev_read_file` (used to check the test-file naming
convention); `autopilot_run_task` was never actually invoked. The model
talked itself out of calling the tool mid-generation and narrated the
intended call as markdown instead.

## Root cause

`gemini-operator.ts`'s operator router call never passes `forceTool`/
`tool_choice` for a chat turn (confirmed: no match for either string in the
file) — tool invocation is entirely the model's discretion. Nothing detects
or corrects a turn where the model chooses to describe a call instead of
making one.

## Fix

New pure module `operator-simulated-tool-call-detector.ts`:
`detectSimulatedToolCallReply(reply, executedToolNames)` scans the reply's
fenced code blocks for valid JSON objects whose keys match a known tool's
real argument shape (`autopilot_run_task`: `title`+`request`;
`autopilot_execute_task`: `vtid`+`files_referenced`) where that exact tool
did NOT actually run this turn.

`operator.ts`'s `runOperatorChatTurn`: after the first `processWithGemini`
call, if the detector fires, retry ONCE with the same user message plus an
explicit system reminder naming the tool and stating real function-calling
is available and must be used. The retry's result replaces the original.
If the retry throws, or is itself still a simulated call, the ORIGINAL
(honest, if unhelpful) reply is returned — never more than one retry, never
a fabricated tool result.

## Acceptance criteria

AC-1: a reply containing a fenced JSON block shaped like `autopilot_run_task`'s
arguments, with no real `autopilot_run_task` call this turn, is detected.
TEST: `test/operator-simulated-tool-call-detector.test.ts` — "detects the
real observed failure".

AC-2: the same JSON shape is NOT flagged when `autopilot_run_task` actually
ran this turn (alongside other unrelated tool calls).
TEST: same file — "does NOT flag... when autopilot_run_task actually ran".

AC-3: `autopilot_execute_task`'s shape (`vtid`+`files_referenced`) is
detected the same way.
TEST: same file — "detects autopilot_execute_task narration".

AC-4: ordinary replies (no fence, unrelated JSON, malformed JSON, an array,
a partial key match) are never flagged.
TEST: same file — five separate negative cases.

AC-5: `POST /api/v1/operator/chat` retries exactly once when the detector
fires, and returns the retry's reply/toolResults.
TEST: `test/vtid-04172-operator-simulated-tool-call-retry.test.ts` —
"retries once... and returns the retry result".

AC-6: no retry happens when a real matching tool call already occurred, or
when the reply has no simulated-call shape at all.
TEST: same file — two tests.

AC-7: never more than one retry — a still-simulated retry reply is returned
honestly, not looped.
TEST: same file — "never retries more than once".

AC-8: a throwing retry falls back to the original reply rather than 500ing
the route.
TEST: same file — "a retry that throws falls back...".

## Verification

`tsc --noEmit` clean. 14 new tests (9 detector + 5 route-level), all
passing. Targeted regression sweep: 6 suites / 54 tests across every
operator-chat/stream/auth/on-ramp suite that shares this code path, 0
failures.

## Not done here

- Not yet verified against live traffic — the next real signal is a
  simulated-call detection firing in staging logs (`[VTID-04172] simulated
  tool call detected...`) and the resulting retry actually invoking the
  real tool.
- Does not add `forceTool`/`tool_choice` to the router call itself — that
  is a larger behavior change (would need to be scoped per-intent, since
  not every operator turn should force a tool) and was judged out of scope
  for a same-day fix; this is a detect-and-retry backstop, the same
  established pattern this repo uses elsewhere (e.g. VTID-03824's
  `detectStillHereComplaint`) for a model-compliance gap that prompt
  wording alone hasn't reliably fixed.

OASIS_IMPACT: no — this changes turn-retry logic inside the existing
`/api/v1/operator/chat` handler; it emits no new OASIS events and changes
no existing event schema or topic.

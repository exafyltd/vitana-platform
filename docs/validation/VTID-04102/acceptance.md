# VTID-04102 — Acceptance

Found live while dispatching the Command Hub Autopilot reactivation task
spec (Part 1) into the Operator Console on staging — the first real,
multi-part task sent to it. The reply rendered "No response received"
despite the event trail showing a completed model call with real cost
(`deepseek/deepseek-flash`, 19.8s, 18,874 input / 4,096 output tokens,
$0.0053).

## Root cause

`callVertexWithTools()` (`gemini-operator.ts`, the operator's "plan" call)
hardcoded `maxTokens: 4096` — half the deepseek adapter's own default of
8000 — for a call whose system prompt carries the full bootstrap pack,
codebase-overview block, memory context and tool catalog, and which is
expected to plan multi-step tool use. `oasis_events` confirmed the model
spent its entire budget (`output_tokens: 4096`, exactly the cap) and
produced neither a parseable tool call nor any closing text
(`tool_calls: 0`, `operator_messages.content` empty) — consistent with the
output budget running out mid-generation before anything usable landed in
the response's `content` field.

The function then treated `r.ok: true` as sufficient to return
`{ reply: r.text || '', ... }` — an unconditional fallback to `''` with no
distinction between "the model said nothing" and "the model was cut off
mid-turn." That empty string propagated all the way to the Command Hub
with no error, no log marker beyond a generic `console.log`, and no
recovery.

## Fix

1. `maxTokens: 4096` → `8000` at both `callViaRouter('operator', ...)`
   call sites in `gemini-operator.ts` (the plan call and the tool-results
   call) — matches the router-wide default, reduces how often this
   truncation shape occurs at all.
2. When the plan call returns `ok:true` with neither tool calls nor text,
   it now throws (same as the pre-existing `!r.ok` branch immediately
   above it) instead of returning `{ reply: '' }`. The caller's existing
   `catch` (confirmed by reading the surrounding function) falls through
   to `processLocalRouting()` — the same real fallback the `!r.ok` branch's
   own comment already relies on — so an unusable "success" is now treated
   exactly like a failure, with a real (non-empty) reply and
   `meta.fallback_reason: 'llm_router_error'` recorded, instead of nothing.

## Acceptance criteria

AC-1: an `ok:true` router response with empty text and no tool calls
(the exact live shape: `output_tokens` pinned at the cap) does not
surface as an empty reply.
TEST: services/gateway/test/vtid-04102-operator-truncated-reply.test.ts —
"an ok:true response with no text and no tool calls (max_tokens
truncation shape) does not surface as an empty reply" — asserts
`res.reply` is non-empty and `res.meta.fallback_reason ===
'llm_router_error'`, proving it fell through the real fallback path
rather than some other code path happening to produce text.

AC-2: a normal, non-empty reply is unaffected by the new guard.
TEST: same file — "a normal non-empty reply is unaffected".

AC-3: the plan call requests the raised 8000-token budget, not the old
4096 cap.
TEST: same file — "the plan call requests an 8000-token budget, not the
old 4096 cap" — asserts the exact `maxTokens` value passed to
`callViaRouter`.

## Live verification

Root-caused directly from the live turn: queried `operator_threads`/
`operator_messages` (the VTID-04095 fix, merged minutes earlier, confirmed
working — both `user` and `assistant` rows recorded, at the same
timestamp) and `oasis_events` for the exact window
(`llm.call.started`/`llm.call.completed`/`operator.chat.message`),
matching `trace_id` across all three. `output_tokens: 4096` in the
`llm.call.completed` event payload is the load-bearing evidence — it is
not a plausible coincidence that the completion tokens exactly equal the
hardcoded cap on the one turn that rendered as empty.

## Not done here

- Not re-tested against a live staging turn after deploy — the next real
  operator-chat turn that would previously have truncated is the
  confirming signal (a real, non-empty reply instead of "No response
  received", or — if the model is still cut off even at 8000 tokens on a
  larger task — a visibly different, honest failure surfaced through
  `processLocalRouting()`'s fallback reply instead of silence).
- Did not investigate whether DeepSeek's response carries a separate
  `reasoning_content` field that the adapter's typed shape
  (`{ content?: string; tool_calls?: ... }`) does not read — if the model
  is spending its budget on chain-of-thought before ever reaching
  `content`, raising `maxTokens` helps but a `finish_reason==='length'`
  detection at the adapter level (surfaced to the caller, logged
  explicitly) would be a more complete fix. Flagged, not built — this
  VTID is scoped to the defect actually observed and reproduced.
- Did not audit other `callViaRouter(...)` call sites in this file (or
  elsewhere) for the same hardcoded-cap/silent-empty-reply shape — this
  VTID is scoped to the operator stage, where it was found live.

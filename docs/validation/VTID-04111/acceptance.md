# VTID-04111 — Acceptance

The Operator Console reported a failed execution: VTID-04109
("Operator: Add `autopilotActivateRecommendation(recommendationId)`
operator tool mirroring `autopilotApproveExecution`") stalled inside the
Dev Autopilot agent executor — DeepSeek answered with empty text three
turns in a row instead of calling a tool, and the runner gave up at turn 81
("model answered with text 3 times in a row without calling finish"). Its
own OASIS trail (`dev_autopilot.execution.failed`, `agent.error: model
stopped using tools`) confirmed a tool-call-compliance stall in that
pipeline, not a defect in the task itself. Implemented directly instead of
retrying the automated agent.

## What "activate a recommendation" means

The Command Hub's own Activate button already does this for a human click,
via `POST /recommendations/:id/activate`'s developer/admin branch
(`routes/autopilot-recommendations.ts`):

1. RPC `activate_autopilot_recommendation(p_recommendation_id, p_user_id)`
   — allocates a VTID, flips the recommendation to `status='activated'`;
   idempotent (a second call on an already-activated row just returns the
   existing VTID, no side effects).
2. `bridgeActivationToExecution(findingId, approvedBy)`
   (`dev-autopilot-execute.ts`, VTID-04108) — for a manually-bridgeable
   `source_type` (`isManuallyBridgeableSourceType`), generates a plan if
   none exists and creates the `dev_autopilot_executions` row with the
   cooldown skipped, so the next executor tick picks it up immediately.

This VTID adds the SAME two steps as an Operator Console chat tool,
`autopilot_activate_recommendation(recommendation_id)`, calling the
already-exported `bridgeActivationToExecution` directly (no duplication)
and a small local RPC caller for step 1 (the route's own `callRpc` helper
is private to that file). Deliberately NOT reproduced: the route's
`oasis_specs` markdown-draft generation and VTID-02935 alignment-telemetry
emission — both are non-fatal, best-effort UI/REST-path enrichments
(wrapped in their own try/catch there); this chat tool's job is to answer
"activate recommendation X" with a VTID and, where applicable, a running
execution, not to reproduce every side effect of the popup's own route
handler.

## Design — mirrors `autopilot_approve_execution` (VTID-04030)

Same shape and posture as its stated mirror target: one required id, the
identical VTID-03851 caller gate (`getThreadAuth`/`isExecuteTaskAuthorized`/
`describeExecuteTaskRefusal`), the same `operator-chat:<user_id>` actor
convention, and no read/list companion tool — the source task named exactly
one action tool, not a review/list pair the way VTID-04030 built three.

## Acceptance criteria

AC-1: the tool is registered (`tool-registry.ts`) requiring
`recommendation_id`, category `autopilot`, `vtid: 'VTID-04111'`, allowed
roles `['operator', 'admin', 'developer']`.
TEST: `services/gateway/test/vtid-04111-operator-activate-recommendation.test.ts`
— "registry: requires recommendation_id, correct role/category/vtid".

AC-2: the tool is declared on the operator wire schema (`gemini-operator.ts`,
`GEMINI_TOOL_DEFINITIONS`), dispatched to `executeActivateRecommendation`,
and imported from `operator-recommendation-tools.ts`.
TEST: same file — "operator wire schema: declared between reject and
cancel, dispatched to its handler, imported".

AC-3: both operator prompt sources (the served `PERSONALITY_DEFAULTS`
copy and the inline fallback) list the tool, route an explicit "activate
recommendation X" request to it, and forbid guessing which recommendation
is meant — kept byte-identical to each other per the VTID-03838 drift rule.
TEST: same file — the "VTID-04111 both operator prompt sources..." describe
block (3 tests, one per source plus the byte-identical execution-rules-block
check).

AC-4: the VTID-03851 caller gate runs before any Supabase read — an
anonymous or non-admin thread is refused, naming the tool, with zero calls
to `supa`/`bridgeActivationToExecution`.
TEST: same file — "refuses an anonymous thread and a non-admin thread,
naming the tool, without touching Supabase".

AC-5: the actor and user id recorded on the activation are derived from
the verified thread identity, never from a model-supplied argument.
TEST: same file — "derives the actor and user id from the verified
identity, never from the model".

AC-6: an unconfigured Supabase is reported as an error, not thrown.
TEST: same file — "reports an unconfigured Supabase instead of throwing".

AC-7: a missing or non-UUID `recommendation_id` is refused before any
Supabase call.
TEST: same file — "refuses a missing or non-UUID id before touching
Supabase".

AC-8: a fresh activation calls the RPC with the verified user id, emits
the `autopilot.recommendation.activated` OASIS event, and — only for a
manually-bridgeable `source_type` — calls `bridgeActivationToExecution`
and reports the execution id in the result.
TEST: same file — "calls the RPC, emits the OASIS event, and bridges for a
manually-bridgeable source_type".

AC-9: a fresh activation for a source_type OUTSIDE the manually-bridgeable
allowlist does not attempt to bridge.
TEST: same file — "does NOT bridge for a source_type outside the
manually-bridgeable allowlist".

AC-10: a bridge failure is surfaced in the result message without failing
the overall activation (the VTID was still allocated — that half
succeeded).
TEST: same file — "surfaces a bridge failure in the message without
failing the overall activation".

AC-11: an already-activated recommendation is idempotent — no OASIS event,
no bridge attempt, no source_type lookup at all.
TEST: same file — "does not emit an OASIS event and does not attempt to
bridge".

AC-12: an RPC transport failure and an RPC-level rejection (e.g.
recommendation not found, wrong status) are both reported as errors, never
thrown.
TEST: same file — the "VTID-04111 activate — failure surfaces" describe
block (2 tests).

## Verification

`tsc --noEmit` clean across the gateway service. New suite: 1/1 suite,
15/15 tests passing. Wider regression sweep (the sibling VTID-04030 tool
family + the VTID-03838 drift test + broader operator-chat suites this
touches): `test/vtid-04030-operator-approval-tools.test.ts`,
`test/vtid-03838-operator-prompt-lists-execute-tool.test.ts`,
`test/operator-chat-oasis.test.ts`,
`test/vtid-03926-operator-chat-userrole.test.ts`,
`test/vtid-04106-operator-chat-stick-to-bottom.test.ts` — 6/6 suites,
84/84 tests passing (15 new + 69 pre-existing), 0 regressions.

## Not done here

- Not yet verified against a live staging Operator Console turn — the next
  real signal is a chat message naming a real recommendation id producing
  `activate ok=true` with a VTID, and (for `community`/`health`/dev_autopilot*
  source types) a running execution.
- No Playwright screenshot pass: this is a backend service + operator-chat
  wire-schema change with no UI/markup component of its own — the Operator
  Console's chat surface itself is unchanged.
- No `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md`-style capability
  matrix update — out of scope for a single tool addition.

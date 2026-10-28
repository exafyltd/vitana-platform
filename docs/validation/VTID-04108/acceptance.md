# VTID-04108 — Acceptance (Part 1 of 3)

Part 1 of the VTID-04105 open-ended operator request: "Generalize the
recommendation activation bridge so every `autopilot_recommendations.
source_type` routes into the Dev Autopilot execution plane on activation,
not just `dev_autopilot`/`dev_autopilot_impact`... start writing a row to
the orphaned `autopilot_actions` table on every activation... AC: activate
a real, currently-community-or-health-sourced recommendation that
previously dead-ended at `spec_status='draft'`, and confirm it now
produces both a `dev_autopilot_executions` row and an `autopilot_actions`
row."

That request failed twice on the operator's own agentic executor,
exhausting its full 120-turn budget on pure discovery (65 `search_text` +
39 `read_file` + 6 `find_files` + 2 `list_dir`, zero `write_file`, no PR
opened) — an open-ended ask across an unfamiliar, large area of the
codebase. This session did the discovery instead and split the remaining
work into 3 concretely-scoped parts. Part 1 is below; Parts 2/3 are for
the Operator Console once this merges and deploys.

## Investigation — two hazards the literal spec text did not anticipate

**1. `autopilot_actions` is not an orphaned audit table — it's a
different, not-yet-launched feature.** Live schema inspection:

```
category CHECK (category = ANY (ARRAY['health','community','media','discover','calendar']))
priority CHECK (priority = ANY (ARRAY['high','medium','low']))
user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
```

`category`'s CHECK constraint is a fixed set of **product domains** for
user-facing recommended-action cards ("go for a walk", "join this
event"), not a coincidence with `autopilot_recommendations.source_type`
values — and `user_id` is a real, cascading FK to a specific user. Writing
system activation-audit rows here would (a) inject engineering bookkeeping
into a table a future "Recommended for you" feature will read as real
user content, and (b) hard-fail via the `user_id` NOT NULL/FK constraint
for every system-sourced recommendation (`dev_autopilot`, `operator_onramp`)
that has no owning user — the majority of what actually flows through this
bridge today. Zero rows exist in the table (confirmed live) because the
*feature* that would populate it hasn't shipped, not because it is scaffolding
safe to repurpose.

**2. `isExecutableSourceType()` is the SAME allowlist `autoApproveTick()`
polls for fully autonomous execution.** `autopilot-executable-source-types.ts`'s
own header comment: "Adding a new scanner... means adding its source_type
here in a code-reviewed PR." Widening it directly to include `community`/
`health` would silently arm the autonomous polling loop (subject only to
the global `kill_switch`/`auto_approve_enabled` config, not a code review)
against every existing `community`/`health` recommendation sitting at
`status='new'` — **307 rows measured live 2026-09-19** (305 community + 2
health) — the moment an operator next flips `auto_approve_enabled` true.
That is a categorically larger, unreviewed autonomy expansion than "a
human clicks Activate on one named recommendation," and exactly what
CLAUDE.md's NEVER rule 34 ("never enable autonomy without explicit
approval") and this file's own allowlist design exist to prevent.

## Fix — the safe version of the same intent

- New `MANUALLY_BRIDGEABLE_SOURCE_TYPES` / `isManuallyBridgeableSourceType()`
  (`autopilot-executable-source-types.ts`) — a SEPARATE, wider list
  (`EXECUTABLE_RECOMMENDATION_SOURCE_TYPES` + `community` + `health`).
  `EXECUTABLE_RECOMMENDATION_SOURCE_TYPES`/`isExecutableSourceType`/
  `executableSourceTypesPostgrestIn` are completely unchanged.
- New opt-in `ApprovalInput.allowManualSourceTypes` on `approveAutoExecute()`
  — only `bridgeActivationToExecution()` sets it `true`. Every other
  existing caller (both inside `autoApproveTick()`, the operator on-ramp,
  the two REST approve routes) is untouched and keeps today's exact,
  narrower behavior.
- `bridgeActivationToExecution()`'s own source_type gate switched from
  `isExecutableSourceType` to `isManuallyBridgeableSourceType`.
- The `POST /:id/activate` route's bridge trigger (previously a hardcoded
  `srcType === 'dev_autopilot' || srcType === 'dev_autopilot_impact'`
  check, narrower than the bridge function's own allowlist even before
  this VTID) now calls the same `isManuallyBridgeableSourceType()`.
- The existing `dev_autopilot.execution.bridged` OASIS event (already the
  de facto activation-audit trail — fired on every successful bridge) is
  enriched with `source_type`, making a human activation of a community/
  health recommendation durably queryable via `oasis_events` without
  writing into the mismatched `autopilot_actions` table.

## Acceptance criteria

AC-1: `isManuallyBridgeableSourceType()` accepts everything
`isExecutableSourceType()` does, plus `community`/`health`, and rejects
everything else.
TEST: `test/vtid-04108-manual-activation-source-types.test.ts` — "accepts
every source_type isExecutableSourceType accepts", "additionally accepts
community and health", "still REJECTS source types outside both lists".

AC-2: the narrow, autonomous-loop-facing allowlist is byte-for-byte
unchanged by this VTID.
TEST: same file — "the narrow allowlist is untouched by this VTID
(autonomous-loop regression guard)" describe block (3 tests, incl. a
direct assertion that `executableSourceTypesPostgrestIn()` — what
`autoApproveTick()` polls — never contains `community`/`health`).

AC-3: `bridgeActivationToExecution()` uses the wider predicate for its own
gate and passes `allowManualSourceTypes: true` to `approveAutoExecute()`.
TEST: `test/vtid-04108-manual-activation-call-sites.test.ts` — "gates its
own source_type check on isManuallyBridgeableSourceType...", "passes
allowManualSourceTypes: true to approveAutoExecute".

AC-4: the bridged-execution OASIS event carries `source_type`.
TEST: same file — "enriches the dev_autopilot.execution.bridged OASIS
event payload with source_type".

AC-5: `autoApproveTick()` never references the wider allowlist or the new
opt-in flag anywhere in its body.
TEST: same file — "autoApproveTick — never opts into the wider allowlist
(the invariant this VTID exists to protect)" describe block (2 tests).

AC-6: the `/activate` route uses the shared predicate instead of its old,
narrower hardcoded check.
TEST: same file — "routes/autopilot-recommendations.ts..." describe block
(2 tests).

## OASIS traceability

OASIS_PROOF: the pre-existing `dev_autopilot.execution.bridged` OASIS
event (a real state-transition event, not polling — fired once per
successful activation-to-execution bridge) gains one new payload field,
`source_type`. No new event type, no new topic, no change to when the
event fires or what triggers it — the same `emitOasisEvent()` call site
in `bridgeActivationToExecution()`, same conditions. Verify post-merge:
`SELECT payload->>'source_type', message FROM oasis_events WHERE type =
'dev_autopilot.execution.bridged' ORDER BY created_at DESC LIMIT 5;` — the
`source_type` field should be present and non-null on every row emitted
after this deploys.

## Verification

`tsc --noEmit` clean across the gateway service. Targeted regression
sweep: 11 suites, 138 tests passing — the 9 pre-existing suites that touch
`bridgeActivationToExecution`/`isExecutableSourceType`/`autoApproveTick`
(121 tests) are unmodified and stayed green, confirming this change is
additive, not a behavior change to any existing caller.

Mutation-verified: stashed all three source edits, re-ran the 2 new test
files — 12 of 17 tests failed (the other 5 pass trivially since they only
assert the narrow, pre-existing allowlist is unchanged) — restored the
stash and confirmed all 17 green again.

## Not done here (Parts 2 and 3, for the Operator Console)

**Part 2:** add an `autopilot_activate_recommendation(recommendation_id)`
operator tool mirroring `autopilot_approve_execution`'s shape (tool
registry, wire schema, dispatch, both prompt sources per the VTID-03838
drift rule; same VTID-03851 caller-gate posture) — so an operator can
trigger this now-widened bridge from chat for a specific dead-ended
`community`/`health` recommendation, rather than only via the frontend's
own Activate button.

**Part 3:** the actual live AC — once Part 2 (or the existing frontend
Activate button) is used against a real `community`/`health` recommendation
currently at `status='new'`/`spec_status='draft'`, confirm a
`dev_autopilot_executions` row is produced and the enriched
`dev_autopilot.execution.bridged` event carries the correct `source_type`
in `oasis_events`. Not verified against live staging/production traffic in
this session.

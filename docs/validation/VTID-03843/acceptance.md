# VTID-03843 — Self-heal child executions inherit the parent on-ramp LLM override

## Report

VTID-03820 stamps `metadata.llm_on_ramp` and `metadata.llm_on_ramp_override`
onto an operator-triggered execution so `runExecutionSession()` routes the
worker LLM call at the provider/model the operator asked for.
`extractLlmOnRampOverride()` (`dev-autopilot-execute.ts`) reads that override
from the metadata of the execution row being run.

When such an execution fails and the self-healing bridge spawns a retry child
(`spawnChildExecution()` in `dev-autopilot-bridge.ts`), the child row was
inserted with a fresh metadata object — `source`, `parent_execution_id`,
`triage_session_id`, `triage_confidence` — and nothing from the parent. The
retry therefore ran on whatever the worker routing policy said, not on the
on-ramp override. Observed live on staging 2026-09-13: execution `beeb2c55`
(on-ramp, `llm_on_ramp: deepseek`) was reclaimed by the watchdog; its child
`fb3d86f8` carried no override and ran its worker call on the Bedrock policy
primary (recorded in `docs/validation/VTID-03841/outputs/staging-observation-2026-09-13.txt`).

Fix: a new pure helper `inheritedOnRampMetadata(parent.metadata)` returns
only the two on-ramp keys (a non-empty string `llm_on_ramp`, a plain-object
`llm_on_ramp_override`), and `spawnChildExecution()` spreads it into the
child metadata **before** the bridge's own identity fields, so the child keeps
`source: 'dev-autopilot-bridge'` and never carries the parent's `source`,
`triggered_by`, `bridge_stage`, `merge_sha` or any other per-attempt field.
Malformed override shapes (array, string, empty string, number) are dropped,
never forwarded. An autonomous (non-on-ramp) parent produces a child whose
metadata is byte-identical to before this change.

## Acceptance Criteria

AC-1 — A child of an on-ramp parent carries the parent's `llm_on_ramp` and
`llm_on_ramp_override` verbatim in its INSERT body.

TEST: `test/vtid-03843-selfheal-child-inherits-onramp-override.test.ts` —
"copies llm_on_ramp and llm_on_ramp_override from the parent metadata verbatim".

AC-2 — Only those two keys are inherited: the child's `source` stays
`dev-autopilot-bridge`, and no other parent metadata key leaks in.

TEST: same file — "keeps the bridge identity fields — the parent source never
leaks into the child" (asserts the exact key set of the child metadata).

AC-3 — A child of a non-on-ramp parent is unchanged (no override keys, same
four bridge keys as before).

TEST: same file — "a child of an autonomous (non-on-ramp) parent carries no
override keys — self-healing path byte-identical".

AC-4 — A parent with null metadata still spawns cleanly.

TEST: same file — "a parent with null metadata still spawns cleanly".

AC-5 — Malformed on-ramp shapes are dropped rather than forwarded.

TEST: same file — "drops a malformed override (array / string / empty on-ramp)
instead of forwarding junk"; "returns {} for null/undefined/non-object input".

AC-6 — No regression: `tsc --noEmit` clean; existing bridge suites green; full
gateway suite green.

TEST: `outputs/tsc-noemit.txt` (exit 0); `outputs/jest-scoped-bridge.txt`
(new suite + `dev-autopilot-bridge.test.ts` + `self-healing-injector-autopilot-bridge.test.ts`);
`outputs/jest-full-suite-tail.txt`.

## Not verified here

Not observed against a live retry on staging — producing one requires an
on-ramp execution to fail first, and re-sending the VTID-03829 on-ramp request
would create a duplicate finding and execution. The next real on-ramp failure
on staging is the first live exercise: its bridge child must show
`metadata.llm_on_ramp_override` and its `llm.call.*` events must name the
override provider, not the worker policy primary.

# VTID-04002 — Operator Console gap analysis + on-ramp fixes from Test Run #1

## Report

See `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` for the analysis. This PR also
ships the two on-ramp gaps Test Run #1 (VTID-03955, execution 0643b701, PR #3351)
surfaced, corrected: the second gap is the whole VALIDATOR-CHECK contract, not only
the missing VTID.

## Acceptance Criteria

AC-1 — `autopilot_execute_task`'s schema (operator wire definition and ORB registry) and
both operator prompt sources state that every `files_referenced` entry must be a
repo-root-relative path, with an example, and the two prompt sources stay identical.
TEST: services/gateway/test/vtid-03838-operator-prompt-lists-execute-tool.test.ts (drift + rule assertions, unchanged, still green)

AC-2 — An on-ramp rejection returned to the chat carries the safety-gate violation
code and the offending path(s), not only "safety gate blocked approval".
TEST: services/gateway/test/vtid-03820-operator-execution-onramp.test.ts (violations propagated to the on-ramp result); rendering verified by `tsc --noEmit` + manual read of `describeOnRampRejection()`

AC-3 — A dev-autopilot PR for a finding with an `activated_vtid` gets: the VTID in the
title, a body starting with `VTID: VTID-XXXXX` plus `VALIDATION_PROFILE:`,
`SCOPE_ALLOWLIST:`, `ACCEPTANCE:`, `MERGE_PAYLOAD_PREVIEW:`, `OASIS_IMPACT:`, and a
`docs/validation/<VTID>/{acceptance.md,commands.log,outputs/}` pack whose AC lines each
map to a `TEST:` within 12 lines — i.e. every text gate of VALIDATOR-CHECK.yml.
TEST: services/gateway/test/dev-autopilot-pr-contract.test.ts (18 tests; ports the workflow's grep/regex gates)

AC-4 — Without a real VTID the contract is skipped with a logged reason and the PR
title/body are unchanged (no synthetic `VTID-DA-` id is ever stamped).
TEST: services/gateway/test/dev-autopilot-pr-contract.test.ts ("does nothing (and says why) when the finding has no real VTID")

AC-5 — Existing executor parser/prompt behaviour is unchanged.
TEST: services/gateway/test/dev-autopilot-execute.test.ts, services/gateway/test/dev-autopilot-safety.test.ts, services/gateway/test/dev-autopilot-runexec-pr-flood-guard.test.ts, services/gateway/test/vtid-03844-outcomes-record-operator-onramp.test.ts (all green, unmodified)

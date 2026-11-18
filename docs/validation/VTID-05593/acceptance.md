# VTID-05593 — Acceptance (pr-gate-policy-sparring-record / policy-approval-record)

Scope: `evaluateSparringRecord` in `scripts/ci/pr-gate/lib.mjs` and its tests in `scripts/ci/pr-gate/__tests__/lib.test.mjs`.
Nothing deploys. MERGE_PAYLOAD_PREVIEW: the PR-GATE sparring check also accepts a policy-approved record.

AC-1 — A record with an owner-approval line, a verdict and a plan hash still passes.
  TEST: scripts/ci/pr-gate/__tests__/lib.test.mjs "sparring record needs verdict, owner approval and plan hash".

AC-2 — A record that says "approved by policy `converged-auto-v1`" with a CONVERGED verdict and a plan hash passes.
  TEST: scripts/ci/pr-gate/__tests__/lib.test.mjs "sparring record accepts a policy approval only for CONVERGED with the exact policy and a plan hash".

AC-3 — An ESCALATED record with the policy line, and a record naming any other policy, fail.
  TEST: scripts/ci/pr-gate/__tests__/lib.test.mjs "sparring record accepts a policy approval only for CONVERGED with the exact policy and a plan hash".

AC-4 — A policy-approved CONVERGED record without a plan hash returns exactly `no plan hash`; a record with neither approval fails with a message naming both forms; `CONVERGED` alone still has 2 problems.
  TEST: scripts/ci/pr-gate/__tests__/lib.test.mjs "sparring record accepts a policy approval only for CONVERGED with the exact policy and a plan hash".

AC-5 — The new test fails on base and passes with the change.
  TEST: docs/validation/VTID-05593/commands.log (red: 1 failed of 16; green: 16 passed).

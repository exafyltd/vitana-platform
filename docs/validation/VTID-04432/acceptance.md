# VTID-04432 — per-agent eval suites for the delegate_to_agent specialists

Orchestrator v2 plan §5 P7 "per-agent evaluation suites gated in CI". Scripted
model, real specialist entry point, real `runStageToolLoop`, real tool executor,
in-memory fixture store holding the caller's data and a second user's. Gated in
CI by the gateway jest job; no workflow change needed.

AC-1 Every support-specialist case (14) passes.
TEST: services/gateway/test/services/orchestrator/vtid-04432-specialist-evals.test.ts

AC-2 Every commerce-specialist case (12) passes.
TEST: services/gateway/test/services/orchestrator/vtid-04432-specialist-evals.test.ts

AC-3 Invariants hold on every case: reads pinned to the caller, no other user's
data surfaced, tool budget kept, final call offered no tools, findings bounded
with the "not a script" note, signed-out caller never reaches the model, a failed
run carries no result.
TEST: services/gateway/test/services/orchestrator/vtid-04432-specialist-evals.test.ts

AC-4 The harness fails a deliberately unscoped, leaking or unbounded specialist
(mutation checks), so the passes are not vacuous.
TEST: services/gateway/test/services/orchestrator/vtid-04432-specialist-evals.test.ts

AC-5 Case ids are unique and every case states what it checks.
TEST: services/gateway/test/services/orchestrator/vtid-04432-specialist-evals.test.ts

## Not measured
Whether a live model picks the right tool or words its findings well. That needs
a live-model run with a grader against staging, which is blocked while staging
cannot place tasks. These cases are the deterministic floor under such a run.

## OASIS
No OASIS impact: test-only code under src/services/orchestrator/evals/ plus a
jest suite; no runtime path imports it, no event is emitted.

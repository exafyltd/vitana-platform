# VTID-04935 — Deterministic concurrency check for compileAssistantDecisionContext

The `parallel execution` test proved concurrency by asserting the order in which 5/10/15/20/25 ms timers fired. On a loaded CI runner that order can change. It failed once on PR #3898 (`Gateway (Jest)`, 2026-10-03) and passed when re-run. The test now records each provider's start, and every provider waits on one gate that opens only when all five have started. A 3 s guard turns a sequential regression into a named failure. There is no source change. Plan sparring record: `plan-sparring.md`.

AC-1: All five providers start before any finishes. The five outputs equal their stubs, with the same `expect(out.*)` assertions as before.
TEST: services/gateway/test/orb/context/compile-assistant-decision-context.test.ts

AC-2: The test is deterministic. It passed 50 repetitions in one Jest process, and 50 more while the ORB suite loaded the CPU.
TEST: services/gateway/test/orb/context/compile-assistant-decision-context.test.ts

AC-3: Awaiting the providers sequentially (mutation at `src/orb/context/compile-assistant-decision-context.ts:96`) fails the test with "providers were not started concurrently" after 3 s. The source was restored afterwards.
TEST: services/gateway/test/orb/context/compile-assistant-decision-context.test.ts

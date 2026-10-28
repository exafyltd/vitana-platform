# VTID-04600 — acceptance

AC-1 Layer A runs the real memory code for 64 scenarios across all ten categories and passes.
TEST: services/gateway/test/memory-verification-conformance.test.ts
Evidence: outputs/layer-a-run.txt (129 passed).

AC-2 The five behaviours that are wrong today are recorded as known gaps and run as it.failing, so fixing one turns CI red until its marker is removed.
TEST: services/gateway/test/memory-verification-conformance.test.ts
Gaps: A-PROF-08, A-DUP-02, A-DUP-03, A-CONF-09, A-FORG-01 (see docs/memory/MEMORY-VERIFICATION-SUITE.md).

AC-3 The suite catches regressions: five deliberate breakages of the memory code each make it fail.
TEST: services/gateway/test/memory-verification-conformance.test.ts
Evidence: commands.log (mutation check).

AC-4 The fakes match the live system where it matters: write_fact semantics, the role filter of memory_semantic_search, and the memory broker flag.
TEST: services/gateway/test/memory-verification-conformance.test.ts
Evidence: commands.log (live reads).

AC-5 Scenarios are data: adding a case needs no code, and `npm run test:memory` runs the layer.
TEST: services/gateway/test/fixtures/memory-verification/conformance.json

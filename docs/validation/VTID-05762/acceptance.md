# VTID-05762 — acceptance (sparring-eu-guard, lane sparring-eu-guard)

Plan: `.kiro/specs/sparring-eu-guard/plan.md` (merged in #4996; sparring converged in round 2, policy approved).

| Criterion | Evidence |
|---|---|
| C1: DeepSeek direct-API tier off unless the flag is exactly `true` | `services/gateway/test/plan-sparring/sparring-eu-guard.test.ts` (C3a, C3b, non-`true` values) |
| C2: no default Bedrock region in `providers/bedrock.ts` and `services/dev-memory-embedding.ts` | `services/gateway/test/providers/bedrock-region.test.ts` (C3c: `not_configured`, no client, no request) |
| Red before change | the two new suites: 7 failures on `main`, 0 after the change |
| No regression | related suites: 1002/1002 passing; `tsc` reports no errors in the changed files |
| Explicit regions in affected suites | four existing suites set `AWS_REGION`; `vtid-04868-plan-sparring-service.test.ts` enables the flag for its own cases; assertions unchanged |

Staging: none. The change is in the sparring service. It runs in the gateway on merge; no production write is made by this change.

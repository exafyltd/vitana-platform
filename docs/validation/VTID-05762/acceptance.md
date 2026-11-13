# VTID-05762 — acceptance (sparring-eu-guard, lane sparring-eu-guard)

Plan: `.kiro/specs/sparring-eu-guard/plan.md` (merged in #4996; sparring converged in round 2, policy approved).

AC-01 — C1: the DeepSeek direct-API last-resort tier is off unless PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED is exactly 'true'.
TEST: services/gateway/test/plan-sparring/sparring-eu-guard.test.ts (C3a unset, C3b 'true', non-'true' values)

AC-02 — C2: no default Bedrock region in providers/bedrock.ts and services/dev-memory-embedding.ts. With neither AWS_BEDROCK_REGION nor AWS_REGION set, both return not_configured and send no request.
TEST: services/gateway/test/providers/bedrock-region.test.ts (C3c)

AC-03 — No regression: the sparring chain (with the DeepSeek tier enabled for its own cases) and the affected Bedrock callers (region set explicitly) still pass with assertions unchanged.
TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts, test/vtid-04868-plan-sparring-stage.test.ts, test/services/dev-memory-embedding.test.ts, test/providers/bedrock-vision-tools.test.ts

Evidence: outputs/jest-sparring-eu-guard.txt (107 of 107 passing). Commands: commands.log.
Staging: none beyond the suites in staging-tests.json. The change runs in the gateway on merge; it makes no production write.

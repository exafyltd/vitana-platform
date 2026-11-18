# Sparring round 2 — converged

Session: `2a196dea-a356-4a81-92d2-aaf696113d6a` · plan hash `f745b9bc55ab0a4e20f06f8f5518c52061ab5abd0427325189ff0eba7b9a5ce2`

## Summary

All three R1 findings were accepted and properly addressed in the revised plan. R1-F1: §7 now explicitly states A2 has no CI path before the cut. R1-F2: §9 adds the `retire-vtid-allocate` lane and explains its role. R1-F3: premises now use full repo-relative paths. I verified six premises against the code and found one new minor issue. The revised plan is substantially sound.

## Findings

### R2-F1 [minor]

Phase 0 P2 says 'keep Opus 4.6 and Sonnet 4.6 enabled' but does not include verifying that Opus 4.6 can actually be invoked on Bedrock. The code at `llm-defaults.ts:99-113` carries an explicit 'UNVERIFIED PLACEHOLDER' warning stating the Opus 4.6 inference profile ID 'has NOT been resolved (`aws bedrock list-inference-profiles`) and has NOT been invoked for real.' The plan's delivery chains (§11 partner, §12 review class B) list Opus 4.6 as the first fallback after Opus 5.5. If both 5.5 models are quota-limited or not yet enabled, the chain's first reachable model is Sonnet 4.6 (which IS verified per line 124: 'one of the 3 Anthropic profiles verified to actually invoke in eu-central-1'). Two failed fallback steps before a working model is reached adds latency and noisy logs.

- `exafyltd/vitana-platform:services/gateway/src/constants/llm-defaults.ts:96` — * !!! UNVERIFIED PLACEHOLDER — DO NOT TRUST UNTIL THE IF-THEN 31 INVOKE TEST
 * !!! HAS PASSED. The exact eu.* inference-profile id for Opus 4.6 in
 * !!! eu-central-1 has NOT been resolved (`aws bedrock list-inference-profiles`)
 * !!! and has NOT been invoked for real.
- `exafyltd/vitana-platform:services/gateway/src/constants/llm-defaults.ts:122` — * around. Sonnet 4.6 is one of the 3 Anthropic profiles
 * verified to actually invoke in eu-central-1 (backend §2b) and has no
 * fresh-subscription daily cap

Suggestion: Add a step to Phase 0 P2 (or a sub-step of P3): in the engineering account, run `aws bedrock list-inference-profiles --region eu-central-1`, resolve the exact Opus 4.6 profile ID, and invoke it once with a trivial prompt to confirm it serves. Record the verified profile ID. This removes a known unknown from the fallback chain before any delivery lane depends on it.

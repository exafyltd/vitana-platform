# Tasks — sparring-model-fallback

<!-- lane: partner-fallback-code -->
## Lane: partner-fallback-code

Gateway code change implementing the throttle-only Sonnet 4.6 fallback and per-model request-shape gating.

- [ ] T1 — `services/gateway/src/constants/llm-defaults.ts`: add `PLAN_SPARRING_FALLBACK_MODEL`
  (env `PLAN_SPARRING_FALLBACK_MODEL`, default `eu.anthropic.claude-sonnet-4-6`) + a resolver, and a
  comment that NO_FALLBACK_STAGES['plan_sparring'] still bars router-level fallback; this constant is used
  only by the partner pass's explicit throttle retry.
  Acceptance (R1,R3): primary resolver unchanged (Opus 4.6); new fallback resolver returns Sonnet 4.6;
  NO_FALLBACK_STAGES unchanged.

- [ ] T2 — `services/gateway/src/providers/bedrock.ts`: add a per-model allowed-fields helper and have
  `buildBedrockRequestBody` only spread `output_config`/`thinking` the model accepts. Verify Sonnet 4.6's
  acceptance of `output_config.effort` with a real invoke before fixing the table.
  Acceptance (R4): Opus 4.6 body includes `output_config.effort`; a model marked as not accepting it gets a
  body without `output_config`; unknown models default conservative.

- [ ] T3 — `services/gateway/src/services/plan-sparring/partner.ts`: in `runPartnerPass`, on a retryable
  throttle (`/too many tokens per day/i` or throttling/rate-limit), retry the turn ONCE on
  `PLAN_SPARRING_FALLBACK_MODEL` with the model-gated shape; push a modelLog entry + WARN; keep all other
  failures ending the pass as `model_unavailable`; keep the `provider !== 'bedrock'` refusal.
  Acceptance (R2,R3): throttle → one fallback retry → round proceeds on success; non-throttle → no retry;
  non-bedrock fallback refused.

- [ ] T4 — `services/gateway/test/vtid-xxxxx-sparring-model-fallback.test.ts`: cover R5(a)-(d) with injected
  `callLlm` fakes. Run `npx tsc --noEmit` and the plan-sparring regression suites green.
  Acceptance (R5): all four cases asserted and passing.

- [ ] T5 — Validation evidence under `docs/validation/<VTID>/`: copy the sparring record, add `scope.json`
  and `acceptance.md` mapping AC-1..AC-6 to the tests, and a read-only `staging-tests.json` for R6.
  Acceptance (R6): staging suite re-pushes a stuck plan read-only and shows the Sonnet 4.6 fallback in the
  round's modelLog on an Opus 4.6 throttle.

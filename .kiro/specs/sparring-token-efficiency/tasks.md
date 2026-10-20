# Tasks — sparring-token-efficiency

<!-- lane: partner-caching-code -->
## Lane: partner-caching-code

Gateway code: Bedrock prompt caching for `plan_sparring`, cache usage in `modelLog`, right-sized output and tool
results, and the per-session token budget with reason `token_budget`. Executor kiro (seat jtadic), reviewer hotmail.
Depends on `plan-spar-reasons`.

Allowed paths:
- services/gateway/src/providers/bedrock*.ts
- services/gateway/src/services/llm-router.ts
- services/gateway/src/services/llm-telemetry-service.ts
- services/gateway/src/types/llm-telemetry.ts
- services/gateway/src/services/plan-sparring/**
- services/gateway/src/constants/llm-defaults.ts
- services/gateway/test/plan-sparring-*.test.ts

- [ ] T0: Read `model_log` output_tokens of recent sparring sessions read-only (no writes). Pick the
  `PARTNER_MAX_OUTPUT_TOKENS` default: 8,000, or 12,000 if any ok turn exceeded 6,000. Record the numbers in the PR body.
  Acceptance (R3.1): the chosen default and the evidence are in the PR.
- [ ] T1: `llm-defaults.ts`: add `planSparringPromptCacheEnabled()`, `resolvePartnerMaxOutputTokens()`,
  `resolvePlanSparringSessionTokenBudget()` and `CLAUDE_OUTPUT_BURNDOWN`.
  Acceptance (R1.1, R3.1, R4.1): env parsing and clamps are unit-tested; `NO_FALLBACK_STAGES` is unchanged.
- [ ] T2: `providers/bedrock.ts`: add `prompt_cache` to the request, place the markers in `buildBedrockRequestBody`,
  and add `parseBedrockUsage` with the cache fields.
  Acceptance (R1.2, R1.3, R2.1): T-a, T-b, T-c pass.
- [ ] T3: `llm-router.ts`: pass `promptCache` through and map the cache usage in `bedrockAdapter`; forward the cache tokens to
  `completeLLMCallDetached` and add them (optional) to `CompleteLLMCallResult` / `buildLLMCallCompleted` in
  `llm-telemetry-service.ts`, declaring `cache_read_input_tokens?` / `cache_creation_input_tokens?` on
  `LLMTelemetryPayload` in `types/llm-telemetry.ts`. Other adapters stay untouched.
  Acceptance (R1.4, R2.1): T-d passes; `npm run test:operator` and the router tests stay green.
- [ ] T4: `plan-sparring/types.ts`, `partner.ts`, `github-tools.ts`, `plan-sparring-service.ts`: add the
  `promptCache` opt, the right-sized caps, `quota_tokens` logging, the budget check before every invoke, the exported `READ_FILE_MAX_LINES = 250`, the 0-token throttle accounting comment, the `token_budget` reason, and the exported `RETRYABLE_REASONS` including it.
  Acceptance (R2.2, R3, R4.1, R4.2): T-e, T-f, T-g, T-h pass.
- [ ] T5: `services/gateway/test/plan-sparring-token-efficiency.test.ts` covers T-a..T-h with fakes only. Run it with
  `npx tsc --noEmit` and the `vtid-04868-plan-sparring-*` suites.
  Acceptance (R5): all green.
- [ ] T6: Add `docs/validation/<VTID>/staging-tests.json` (read-only: build-info, `/alive`, `GET /api/v1/plans/spar/<id>`
  of an existing session), plus `scope.json` and `acceptance.md`.
  Acceptance (R6.1): STAGING-VERIFY green. Gate 2 evidence (R6.2) is collected read-only from the first CI round on the
  new build.

<!-- lane: plan-spar-reasons -->
## Lane: plan-spar-reasons

Governance path, so the executor is claude. Teach the CI driver that `token_budget` is a retryable partner-side
stop, so a budget escalation never uses up one of a plan's 2 sessions. Merges before `partner-caching-code`.

Allowed paths:
- scripts/collab/plan-spar.mjs
- scripts/collab/plan-spar.test.mjs

- [ ] C1: `plan-spar.mjs` :32-33: add `'token_budget'` to `INFRA_REASONS` and `RETRYABLE_REASONS`. Rebase on PR
  #4186 if it lands first (same lines).
  Acceptance (R4.3): an escalated session with `['token_budget']` is written as `infra: true, retryable: true`.
- [ ] C2: Add a `plan-spar.test.mjs` case: a `token_budget` escalation leads the next run to action `retry`, and
  `state.sessions.length` is unchanged.
  Acceptance (R4.3, R5.2): `node --test scripts/collab/plan-spar.test.mjs` is green.

## Escalation carry-over (owner approved escalated, 2026-10-20)

The plan was round-capped and escalated (session `b2df0328`, round 3); the owner approved it as escalated on
2026-10-20 ("yes, A all 4 approved"). The open last-round findings are folded into the lane tasks here; `plan.md`
is unchanged.

- R3-F1 [major] — "T-d has no assertion that the `void completeLLMCallDetached(ctx, {…})` call inside
  `callViaRouter` actually passes `cacheReadTokens`/`cacheWriteTokens`."
  Lane `partner-caching-code`, added task:
  - [ ] T3a: In T-d, spy on `completeLLMCallDetached` (`jest.spyOn` or a mock of the `llm-telemetry-service` module)
    and assert the call made inside `callViaRouter` (`llm-router.ts` ~:1325) receives `cacheReadTokens` and
    `cacheWriteTokens` equal to the values the mocked Bedrock response returned.
    Acceptance (R1.4, R2.1, carry-over R3-F1): T-d fails if the cache fields are dropped from the
    `completeLLMCallDetached` spread, even when `result.usage` carries them.

# Tasks — sparring-token-efficiency-r2 (re-plan of sparring-token-efficiency)

Authoritative plan: `plan.md`. VTIDs are allocated by CI PLAN-SPAR after policy approval. `partner-budget` and
`plan-spar-reasons` change protected gate files (`scripts/collab/protected-gate-files.json`). They merge only on the
owner's instruction naming this plan, plus a reviewer-agent accept on the current head (`collaboration.md` §3a, §7b).

<!-- lane: llm-cache-telemetry -->
## Lane: llm-cache-telemetry

This lane covers the unprotected gateway half: Bedrock prompt caching through the router, cache usage on
`LLMUsage` and in OASIS telemetry, and the env resolvers. Executor kiro (seat jtadic), reviewer agent. No dependency.

Allowed paths:
- services/gateway/src/providers/bedrock*.ts
- services/gateway/src/services/llm-router.ts
- services/gateway/src/services/llm-telemetry-service.ts
- services/gateway/src/types/llm-telemetry.ts
- services/gateway/src/constants/llm-defaults.ts
- services/gateway/test/llm-cache-telemetry.test.ts

- [ ] L1: `llm-defaults.ts`: add `planSparringPromptCacheEnabled()`, `resolvePartnerMaxOutputTokens()`,
  `resolvePlanSparringSessionTokenBudget()` and `CLAUDE_OUTPUT_BURNDOWN`.
  Acceptance: env parsing and clamps are unit-tested, and `NO_FALLBACK_STAGES` is unchanged.
- [ ] L2: `providers/bedrock.ts`: add `prompt_cache` to the request, place the markers in `buildBedrockRequestBody`
  (`:267`), and add `parseBedrockUsage` with the cache fields.
  Acceptance: T-a, T-b and T-c pass.
- [ ] L3: `llm-router.ts`:
  - Pass `promptCache` through `callViaRouter` (`:1169`).
  - Map the cache usage in `bedrockAdapter` (`:997`, usage `:1064`).
  - Forward the cache tokens to `completeLLMCallDetached` (`:1346`).
  - Add them as optional fields to `CompleteLLMCallResult` and `buildLLMCallCompleted` (`:170`, literal `:184`).
  - Declare `cache_read_input_tokens?` and `cache_creation_input_tokens?` on `LLMTelemetryPayload`.
  Acceptance: T-d passes, including the R3-F1 telemetry spy. `npm run test:operator`, the router tests and
  `npx tsc --noEmit` stay green.
- [ ] L4: Add `docs/validation/<VTID>/` (`scope.json`, `staging-tests.json`: read-only build-info and `/alive`).
  Acceptance: STAGING-VERIFY is green.

<!-- lane: partner-budget -->
## Lane: partner-budget

This lane covers the protected half, `services/gateway/src/services/plan-sparring/**`: the `promptCache` opt on
Bedrock tiers, the right-sized caps, `quota_tokens` (Bedrock only), the budget check before every tier invoke, the
`token_budget` reason and the exported `RETRYABLE_REASONS`. Executor claude. While Claude Code is unavailable, the
exceptions seat `exafyltd` builds it (§7). It merges only on the owner's instruction naming this plan. It depends on
`llm-cache-telemetry` and `plan-spar-reasons`.

Allowed paths:
- services/gateway/src/services/plan-sparring/**
- services/gateway/test/plan-sparring-token-efficiency.test.ts

- [ ] P0: Read the `model_log` output_tokens of recent sparring sessions, read-only, and pick the
  `PARTNER_MAX_OUTPUT_TOKENS` default: 8,000, or 12,000 if any ok turn exceeded 6,000.
  Acceptance: the chosen default and its evidence are in the PR body.
- [ ] P1: Make these changes in `types.ts`, `partner.ts`, `github-tools.ts` and `plan-sparring-service.ts`:
  - `promptCache` only on the `primary` and `bedrock_fallback` tiers.
  - The single `modelLog.push` (`partner.ts:181`) fills `cache_read_tokens`, `cache_write_tokens` and
    `quota_tokens`. `quota_tokens` is 0 for `provider !== 'bedrock'`.
  - The budget check runs before every `invoke(prompt, tier)`.
  - `READ_FILE_MAX_LINES = 250`, exported.
  - `TOOL_RESULT_MAX_CHARS = 12_000`.
  - The `token_budget` reason, and `RETRYABLE_REASONS` exported with it.
  - The service sums `priorQuotaTokens` at `:404`.
  Acceptance: T-e, T-f, T-f', T-g and T-h pass.
- [ ] P2: `services/gateway/test/plan-sparring-token-efficiency.test.ts` covers T-e..T-h and T-f' with fakes only.
  Acceptance: all green, together with the `vtid-04868-plan-sparring-*` suites and `npx tsc --noEmit`.

<!-- lane: plan-spar-reasons -->
## Lane: plan-spar-reasons

`scripts/collab/plan-spar.mjs` is a protected gate file, so the executor is claude, with the exceptions seat as the
fallback. The lane teaches the CI driver that `token_budget` is a retryable partner-side stop, so a budget escalation
never uses up one of a plan's 2 sessions. It merges before `partner-budget`, on the owner's instruction naming this
plan.

Allowed paths:
- scripts/collab/plan-spar.mjs
- scripts/collab/plan-spar.test.mjs

- [ ] C1: In `plan-spar.mjs` `:43-44`, add `'token_budget'` to `INFRA_REASONS` and `RETRYABLE_REASONS`.
  Acceptance: an escalated session with `['token_budget']` is written as `infra: true, retryable: true`.
- [ ] C2: Add a `plan-spar.test.mjs` case: after a `token_budget` escalation, the next run's action is `retry` and
  `state.sessions.length` is unchanged.
  Acceptance: `node --test scripts/collab/plan-spar.test.mjs` is green, and the case is red on `origin/main`.

## Escalation carry-over (from `sparring-token-efficiency`, session `b2df0328`, round 3)
Each finding is answered in `plan.md` under "Re-plan answers". The tasks carry the acceptance.
- R3-F1 [major], verbatim: "T-d has no assertion that the `void completeLLMCallDetached(ctx, {…})` call inside
  `callViaRouter` actually passes `cacheReadTokens`/`cacheWriteTokens`. At the pinned commit that call
  (llm-router.ts:1326-1330) passes only `{ inputTokens: result.usage?.inputTokens, outputTokens:
  result.usage?.outputTokens, fallbackUsed }`."
  Task: `llm-cache-telemetry` L3.
  Acceptance: T-d mocks `llm-telemetry-service` and asserts that `completeLLMCallDetached` received
  `cacheReadTokens: 111` and `cacheWriteTokens: 222` from the mocked Bedrock usage, and neither key when the usage has
  none. It is red on `origin/main`.

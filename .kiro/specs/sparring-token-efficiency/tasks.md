# Tasks — sparring-token-efficiency

<!-- lane: partner-caching-code -->
## Lane: partner-caching-code

Gateway code: Bedrock prompt caching for `plan_sparring`, cache usage in `modelLog`, right-sized output and tool
results, and the per-session token budget with reason `token_budget`. Executor kiro (seat jtadic), reviewer hotmail.
Depends on `plan-spar-reasons`.

Allowed paths:
- services/gateway/src/providers/bedrock*.ts
- services/gateway/src/services/llm-router.ts
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
- [ ] T3: `llm-router.ts`: pass `promptCache` through and map the cache usage in `bedrockAdapter`. Other adapters stay
  untouched.
  Acceptance (R1.4, R2.1): T-d passes; `npm run test:operator` and the router tests stay green.
- [ ] T4: `plan-sparring/types.ts`, `partner.ts`, `github-tools.ts`, `plan-sparring-service.ts`: add the
  `promptCache` opt, the right-sized caps, `quota_tokens` logging, the budget check before every invoke, the
  `token_budget` reason, and the exported `RETRYABLE_REASONS` including it.
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

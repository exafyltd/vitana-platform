# Requirements — sparring-token-efficiency — sparring-token-efficiency-r2 (re-plan)

The Plan Sparring partner must stop draining the account-wide Bedrock tokens-per-day pool, which it shares with the
Sonnet 4.6 throttle fallback and every production gateway AI stage on Bedrock. Opus 4.6 stays the partner (VTID-04868,
rule 53). Plan: `plan.md`.

## R1 — Prompt caching for the partner (Bedrock only, plan_sparring only)
- R1.1 When `PLAN_SPARRING_PROMPT_CACHE` is unset or anything other than `off|false|0`, every partner call sets
  `promptCache: true`.
- R1.2 With `promptCache`, the Bedrock InvokeModel body puts `cache_control: { type: 'ephemeral' }` on the system
  block (which covers tools and system), on the last block of the last message, and on the last block of the previous
  user message. At most 3 markers, and never on a thinking block.
- R1.3 Without `promptCache` (every other stage and caller), the request body is byte-identical to today.
- R1.4 Only the Bedrock adapter honours the opt. Other adapters ignore it.

## R2 — Cache usage is recorded
- R2.1 Bedrock usage `cache_read_input_tokens` / `cache_creation_input_tokens` flow to `LLMUsage.cacheReadTokens` /
  `cacheWriteTokens`.
- R2.2 Every partner `modelLog` entry (primary and fallback) records `cache_read_tokens`, `cache_write_tokens` and
  `quota_tokens = input + cache_write + 5 × output`.

## R3 — Right-sized output and tool results
- R3.1 The default `PARTNER_MAX_OUTPUT_TOKENS` is 8,000 (12,000 if T0 finds an ok turn above 6,000).
  `PLAN_SPARRING_MAX_OUTPUT_TOKENS` overrides it, clamped to 2,000..16,000.
- R3.2 `TOOL_RESULT_MAX_CHARS` is 12,000 and `READ_FILE_MAX_LINES` is 250. The truncation hint is kept.

## R4 — Per-session token budget
- R4.1 `PLAN_SPARRING_SESSION_TOKEN_BUDGET` (default 900,000 quota tokens) limits the sum of `quota_tokens` over the
  session's `model_log`.
- R4.2 Before any partner invoke (including the throttle retry), if `spent + maxTokens × 5 > budget`, the pass ends
  with reason `token_budget` and makes no further model call.
- R4.3 `token_budget` is retryable in the gateway (`RETRYABLE_REASONS`) and in the CI driver (`plan-spar.mjs`
  `INFRA_REASONS` + `RETRYABLE_REASONS`). A budget stop never uses up one of a plan's sessions.

## R5 — Tests
- R5.1 Unit tests with fakes cover R1–R4 (`services/gateway/test/plan-sparring-token-efficiency.test.ts`).
- R5.2 Existing plan-sparring, router and operator suites and `tsc` stay green. `plan-spar.test.mjs` covers R4.3.

## R6 — Staging verification (read-only)
- R6.1 STAGING-VERIFY checks build-info, `/alive` and a read of an existing sparring session.
- R6.2 Gate 2 evidence: the first CI round served by the new build shows `cache_read_tokens > 0` on turns >= 2.

## Acceptance
- AC-1 R1.2/R1.3 asserted by T-a/T-b.
- AC-2 R2 asserted by T-c/T-d/T-e.
- AC-3 R3 asserted by T-e/T-h.
- AC-4 R4.1/R4.2 asserted by T-f.
- AC-5 R4.3 asserted by T-g and the `plan-spar.test.mjs` case.
- AC-6 R6 green on staging, with no production call.

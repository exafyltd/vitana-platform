# Design — sparring-token-efficiency — sparring-token-efficiency-r2 (re-plan)

## Call path today (origin/main a7433dfe)
`runPartnerPass` (`plan-sparring/partner.ts` :97-251) → `callLlm('plan_sparring', prompt, opts)` = `callViaRouter`
(`llm-router.ts`, adapter call :1291-1304) → `bedrockAdapter.call` (:984-1056, history rendered at :1026) →
`invokeBedrock` (`providers/bedrock.ts` :201-253) → `buildBedrockRequestBody` (:267-285) → InvokeModel.

## Changes by file
| File | Change |
|---|---|
| `constants/llm-defaults.ts` | `planSparringPromptCacheEnabled()`, `resolvePartnerMaxOutputTokens()` (clamp 2k..16k), `resolvePlanSparringSessionTokenBudget()` (default 900_000), `CLAUDE_OUTPUT_BURNDOWN = 5`. `NO_FALLBACK_STAGES` untouched. |
| `services/llm-router.ts` | `LLMRouterOpts.promptCache?`, `AdapterCallArgs.promptCache?`, pass-through at the adapter call; `bedrockAdapter` sets `prompt_cache` and maps the cache usage. `LLMUsage.cacheReadTokens?/cacheWriteTokens?`. |
| `providers/bedrock.ts` | `BedrockInvokeRequest.prompt_cache?`; `buildBedrockRequestBody` places the markers; pure `parseBedrockUsage(payload)`; usage carries the cache fields. |
| `plan-sparring/types.ts` | `EscalationReason` adds `'token_budget'`; `ModelLogEntry` adds optional `cache_read_tokens`, `cache_write_tokens`, `quota_tokens`. |
| `plan-sparring/partner.ts` | `promptCache` opt; right-sized `maxTokens`; `quotaTokens(usage)`; budget check before each invoke; `PartnerPassInput.priorQuotaTokens/tokenBudget`. |
| `plan-sparring/github-tools.ts` | `TOOL_RESULT_MAX_CHARS = 12_000`, `READ_FILE_MAX_LINES = 250`. |
| `plan-sparring/plan-sparring-service.ts` | export `RETRYABLE_REASONS` + `'token_budget'`; pass `priorQuotaTokens` (sum over `session.model_log`) and the budget to both `runPartnerPass` calls (:280, :370). |
| `scripts/collab/plan-spar.mjs` (Claude lane) | `'token_budget'` in `INFRA_REASONS` and `RETRYABLE_REASONS` (:32-33). |

## Cache marker placement (InvokeModel, Anthropic Messages body)
The prefix order is tools → system → messages.
```
system:   [{ type:'text', text:<PARTNER_SYSTEM_PROMPT>, cache_control:{type:'ephemeral'} }]   // covers tools+system
messages: [ …,
  { role:'user', content:[ …, { …last block of turn k-1's final user msg…, cache_control } ] },  // previous write
  { role:'assistant', content:[ thinking…, tool_use… ] },                                        // no marker on thinking
  { role:'user', content:[ …tool_result…, { type:'text', text:<prompt>, cache_control } ] } ]   // rolling marker
```
- A string `content` becomes `[{ type:'text', text }]` before the marker is added.
- The function copies blocks it changes and never mutates `req`.
- Markers are counted and capped at 4. The design uses 3.
- `ttl` is never sent (5-minute default).

## Quota accounting
`quota_tokens = input_tokens + cache_write_tokens + CLAUDE_OUTPUT_BURNDOWN × output_tokens`. Anthropic
`input_tokens` already excludes cache reads and writes, and cache reads cost 0 quota (AWS token-burndown page). Older
entries without `quota_tokens` count as `input + 5 × output`.

## Budget flow
```
spent = priorQuotaTokens + Σ quota_tokens(this pass)
before invoke(primary|fallback): if spent + maxTokens × 5 > budget → fail('token_budget', `spent=… budget=…`)
```
`fail` already returns `toolLog`/`modelLog`, so the stored record shows where the budget went. The gateway marks the
session escalated with `['token_budget']`, which is retryable. CI (after `plan-spar-reasons`) records it as
`infra: true, retryable: true`, so the next push retries and replaces the session instead of starting a re-plan.

## Compatibility
- Other stages: no opt means a byte-identical body and unchanged usage (the new fields are optional).
- Stored `model_log` is jsonb and the new keys are optional. `escalation_reasons` is `text[]` with no CHECK. No
  migration is needed.

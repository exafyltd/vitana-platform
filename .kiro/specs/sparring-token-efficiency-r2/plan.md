---
slug: sparring-token-efficiency
change_class: standard
author: kiro
author_seat: hotmail
---
# Plan — sparring-token-efficiency — sparring-token-efficiency-r2 (re-plan)

Bedrock prompt caching + a per-session token budget for the Plan Sparring partner, so one plan cannot drain the
account-wide Bedrock tokens-per-day pool.

<!-- plan:begin -->
## Re-plan answers (session `b2df0328` round 3)
Re-plan of `sparring-token-efficiency` (branch `kiro/sparring-token-efficiency/plan`; PLAN-SPAR session `b2df0328`
escalated at the round cap). Every premise was re-verified on platform `origin/main` `62990ce285` on 2026-11-01, and
the line refs below are re-pinned to it.
- **R3-F1** (T-d does not prove that the router forwards the cache tokens to telemetry): accepted. T-d mocks
  `../src/services/llm-telemetry-service`. The mocked Bedrock usage is `{ cache_read_input_tokens: 111,
  cache_creation_input_tokens: 222 }`. T-d asserts that the `completeLLMCallDetached` call in `callViaRouter`
  (`llm-router.ts:1346-1347`) received `expect.objectContaining({ cacheReadTokens: 111, cacheWriteTokens: 222 })`, and
  that it received neither key when the usage has none. This is red on `main`, where the call passes only
  `inputTokens`, `outputTokens` and `fallbackUsed`.
- **New since the last round: the partner is a tier loop.** `partner.ts` now tries tiers in order: `primary`
  (Bedrock), then `bedrock_fallback` (Sonnet), then an optional `deepseek` last resort (`:139-145`). Each turn makes
  one `modelLog.push` (`:181`) tagged `fallback_tier`. The old "two push sites" and "Sonnet 4.6 throttle retry" text
  is replaced:
  - The single push fills `cache_read_tokens`, `cache_write_tokens` and `quota_tokens`.
  - `quota_tokens` counts against the Bedrock pool only when `r.provider === 'bedrock'`. A DeepSeek entry records 0,
    because its tokens do not draw on the Bedrock pool.
  - The budget check runs before every `invoke(prompt, tier)`, for every tier.
  - `promptCache` is passed only on Bedrock tiers.
  - A new test, T-f', covers this: a fake primary throttles, `bedrock_fallback` throttles, and a DeepSeek tier returns
    large usage. `spent` excludes the DeepSeek entry, and the budget check ran before each tier. It is red on `main`,
    which has no `quota_tokens` and no budget check.
- **Protected gate files: the lanes are split.**
  - `services/gateway/src/services/plan-sparring/**` and `scripts/collab/plan-spar.mjs` are protected gate files
    (`scripts/collab/protected-gate-files.json`). A reviewer-agent accept never unlocks them on its own. Lane scope
    refuses them for a non-claude lane (`queue.mjs:1000`), and validate refuses a Kiro lane that declares
    `plan-spar.mjs` (`queue.mjs:239-240`).
  - The old `partner-caching-code` lane mixed protected and unprotected files, so it is split.
  - **`llm-cache-telemetry`** (executor `kiro`, seat `jtadic`, reviewer agent) takes the unprotected half:
    `providers/bedrock*.ts`, `services/llm-router.ts`, `services/llm-telemetry-service.ts`,
    `types/llm-telemetry.ts`, `constants/llm-defaults.ts` and its own test. It merges under §7b like any lane.
  - **`partner-budget`** (executor `claude`, which while Claude is unavailable goes to the exceptions seat `exafyltd`,
    §7) takes `plan-sparring/**` and its test. It depends on `llm-cache-telemetry` and `plan-spar-reasons`.
  - **`plan-spar-reasons`** stays `executor: claude` for `scripts/collab/plan-spar.mjs` and its test.
  - The two protected lanes merge only on the owner's instruction naming this plan, plus a reviewer-agent accept on
    the current head (`collaboration.md` §3a, §7b). That is an owner stop at merge time, asked once for both lanes.
- **Line re-pins** (on `62990ce285`):
  - `partner.ts`: constants `:45`/`:46`/`:48`, `invoke` `:150-171`, history `:124`.
  - `bedrockAdapter` `:997` (`invokeBedrock` `:1041`, usage map `:1064`), and `callViaRouter` `:1169`.
  - `buildLLMCallCompleted` `:170` (literal `:184`).
  - Service round-1 pass `:314`, later round `:404`, `model_log` accumulation `:412`.
  - `plan-spar.mjs` reason lists `:43-44`, `MAX_SESSIONS` `:36`, `retryInfra`/`replan` `:306-311`.
  - PLAN-SPAR.yml staging default `:92`.

## Problem

The partner loop resends its whole, growing conversation on every turn, uncached, and every token counts against one
account-wide daily pool.

Code facts (origin/main a7433dfe):
- `services/gateway/src/services/plan-sparring/partner.ts`: `PARTNER_MAX_TOOL_CALLS_PER_ROUND = 30` (:37),
  `PARTNER_MAX_TURNS_PER_ROUND = 40` (:39), `PARTNER_MAX_OUTPUT_TOKENS = 16_000` (:41). `invoke` (:111-126) sends
  `systemPrompt: PARTNER_SYSTEM_PROMPT`, `tools: [...PARTNER_CODE_TOOLS, SUBMIT_REVIEW_TOOL]`, `history: [...history]`,
  `maxTokens`, `thinking: { type: 'adaptive' }`, `effort: 'high'` on every turn of the loop (:128). `history` (:99)
  only grows (:178, :184-190, :247).
- `github-tools.ts`: `TOOL_RESULT_MAX_CHARS = 20_000` (:22), `READ_FILE_MAX_LINES = 400` (:23), `clip()` (:90-94).
- No prompt caching anywhere: `git grep -e cachePoint -e cache_control` over `services/gateway/src/providers`,
  `llm-router.ts` and `plan-sparring/` = 0 hits.
- `providers/bedrock.ts` uses InvokeModel with the Anthropic Messages body (`anthropic_version: 'bedrock-2023-05-31'`,
  :222-228, :267-285); `system` is a plain string (:275). Usage keeps only `input_tokens`/`output_tokens` (:241-244).
- The request is assembled in `llm-router.ts` `bedrockAdapter` (:984-1056): it renders history (:1026), calls
  `invokeBedrock` (:1028-1038) and maps usage to `inputTokens`/`outputTokens` only (:1050-1053; `LLMUsage` :65-73).
- `ModelLogEntry` (`types.ts` :86-101) records `input_tokens`/`output_tokens` only. The service accumulates the
  session's `model_log` across rounds (`plan-sparring-service.ts` :378).

AWS facts ([token burndown](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-token-burndown.html),
[prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)):
- Tokens per day is one quota across all supported Bedrock models in the account. The partner, its Sonnet 4.6 fallback
  and every production gateway AI stage on Bedrock draw from the same pool (owner-stated: 3M/day).
- Quota charged per request = `InputTokenCount + CacheWriteInputTokenCount + OutputTokenCount × 5` for Claude <= 4.7
  (Opus 4.6 and Sonnet 4.6 both). `InputTokenCount` excludes cached tokens. `CacheReadInputTokenCount` does not count.
- `max_tokens` is deducted up front together with the input, then the unused part is returned. A large `max_tokens`
  reduces throttle headroom; it does not raise the final charge.
- Opus 4.6 and Sonnet 4.6 support explicit caching on `system`, `messages` and `tools`: up to 4 checkpoints, 5-minute
  default TTL, minimum checkpoint 4,096 tokens (Opus 4.6) / 1,024 (Sonnet 4.6). Lookback from a checkpoint is about
  20 content blocks.

Effect (estimate, measured in T0): turn k resends the static prefix S (system + tools + plan, about 6-8k tokens)
plus every earlier tool result (up to about 5k tokens each). Over a 30-turn round that is roughly 30·S + 5k·435,
about 2M input tokens, before outputs at 5×. A few rounds empty the 3M pool and throttle production stages too.

Premise corrections (built on the real code):
1. Over InvokeModel the checkpoint is `cache_control: { type: 'ephemeral' }` on a content block; `cachePoint` is the
   Converse API form. This plan uses `cache_control`.
2. The Bedrock path for `plan_sparring` is `llm-router.ts` `bedrockAdapter` plus `providers/bedrock.ts`. The router
   must pass the flag and the cache usage through, so the lane includes `llm-router.ts`.
3. The CI driver keeps its own reason lists (`scripts/collab/plan-spar.mjs` :32-33). A reason it does not list is
   treated as a plan problem: escalated, not infra, so the next push starts a re-plan (:187) and uses one of the
   plan's 2 sessions (:29). A new reason needs a governance (Claude) lane.

## Fix

Lanes `llm-cache-telemetry` (Kiro, seat jtadic, reviewer agent: the provider, router, telemetry and defaults parts of
items 1-2) and `partner-budget` (executor claude, protected `plan-sparring/**`: the partner, types, tools and service
parts of items 1-4); see Re-plan answers for the split:

1. Prompt caching, Bedrock-only, default ON for `plan_sparring` only.
   - `llm-defaults.ts`: `planSparringPromptCacheEnabled()` reads `PLAN_SPARRING_PROMPT_CACHE`. Unset means on;
     `off|false|0` means off (a kill switch through task-def env, no code change).
   - `LLMRouterOpts.promptCache?: boolean` and `AdapterCallArgs.promptCache` are passed through `callViaRouter`
     (:1169-). The partner passes `promptCache: true` only on Bedrock tiers (`primary`, `bedrock_fallback`), never on the
     DeepSeek tier. Only `bedrockAdapter` honours them and sets `prompt_cache: true` on `BedrockInvokeRequest`. Every
     other adapter ignores them. No other stage sets the opt.
   - `buildBedrockRequestBody` (pure) with `prompt_cache`:
     (a) `system` becomes `[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`. The cache prefix order
     is tools → system → messages ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
     "Cache prefixes are created in the following order: tools, system, then messages"), so this one checkpoint
     covers the tool definitions and the system prompt. The key order of the JSON body in `buildBedrockRequestBody`
     (`system` before `messages` before `tools`, bedrock.ts :267-285) is irrelevant: the prefix is defined by the
     API, not by object key order. Tools are not marked separately, because a marker on the last tool would cache
     the tools alone and the system checkpoint already includes them.
     (b) Rolling checkpoint: `cache_control` on the last content block of the last message. A string content becomes
     one text block.
     (c) A second checkpoint on the last block of the previous user message (the one turn k-1 cached), so a turn
     that adds more than about 20 blocks still hits the earlier write.
     At most 3 checkpoints (the limit is 4). Never on `thinking`/`redacted_thinking` blocks. Input is not mutated.
     No `ttl` field, so the 5-minute default applies; turns are seconds apart.
   - Without `prompt_cache` the body is byte-identical to today (test).
2. Cache usage in `modelLog`.
   - `bedrock.ts` reads `usage.cache_read_input_tokens` / `cache_creation_input_tokens` through a pure exported
     `parseBedrockUsage`.
   - `LLMUsage` gains optional `cacheReadTokens` / `cacheWriteTokens`, and `bedrockAdapter` maps them.
   - `ModelLogEntry` gains optional `cache_read_tokens`, `cache_write_tokens`, `quota_tokens`, where
     `quota_tokens = input + cache_write + 5 × output` (constant `CLAUDE_OUTPUT_BURNDOWN = 5`). The single partner
     `modelLog.push` in the tier loop (`partner.ts:181`) fills them; `quota_tokens` is counted only for
     `provider === 'bedrock'` entries (a DeepSeek entry records 0 — its tokens do not draw on the Bedrock pool).
   - OASIS telemetry: `CompleteLLMCallResult` (`llm-telemetry-service.ts` :156-164) gains optional
     `cacheReadTokens` / `cacheWriteTokens`. `LLMTelemetryPayload` (`types/llm-telemetry.ts` :22-66, today only
     `input_tokens?`/`output_tokens?`) gains optional `cache_read_input_tokens?` / `cache_creation_input_tokens?`,
     because `buildLLMCallCompleted` builds a typed literal (:184) and an undeclared key fails `tsc`.
     `buildLLMCallCompleted` spreads them into the payload as
     `cache_read_input_tokens` / `cache_creation_input_tokens` only when present (other stages' events are
     unchanged). The router's `completeLLMCallDetached` call (`llm-router.ts` :1346-1350 on origin/main 4e0e7d1f)
     forwards them from `result.usage`, so `llm.call.completed` shows the real quota cost of cached turns.
3. Right-size output and tool results.
   - `PARTNER_MAX_OUTPUT_TOKENS` 16_000 → 8_000 by default. `PLAN_SPARRING_MAX_OUTPUT_TOKENS` overrides it, clamped
     to 2_000..16_000. T0 reads the stored `model_log` output_tokens read-only. If any ok turn used more than 6,000,
     the default becomes 12_000.
   - `TOOL_RESULT_MAX_CHARS` 20_000 → 12_000 and `READ_FILE_MAX_LINES` 400 → 250 (now exported for the test;
     today it is a module-private `const`, github-tools.ts :23). The truncation hint stays, so the
     partner reads narrower ranges. The evidence floor counts reads, not size, and is unchanged. Old tool results are
     never trimmed, because trimming would break the cached prefix.
4. Per-session token budget with the new retryable reason `token_budget`.
   - `PLAN_SPARRING_SESSION_TOKEN_BUDGET` (default 900_000 quota tokens, 30% of the 3M pool) is resolved in
     `llm-defaults.ts`.
   - `PartnerPassInput` gains `priorQuotaTokens` and `tokenBudget`. The service passes 0 for round 1 (:314) and the
     sum of `quota_tokens` (falling back to `input + 5 × output` for older Bedrock entries, 0 for DeepSeek) over
     `session.model_log` for later rounds (:404).
   - Before every `invoke(prompt, tier)` in the tier loop, for every tier: if `spent + maxTokens × 5 > budget`, end the pass
     with `fail('token_budget', …)`. No further model call is made. The check is logged.
   - Throttled calls: a Bedrock throttle is rejected before the model runs, and the error path returns no usage
     (`llm-router.ts` bedrockAdapter `!result.ok` branch), so its modelLog entry records 0 tokens and adds 0 to
     `spent`. This is deliberate and stated in a code comment at the budget check: the up-front `max_tokens`
     reservation of a rejected request is not charged, and the retry is still bounded by the `maxTokens × 5`
     headroom term of the check.
   - `token_budget` is added to `EscalationReason` (`types.ts` :19-26) and to the gateway `RETRYABLE_REASONS`
     (`plan-sparring-service.ts` :46, exported for the test). A retry is a new gateway session with a fresh budget.
     It runs only on a push, never in a loop.

Lane `plan-spar-reasons` (executor claude — a protected gate file; merges only on the owner's instruction naming this
plan plus a reviewer-agent accept): add `token_budget` to `INFRA_REASONS` and `RETRYABLE_REASONS` in `plan-spar.mjs`
(:43-44). A budget stop then takes the `retryInfra` path (:306-311), which
replaces the session and does not use one of the plan's 2. One test case goes in `plan-spar.test.mjs`.

## Migrations

None. `escalation_reasons` is `text[]` with no CHECK and `model_log` is `jsonb`
(`supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql` :99-100). The new fields are optional JSON
keys; old entries stay valid.

## Tests

New `services/gateway/test/plan-sparring-token-efficiency.test.ts` (fakes only, no network):
- T-a `buildBedrockRequestBody` with `prompt_cache`: system block carries `cache_control`; the last block of the last
  message carries it; the previous user message's last block carries it; total markers <= 4; no marker on thinking
  blocks; a string content is converted; input object unchanged.
- T-b Without `prompt_cache`, the body deep-equals the pre-change body for text, tools, history and thinking requests.
- T-c `parseBedrockUsage` maps `cache_read_input_tokens` / `cache_creation_input_tokens`; absent fields give 0.
- T-d Router (R3-F1): with `jest.mock('../src/services/llm-telemetry-service')`, the `completeLLMCallDetached` call in
  `callViaRouter` (`llm-router.ts:1346`) receives `cacheReadTokens: 111` / `cacheWriteTokens: 222` from mocked Bedrock
  usage, and neither key when the usage has none. with `jest.mock('../src/providers/bedrock')`, `callViaRouter('plan_sparring', …, { promptCache: true })`
  reaches `invokeBedrock` with `prompt_cache: true`. Without the opt the field is absent. Cache usage comes back on
  `result.usage`, and `buildLLMCallCompleted` given cache tokens puts `cache_read_input_tokens` /
  `cache_creation_input_tokens` in the payload (absent when not given); the payload type-checks under `tsc`.
- T-e `runPartnerPass` with a fake `callLlm`: `opts.promptCache === true` by default and absent when
  `PLAN_SPARRING_PROMPT_CACHE=off`; `maxTokens` equals the right-sized default; modelLog entries carry
  `cache_read_tokens`, `cache_write_tokens` and the correct `quota_tokens`.
- T-f Budget: the fake returns usage that crosses the budget on turn 3, so the result is
  `{ ok: false, reason: 'token_budget' }` and `callLlm` was called exactly 3 times. `priorQuotaTokens` near the
  budget stops the pass before the first call. Throttle case: the fake primary returns a throttle error with `usage`
  undefined; the entry records 0 tokens, `spent` stays 0 and the `bedrock_fallback` tier is invoked (after its own
  budget check).
- T-f' Tier loop: primary throttles, `bedrock_fallback` throttles, the DeepSeek tier returns large usage; `spent`
  excludes the DeepSeek entry and the budget check ran before each of the three invokes.
- T-g `RETRYABLE_REASONS` includes `token_budget`, and `createSparringSession` re-creates a session escalated with it.
- T-h `TOOL_RESULT_MAX_CHARS === 12_000`, `READ_FILE_MAX_LINES === 250`, `clip` truncates with the hint, and the
  `read_file` handler (fake fetch) on a 400-line file returns lines 1-250 plus the hint.

Unchanged and green: `vtid-04868-plan-sparring-*.test.ts`, the router tests, `npm run test:operator` (rule 42e: the
router is touched), and `npx tsc --noEmit`. Lane `plan-spar-reasons`: `node --test scripts/collab/plan-spar.test.mjs`
adds the case "token_budget escalation → state infra+retryable → next push action is retry, sessions unchanged".

## Staging verification

Read-only only. `docs/validation/<VTID>/staging-tests.json`:
1. `GET` staging gateway build-info reports the merge commit; `GET /alive` returns 200.
2. `GET /api/v1/plans/spar/<id>` (service token) of an existing session returns 200 and a `model_log` array. This
   proves old entries still parse.

Behaviour evidence for Gate 2, also read-only: PLAN-SPAR spars against the staging gateway by default
(`PLAN-SPAR.yml` :75), so the first round served by the new build is a normal CI run, not a test write. Its
`GET /api/v1/plans/spar/<id>` must show `cache_read_tokens > 0` on turns >= 2 and per-round `quota_tokens` well
below the pre-change estimate. Both go in Gate 2. Nothing touches production.

## Rollout

1. `llm-cache-telemetry` merges under §7b (no protected file); staging auto-deploys and STAGING-VERIFY runs.
2. Owner stop (asked once): the owner's instruction naming this plan for the two protected lanes (§3a, §7b).
3. `plan-spar-reasons` merges first of the two (until it does, CI would treat `token_budget` as a plan problem),
   then `partner-budget`; staging auto-deploys, STAGING-VERIFY runs and the evidence above is collected.
4. Gate 2, then production via PUBLISH.

Kill switches through task-def env, no redeploy of code: `PLAN_SPARRING_PROMPT_CACHE=off`, a higher
`PLAN_SPARRING_SESSION_TOKEN_BUDGET`, `PLAN_SPARRING_MAX_OUTPUT_TOKENS=16000`.

## Risks

- A checkpoint under the model minimum (Opus 4.6: 4,096 tokens) is not cached. The system checkpoint alone may be
  under it; the rolling checkpoint passes it from turn 1 (plan text + system + tools). Staging evidence proves hits.
- Cache writes bill at a premium (5-minute TTL), but they count 1× toward quota and reads count 0, so the net quota
  use drops sharply. Billing is not the constraint here.
- A plain-text user turn (the submit nudge) after thinking drops earlier thinking blocks from context, so that one
  turn misses the cache. This is rare and accepted.
- A lower `max_tokens` can truncate a long `submit_review`. The router already turns an empty truncated reply into a
  failure (VTID-04794), which is not silent, and T0 plus the env override cover it.
- A budget set too low means plans stop with `token_budget` and need a push. It is tunable and logged.
- `llm-router.ts` is shared. The change is one additive opt, off by default, with a byte-identity test and the
  operator suite.
- PR #4186 (`plan(sparring-floor-retry)`) may edit the same lines of `plan-spar.mjs`; `plan-spar-reasons` rebases on
  it.

## Sparring history
Round 1 (session b2df0328): cache usage now reaches the OASIS `llm.call.completed` event (lane paths gain
`llm-telemetry-service.ts`); `READ_FILE_MAX_LINES` is exported and tested; throttled calls are stated to count 0
toward `spent`, with a test. The cache prefix order was re-checked against the Anthropic docs (tools → system →
messages) and the system checkpoint kept.
Round 2: `LLMTelemetryPayload` in `services/gateway/src/types/llm-telemetry.ts` gains the two optional cache fields
(the typed literal in `buildLLMCallCompleted` would not compile otherwise); that file joins the lane paths, and T-d
asserts the fields on the built payload.
## Out of scope

Partner prompt wording (`PARTNER_SYSTEM_PROMPT`), the partner model choice (Opus 4.6 primary, Sonnet 4.6 throttle
retry), rule 53, `NO_FALLBACK_STAGES`, caching for any other stage, a Converse API migration, the 1-hour TTL, and
trimming old tool results.

## Depends on

No code dependency on unmerged work. Lane order: `llm-cache-telemetry` (any time), then `plan-spar-reasons` → `partner-budget` (both on the owner's instruction naming this plan). Coordinate with
PR #4186 on `plan-spar.mjs`.

## Owner decisions

None needed. Defaults chosen (all env-tunable): caching on for `plan_sparring`, budget 900,000 quota tokens per
session, output cap 8,000 (or 12,000 per T0), tool results 12,000 chars / 250 lines.
<!-- plan:end -->

# Sparring round 1 — in_progress

Session: `b2df0328-27f7-43fe-bee5-2d6ba8866cb2` · plan hash `61e6922743a12b27c9e93e1afc5c49e68e4cc4554b63e9e32ecda218bbdc4a6c`

## Summary

Four findings. One blocker: the plan inverts the Anthropic/Bedrock prompt-cache prefix order, meaning a cache_control on `system` cannot cover the tool definitions — the largest static chunk — so the actual quota savings will be materially lower than estimated and the fix is mis-implemented as written. One major: cache usage tokens are not threaded into the OASIS `llm.call.completed` event, so true quota cost is invisible to OASIS telemetry despite rule 42e gating on the router touch. Two minors: no test assertion for the `READ_FILE_MAX_LINES` reduction, and unspecified accounting for whether throttled (429) primary calls contribute to `spent` before the retry budget check.

## Findings

### R1-F1 [blocker]

The plan states 'The prefix order is tools → system → messages, so this one checkpoint covers the tool definitions and the system prompt' and puts cache_control on the system array only. This is wrong. The Anthropic Messages API (Bedrock under anthropic_version: 'bedrock-2023-05-31') processes the cache prefix in the order system → tools → messages. A cache_control marker on the system array's last block caches ONLY the system text; the four tool definitions (PARTNER_CODE_TOOLS × 3 + SUBMIT_REVIEW_TOOL, each with a detailed inputSchema) sit after system in the prefix chain and are re-transmitted uncached on every turn. The expected savings are overstated, the 4-checkpoint budget allocation is miscounted, and if implemented as written the fix does not solve the stated problem.

- `exafyltd/vitana-platform:services/gateway/src/providers/bedrock.ts:267` — return { anthropic_version: 'bedrock-2023-05-31', ... ...(req.system ? { system: req.system } : {}), messages: req.messages, ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {})
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:31` — export const PARTNER_CODE_TOOLS: LLMRouterTool[] = [ { name: 'read_file', ... }, { name: 'list_dir', ... }, { name: 'search', ... }]
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:111` — tools: [...PARTNER_CODE_TOOLS, SUBMIT_REVIEW_TOOL]

Suggestion: Put the static checkpoint on the last tool definition, not on the system block. In buildBedrockRequestBody with prompt_cache, add cache_control: { type: 'ephemeral' } to the last entry in the tools array. This single checkpoint covers system + tools (the full static prefix). The system block can also carry cache_control if a second Opus 4.6 checkpoint budget remains, but the tool-level checkpoint is mandatory for tools to be cached. Update the estimate and the checkpoint count accordingly (you now use 1 checkpoint for system+tools rather than 1 for system alone).

### R1-F2 [major]

Cache usage tokens (cache_read_input_tokens, cache_creation_input_tokens) are added to LLMUsage and ModelLogEntry but are never threaded into the OASIS llm.call.completed event. completeLLMCallDetached at llm-router.ts:1326 is called with only { inputTokens, outputTokens, fallbackUsed }; any new fields on result.usage are silently dropped. With caching ON the event's inputTokens equals cache-miss tokens only, omitting cache-write tokens that also count toward the daily quota at 1×. OASIS telemetry will systematically understate quota cost for plan_sparring turns, directly undermining the observability purpose of this change. Rule 42e gates the operator test on any router touch.

- `exafyltd/vitana-platform:services/gateway/src/services/llm-router.ts:1325` — void completeLLMCallDetached(ctx, { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, fallbackUsed, });
- `exafyltd/vitana-platform:services/gateway/src/services/llm-router.ts:65` — export interface LLMUsage { inputTokens: number; outputTokens: number; reasoningTokens?: number; }

Suggestion: Extend the completeLLMCallDetached call site to forward cacheReadTokens and cacheWriteTokens when present on result.usage, and update the llm.call.completed OASIS event schema to carry them. If the event schema is out of scope for this change, at minimum add a comment explaining why quota-relevant tokens are not reported there, and add a test that asserts the fields are present on the LLMRouterResult returned by callViaRouter so downstream consumers can read them.

### R1-F3 [minor]

READ_FILE_MAX_LINES is reduced from 400 to 250 in the plan, but there is no test that asserts the new value. The constant is currently unexported (github-tools.ts:23: 'const READ_FILE_MAX_LINES = 400'). Test T-h only asserts TOOL_RESULT_MAX_CHARS === 12_000. A typo or omission leaving READ_FILE_MAX_LINES at 400 passes the entire test suite undetected.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:22` — export const TOOL_RESULT_MAX_CHARS = 20_000;
const READ_FILE_MAX_LINES = 400;

Suggestion: Export READ_FILE_MAX_LINES (or a derived constant) and add an assertion to T-h: expect(READ_FILE_MAX_LINES).toBe(250). Alternatively, add a behavioral test: call the read_file tool handler with a file longer than 250 lines and assert the response is truncated at line 250.

### R1-F4 [minor]

The budget check 'before the Sonnet 4.6 throttle retry' uses a `spent` counter accumulated from modelLog entries. A throttled primary call pushes a log entry with input_tokens: 0 (the error path in bedrockAdapter at llm-router.ts:1040-1042 returns no usage, so modelLog.push at partner.ts:138 records r.usage?.inputTokens ?? 0 = 0). The plan does not state whether AWS Bedrock bills throttled (429) requests. If it does, the `spent` counter underestimates true quota use and the guard fails to prevent the retry. This assumption should be explicit and covered by a test scenario.

- `exafyltd/vitana-platform:services/gateway/src/services/llm-router.ts:1040` — if (!result.ok) { return { ok: false, error: `Bedrock ${result.error}: ${result.message}` }; }
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:133` — modelLog.push({ ... input_tokens: r.usage?.inputTokens ?? 0, output_tokens: r.usage?.outputTokens ?? 0, ok: r.ok, ... });
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:148` — if (!r.ok && isRetryableThrottle(r.error)) { ... r = await invoke(prompt, true);

Suggestion: Add a note in the plan and in the code comment at the retry budget check: 'AWS Bedrock 429 throttle errors are not billed; spent does not include the failed primary call.' Add a test case to T-f: fake primary returns throttle error with usage undefined; assert the retry budget check uses spent=0 (not counting the failed call) and proceeds to the retry invoke.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

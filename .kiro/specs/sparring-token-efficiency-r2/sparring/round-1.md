# Sparring round 1 — in_progress

Session: `9315851c-4840-429f-a06f-59aca258b11a` · plan hash `794dd91a995309278af13f85b768f37dde69374b70f08a91ad717b32be4a01dc`

## Summary

The plan is well-researched and the lane split, protected-file governance, and rollout ordering are correct. Three genuine gaps were found: (1) the T0 adaptive-cap mechanism is under-specified — PartnerPassInput does not receive per-turn prior output_tokens data and the invoke closure's constant maxTokens reference is never replaced with the T0-computed value, breaking both the adaptive cap and the budget-check headroom formula; (2) BedrockInvokeRequest is never mentioned as needing a prompt_cache? field, which is required for tsc --noEmit to pass; (3) runProviderCall — the internal function that actually assembles AdapterCallArgs for adapter.call() — is not named as a change site, leaving a threading gap for promptCache.

## Findings

### R1-F1 [major]

The T0 adaptive output-cap mechanism is under-specified: PartnerPassInput has no field carrying per-turn prior output_tokens, so runPartnerPass cannot perform the T0 analysis, and the invoke closure hardcodes the constant PARTNER_MAX_OUTPUT_TOKENS rather than a dynamically-computed value. The budget-check headroom formula 'spent + maxTokens × 5 > budget' is also undefined when maxTokens is the constant but T0 has decided on a different cap.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:93` — export interface PartnerPassInput {
  round: number;
  prompt: string;
  callLlm: CallLlm;
  executeTool: ExecuteTool;
  deadlineMs: number;
  now?: () => number;
  maxToolCalls?: number;
}
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:150` — const invoke = (p: string, tier: PartnerTier): Promise<LLMRouterResult> =>
    input.callLlm(PARTNER_STAGE, p, {
      ...
      maxTokens: PARTNER_MAX_OUTPUT_TOKENS,

Suggestion: Add a `maxTokens?: number` field to `PartnerPassInput`. The service performs the T0 analysis (inspecting `session.model_log` entries for output_tokens > 6,000) before calling `runPartnerPass`, computes the effective cap (8,000 or 12,000), and passes it in. Inside `runPartnerPass`, replace the constant reference with a local variable (e.g. `const effectiveMaxTokens = input.maxTokens ?? PARTNER_MAX_OUTPUT_TOKENS`) and use it in both the `invoke` closure and the pre-call budget check formula `spent + effectiveMaxTokens * 5 > budget`.

### R1-F2 [major]

BedrockInvokeRequest (bedrock.ts lines 71-98) has no prompt_cache field. The plan says bedrockAdapter sets prompt_cache: true on BedrockInvokeRequest and that tsc --noEmit must pass, but the type change to BedrockInvokeRequest is never mentioned in the plan's file-by-file description.

- `exafyltd/vitana-platform:services/gateway/src/providers/bedrock.ts:71` — export interface BedrockInvokeRequest {
  model: string;
  messages: ...
  system?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: BedrockTool[];
  tool_choice?: BedrockToolChoice;
  thinking?: BedrockThinkingConfig;
  output_config?: { effort?: BedrockEffort };
}
- `exafyltd/vitana-platform:services/gateway/src/services/llm-router.ts:1041` — const result = await invokeBedrock({
        model,
        messages: [...historyMessages, { role: 'user', content }],
        system: systemPrompt,
        max_tokens: maxTokens,
        tools: bedrockTools,
        tool_choice: toolChoice,
        ...(thinking ? { thinking } : {}),
        ...(effort ? { output_config: { effort } } : {}),
      });

Suggestion: Add `prompt_cache?: boolean` to `BedrockInvokeRequest` (bedrock.ts). Explicitly name this type change in the plan's providers/bedrock*.ts lane work. The bedrockAdapter.call spread at line 1041 can then conditionally include `...(promptCache ? { prompt_cache: true } : {})`, and buildBedrockRequestBody can read req.prompt_cache to decide whether to transform system and add rolling checkpoints.

### R1-F3 [minor]

The plan says promptCache flows 'through callViaRouter (:1169-)' but the actual assembly of AdapterCallArgs for adapter.call() happens inside the internal function runProviderCall (llm-router.ts lines 1276-1324). That function's signature and the adapter.call({...}) spread at line 1311 both need to include promptCache, but runProviderCall is not named as a change site anywhere in the plan.

- `exafyltd/vitana-platform:services/gateway/src/services/llm-router.ts:1276` — async function runProviderCall(
  stage: LLMStage,
  provider: LLMProvider,
  model: string,
  prompt: string,
  opts: LLMRouterOpts,
  fallbackUsed: boolean,
): Promise<LLMRouterResult> {
  ...
  const result = await adapter.call({
    prompt,
    model,
    systemPrompt: opts.systemPrompt,
    maxTokens: opts.maxTokens,
    image: opts.image,
    images: opts.images,
    tools: opts.tools,
    forceTool: opts.forceTool,
    history: opts.history,
    thinking: opts.thinking,
    effort: opts.effort,
    deepseekThinking: opts.deepseekThinking,
  });
- `exafyltd/vitana-platform:services/gateway/src/services/llm-router.ts:997` — const bedrockAdapter: ProviderAdapter = {
  isAvailable: () => Boolean(process.env.BEDROCK_ROLE_ARN),
  async call({ prompt, model, systemPrompt, maxTokens, image, images, tools, forceTool, history, thinking, effort }): Promise<AdapterResult> {

Suggestion: Explicitly add `runProviderCall` to the plan's list of change sites in llm-router.ts: (a) add `promptCache?: boolean` to AdapterCallArgs (the adapter.call parameter shape), (b) add `promptCache: opts.promptCache` in the adapter.call({...}) spread inside runProviderCall, and (c) destructure it in bedrockAdapter.call's parameter list.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

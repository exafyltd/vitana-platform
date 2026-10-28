# Design — sparring-model-fallback

## Current code (premises, cited)

- `services/gateway/src/services/plan-sparring/partner.ts` `runPartnerPass`: each turn calls
  `input.callLlm('plan_sparring', prompt, { allowFallback: false, thinking: {type:'adaptive'}, effort:'high', … })`.
  `if (!r.ok) return fail('model_unavailable', …)` ends the pass on ANY failed call — no retry on another model.
  A defence-in-depth guard refuses `r.fallbackUsed || r.provider !== 'bedrock'`.
- `services/gateway/src/providers/bedrock.ts` `buildBedrockRequestBody`: spreads
  `...(req.output_config ? { output_config: req.output_config } : {})` and `...(req.thinking ? { thinking } : {})`
  with no model gating.
- `services/gateway/src/constants/llm-defaults.ts`: `PLAN_SPARRING_DEFAULT_MODEL = 'eu.anthropic.claude-opus-4-6-v1'`,
  `resolvePlanSparringModel()` reads `PLAN_SPARRING_MODEL`; `NO_FALLBACK_STAGES = ['plan_sparring']`.

## Changes

### 1. partner.ts — throttle-only single retry on the fallback model
In the per-turn loop, when `!r.ok`, classify the error:
- If it matches a retryable throttle (`/too many tokens per day/i` or an explicit throttling/rate-limit
  marker) AND the turn has not already used its fallback retry → re-issue the SAME `callLlm` with the
  fallback model (new opt, e.g. `modelOverride: PLAN_SPARRING_FALLBACK_MODEL`) and the model-appropriate
  request shape (see §2). Push a `modelLog` entry for the fallback attempt and a WARN line. If the retry
  succeeds, continue the turn as normal; if it also fails, `fail('model_unavailable', …)`.
- Any other failure → `fail('model_unavailable', …)` exactly as today (no retry).
The `r.provider !== 'bedrock'` guard is unchanged — Sonnet 4.6 is Bedrock, so it passes; non-Bedrock is refused.
One retry per turn only; the pass-level deadline and turn cap are unchanged.

### 2. bedrock.ts — per-model field gating
Add a small allowed-fields helper keyed on model id (or inference-profile id): a model entry declares
whether it accepts `output_config.effort` and `thinking`. `buildBedrockRequestBody` consults it and only
spreads the fields the model accepts. Opus 4.6: both. Sonnet 4.6: verified at implementation time — if it
accepts `effort`, include it; if not, omit `output_config` for Sonnet (keep adaptive thinking if accepted,
else omit). Default for unknown models: conservative (omit `effort`), so a new model never gets a field it
rejects.

### 3. llm-defaults.ts — fallback constant + doc
Add `PLAN_SPARRING_FALLBACK_MODEL` (env `PLAN_SPARRING_FALLBACK_MODEL`, default
`eu.anthropic.claude-sonnet-4-6`) and a comment: the `plan_sparring` NO_FALLBACK_STAGES entry still bars
ROUTER-level fallback; this constant is used ONLY by the partner pass's explicit throttle retry, which is
logged and Bedrock-only.

## Why this honours VTID-04868

Rule 53 forbids a SILENT fallback to a weaker/Google model. This fallback is (a) explicit and logged,
(b) Bedrock-only (the provider guard stays), (c) to Sonnet 4.6 — a strong current Anthropic model, chosen
by the owner, not a cost-driven silent drop to Google/DeepSeek, and (d) triggered only by a retryable
throttle, not as a general fallback. The primary stays Opus 4.6.

## Testing

Unit (gateway Jest, `test/vtid-xxxxx-sparring-model-fallback.test.ts`): inject a `callLlm` fake that fails
the first call with `Too many tokens per day` and succeeds on the fallback; assert one fallback retry, a
logged modelLog entry, and the round proceeds. A separate fake fails with an auth error → no retry. A
field-gating unit asserts `effort` present for Opus 4.6 and absent for a model marked as not accepting it.
A non-bedrock fallback result → still refused. Plus `npx tsc --noEmit` and the plan-sparring regression
suites. Staging verification is read-only (R6).

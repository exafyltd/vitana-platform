# Plan — sparring-model-fallback

Opus 4.6 primary, Sonnet 4.6 fallback on retryable throttle, with model-gated request shape.

<!-- plan:begin -->
## Problem

The Plan Sparring partner (`services/gateway/src/services/plan-sparring/partner.ts`,
`runPartnerPass`) calls `callViaRouter('plan_sparring', …)` with `allowFallback: false`,
`thinking: { type: 'adaptive' }` and `effort: 'high'` (partner.ts lines ~88-100). Any failed model
call ends the pass immediately as `model_unavailable` with no retry on another model
(partner.ts: `if (!r.ok) return fail('model_unavailable', …)`), and `NO_FALLBACK_STAGES` in
`services/gateway/src/constants/llm-defaults.ts` lists `plan_sparring` so the router also refuses
fallback — defence in depth.

Two live consequences, both verified this session:
1. The partner model `PLAN_SPARRING_MODEL` defaults to `eu.anthropic.claude-opus-4-6-v1`. That model's
   AWS Marketplace subscription is new and carries an introductory **daily token cap** that is NOT an
   adjustable Service Quota (verified: eu-central-1 has only per-minute token quotas for Opus 4.6, no
   per-day quota). A real sparring session gets several tool-backed rounds deep, then every further
   invoke returns `Bedrock invoke_failed: Too many tokens per day`. The round escalates
   `model_unavailable` with `infra: true, retryable: true`. Plans therefore cannot converge in one day
   until the cap matures (days).
2. `output_config.effort` / `thinking: adaptive` are hardcoded and sent to whatever
   `PLAN_SPARRING_MODEL` points at. `buildBedrockRequestBody`
   (`services/gateway/src/providers/bedrock.ts`) serializes `output_config` with NO model gating.
   Opus 4.5 rejected the field (`output_config.effort: Extra inputs are not permitted`), so pointing the
   model elsewhere without gating the field breaks every invoke.

## Goal

Make the sparring partner resilient to the Opus 4.6 daily-cap throttle WITHOUT weakening the governance
guarantees (VTID-04868 / rule 53: Opus 4.6 primary, never a SILENT fallback to a weaker/Google model):

- Keep **Opus 4.6 as the primary** partner model, with `effort: 'high'` + adaptive thinking.
- On a **retryable throttle only** (`Too many tokens per day` or an explicit rate-limit error) retry the
  SAME pass once on **Claude Sonnet 4.6** (`eu.anthropic.claude-sonnet-4-6`, verified ACTIVE in
  eu-central-1, 6M tokens/min, no fresh-subscription daily cap). This is an EXPLICIT, logged fallback —
  the opposite of the silent Google/DeepSeek fallback the rule forbids.
- **Gate `output_config.effort` / `thinking`** so each model gets only the request fields it accepts.
  Opus 4.6: send both. Sonnet 4.6: send only what it accepts (verified at implementation time by a real
  invoke; if Sonnet 4.6 rejects `output_config.effort`, omit it for Sonnet and keep adaptive thinking if
  accepted, else omit both). The field set per model is a small table, not a global on/off.
- The provider-refusal guard stays: a fallback that is not on `bedrock` is still refused. Sonnet 4.6 is a
  Bedrock model, so the `r.provider !== 'bedrock'` check is unchanged and still blocks Google/Anthropic-direct.
- Every fallback is logged loudly (`modelLog` entry + a WARN line) naming the throttle reason and that the
  round ran on Sonnet 4.6, so a fallback is always visible, never silent.

## Scope (what changes)

- `services/gateway/src/services/plan-sparring/partner.ts` — in `runPartnerPass`, when a call fails with a
  retryable throttle, retry the invoke once on the configured fallback model; relax the "ended the pass
  immediately" behaviour to this single explicit retry; keep all other failures (non-throttle) ending the
  pass as `model_unavailable` with no retry.
- `services/gateway/src/providers/bedrock.ts` — `buildBedrockRequestBody` gates `output_config` / `thinking`
  by model id (a per-model allowed-field table), so only models that accept the field receive it.
- `services/gateway/src/constants/llm-defaults.ts` — add the fallback model constant
  (`PLAN_SPARRING_FALLBACK_MODEL`, default `eu.anthropic.claude-sonnet-4-6`) and document that the
  `plan_sparring` NO_FALLBACK rule still bars ROUTER-level fallback; the throttle fallback is handled
  inside the partner pass, explicitly, not by the generic router fallback path.
- Tests: a `test/vtid-xxxxx-sparring-model-fallback.test.ts` that (a) a non-throttle failure still ends the
  pass with no retry; (b) a `Too many tokens per day` failure retries once on the fallback model and, on
  success, the round proceeds; (c) the field-gating table sends `effort` to Opus 4.6 and withholds it from
  a model marked as not accepting it; (d) a non-bedrock fallback is still refused.

## Out of scope

- Changing `PLAN_SPARRING_MODEL`'s primary (stays Opus 4.6).
- Any env-var model switch as a bridge (the 4.5 switch regression showed that is fragile).
- Raising AWS quotas (there is no per-day Opus 4.6 quota to raise).

## Verification

- Unit tests above (gateway Jest), `npx tsc --noEmit`, the plan-sparring regression suites.
- Staging: after deploy, a real re-push of a stuck plan (e.g. native-g1-wiring) spars; when Opus 4.6
  throttles mid-round, the modelLog shows an explicit Sonnet 4.6 fallback and the round completes instead
  of escalating `model_unavailable`. Read-only; no production writes.

## Decisions deferred to the sparring partner / review

- Exact per-model field table for `output_config.effort` / `thinking` — verified by a real invoke at
  implementation time, not assumed. If Sonnet 4.6 accepts `effort`, keep it; if not, omit it for Sonnet.
<!-- plan:end -->

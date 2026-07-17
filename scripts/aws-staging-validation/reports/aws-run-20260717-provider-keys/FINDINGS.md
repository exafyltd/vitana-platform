# AWS staging — provider keys bound + verified, Gemini fallback bug fixed (2026-07-17)

## What was done

Provider API keys were bound on the `vitana-gateway` task definition and
verified live through the gateway (the sandbox running this session cannot
reach the provider APIs directly — egress blocked — so all verification is
end-to-end through AWS staging):

| Revision | Change |
|----------|--------|
| :9 | (pipeline `AWS-STAGE-DEPLOY-GATEWAY.yml` — image `03e4be971672` from merged main) |
| :10 | dead end — derived from :8 in a race with the pipeline's :9; never used, superseded |
| :11 | :9 + `GOOGLE_GEMINI_API_KEY`, `GEMINI_API_KEY` (same value — services prefer the `GOOGLE_` name with the short name as fallback), `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` |
| :12 | image → `eb2b4f4` (retired-Gemini-model fix, see below) + commit stamps |
| :13 | `DEEPSEEK_API_KEY` corrected to lowercase `sk-` prefix (as provided it began with `Sk-` and DeepSeek returned 401 invalid key) |

## Verification results (all through `preview-aws-gateway.vitanaland.com`)

| Provider | Test | Result |
|----------|------|--------|
| Gemini | `POST /api/v1/orb/chat` as e2e user | Real LLM reply, `meta.provider=gemini-api` (Vertex ADC fails on AWS as expected → API-key fallback used) |
| DeepSeek | fact-bearing chat turn + `session/finalize` → inline fact extraction | `[VTID-01225-inline] DeepSeek response: [{"fact_key":"user_favorite_fruit","fact_value":"mango",...}]` |
| OpenAI | fact embedding on the extracted fact | `[VTID-01192] Embedding stored` with NO `OpenAI fact-embedding failed, trying Gemini` warning — OpenAI primary path succeeded |

## Bug found and fixed: retired Gemini models in the API-key fallback

First Gemini test came back from the **local keyword router** ("fallback
mode"). Logs: Vertex ADC error (expected — no GCP metadata server on AWS) →
`Falling back to Gemini API key` → **`Gemini API error: 404`**. The
API-key fallback paths called models retired from the generativelanguage
API: `gemini-pro` (gemini-operator.ts ×2, knowledge-hub.ts),
`gemini-pro-vision` and `gemini-1.5-flash` (assistant-core.ts). These
paths never ran on GCP because Vertex always succeeded — a latent
AWS-only failure exactly of the class flagged in the validation plan's
GCP-coupled-code inventory.

Fixed in commit `eb2b4f4` (this PR): `gemini-pro` → `gemini-2.5-pro`,
vision/1.5-flash → `gemini-2.5-flash`. Deployed to AWS staging as image
`vitana/gateway:eb2b4f4` (built on the pipeline image `03e4be971672` +
recompiled dist). After the fix: real Gemini replies.

**⚠️ Merge-ordering constraint:** `AWS-STAGE-DEPLOY-GATEWAY.yml` builds
from `main`. Until this PR merges, its next run would deploy an image
WITHOUT the model fix and Gemini falls back to 404/keyword-router again.
Merge this PR before (or immediately after) the next gateway push to main.

## Pipeline interaction (checked — no wipe risk)

`AWS-STAGE-DEPLOY-GATEWAY.yml` derives each new task definition from the
service's CURRENT one (image swap + commit-stamp upsert, env preserved),
so the key bindings on :13 carry forward across future deploys.

## Security notes

- The three key values were shared in the session conversation (owner's
  decision, rotation already planned). **Rotate on schedule regardless**;
  bind replacements via AWS Secrets Manager (`secrets` block + execution
  role grant), not chat and not plain task-def env.
- Still missing: `GATEWAY_SERVICE_TOKEN` (not provided) — service-token
  auth paths remain unverified on AWS.
- Found in source, unrelated to this session's keys:
  `services/gateway/src/services/natural-language-service.ts:5` contains a
  **hardcoded fallback Gemini API key** (`AIzaSyDCbka2...`). It should be
  revoked in Google Cloud Console and removed from source.
- Telemetry labels still report `model: gemini-pro` in one legacy path
  (labels only — the actual calls use the 2.5 models).

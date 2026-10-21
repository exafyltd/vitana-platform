# VTID-04577 — Nova sessions keep the member's personal context

VTID: VTID-04577
Companion VTIDs in this PR: VTID-04578 (My Journey block sent once), VTID-04579 (search_memory hint).

## What was measured before the change (staging, 2026-09-25)

- Since VTID-04555 (Nova instruction budget 64 KB) and VTID-04534 (shorten before drop),
  the aggregate budget no longer drops member context on staging: 79 of 79 sessions
  since 17:00 UTC kept it (`instruction_budget` diag, `trimmed_sections` empty).
- The remaining cut is one layer lower. The brain-context packer still caps the
  bootstrap at 12,000 chars (a Vertex-era limit) for every provider. Every staging
  `brain_context_built` diag for the test account reports `social_context` dropped
  (chars 15,575–16,766 before, ~11,500 after), while the assembled prompt uses
  ~36 KB of its 64 KB.
- The My Journey two-views block reached the prompt twice when the packer kept it:
  once inside the brain context, once appended to the scaffold.
- Spoken baseline, staging build a07a332, test account, German, question
  "Wem folge ich eigentlich in der Community? Nenn mir bitte die Namen." (Polly PCM):
  reply "Es folgt dir noch niemand in der Community …" — wrong. Ground truth
  (`user_follows`): the account follows exactly one member, Mariia Maksina.
  Raw trial output: outputs/baseline-spoken-trials.json.

## Fix

- `resolveBootstrapMaxCharsFor(provider)`: Nova Sonic and the cascade pack the brain
  context to 24,000 chars (`NOVA_BRAIN_CONTEXT_MAX_CHARS` overrides); Vertex and every
  other caller keep 12,000. The session envelope passes the serving provider's cap.
- The voice builder strips the brain context's copy of the My Journey block when it
  appends its own (same flag, same surface).
- The member prompt tells Vitana the context is a selection and to call
  `search_memory` before saying she does not know; the packer's and the budget
  guard's "omitted" notes say the same.

## Acceptance

AC-1: Nova and the cascade get a 24,000-char brain-context cap; Vertex and unknown providers keep 12,000; a bad override cannot lower it.
TEST: services/gateway/test/orb/live/instruction/vtid-04577-provider-brain-context-cap.test.ts

AC-2: A staging-sized brain context loses social context at the Vertex cap and keeps it whole at the Nova cap, and the result still fits the Nova instruction budget with nothing dropped.
TEST: services/gateway/test/orb/live/instruction/vtid-04577-provider-brain-context-cap.test.ts

AC-3: The session envelope passes `resolveBootstrapMaxCharsFor(session.upstreamProvider)`.
TEST: services/gateway/test/orb/live/instruction/vtid-04577-provider-brain-context-cap.test.ts

AC-4 (VTID-04578): the My Journey two-views block appears once in the prompt.
TEST: services/gateway/test/orb/live/instruction/vtid-04577-provider-brain-context-cap.test.ts

AC-5 (VTID-04579): the member prompt carries the MEMORY LOOKUP rule; work surfaces do not; the omitted-context notes name search_memory.
TEST: services/gateway/test/orb/live/instruction/vtid-04577-provider-brain-context-cap.test.ts

AC-6: The voice payload guard changes only by the new rule (+262 bytes per scenario, tools unchanged).
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

AC-7 (staging, after merge): test-account Nova sessions report `brain_context_built` with `social_context` kept; `instruction_budget` shows no trims; the spoken question above is answered with Mariia Maksina.
UI: https://preview-aws.vitanaland.com as the test account (Nova, de); ask Vitana "Wem folge ich eigentlich in der Community?" — scripts/orb/verify-vertex-serbian-bridge.mjs --utterance-pcm drives the same turn over SSE

# Bedrock Transport Migration Runbook

**VTID:** VTID-04770  
**Date:** 2026-10-01  
**Status:** VERIFY THEN HOLD — accumulating post-migration baseline

---

## Overview

This runbook records the migration of the Voice Architecture Investigator's
LLM transport from a direct Anthropic API call to **Claude via AWS Bedrock**
(`provider: bedrock`), and the verification procedure to confirm the migration
is functionally correct before drawing any architectural conclusions from
investigator reports.

The migration was triggered by a manually-spawned Architecture Investigator
report (ID `0aa7f760-9491-4732-b24d-c47661996703`, failure class
`bedrock-verification-test`) accepted by an operator on the Command Hub Voice
Self-Healing screen. The report's recommendation was **VERIFY THEN HOLD**:
the evidence window contained zero real dispatches, so no architectural
decision can be made from it.

---

## Voice pipeline reference

| Path | Provider | Languages |
|---|---|---|
| Amazon Nova Sonic (bidirectional S2S) | AWS Bedrock | en, de, fr, es, it, and most sessions |
| Cascade: Transcribe → Claude → Polly/Fish | AWS | ru, pl, tr, zh, ar, … |
| Vertex Gemini Live bridge | GCP (dedicated project, Serbian only) | sr |

The browser widget streams microphone audio over WebSocket/SSE to the gateway
(AWS ECS `eu-central-1`), which relays upstream. Full-duplex barge-in is
enabled on staging.

---

## Migration details

| Field | Value |
|---|---|
| Migration date | 2026-10-01 |
| Routing stage | `triage` (via `callViaRouter` in `voice-architecture-investigator.ts`) |
| Provider before | direct `anthropic` API (zero credit balance — silent Gemini fallback) |
| Provider after | `bedrock` (Claude Sonnet 4.6, bills to AWS account `472838866351`) |
| Standing rule | VTID-03563: always use Claude via Bedrock, never direct Anthropic |

---

## Verification procedure

### Step 1 — Telemetry continuity probe

Call `probeTelemetryContinuity()` from `voice-recurrence-sentinel.ts` (or
via the ops endpoint that wraps it). This function:

1. Writes a synthetic `suppressed` verdict for the probe key
   (`class=bedrock-verification-test`, `signature=probe_continuity_check`).
2. Reads back the history for that key and verifies the row appears.
3. Returns `{ ok, dispatch_count, rollback_count, suppressed_count }`.

**Expected result:** `ok=true`, `dispatch_count ≥ 1`, `suppressed_count ≥ 1`.

A failure (`write_failed`, `write_not_visible`, `read_threw`) indicates that
`appendVerdict → voice_healing_history` is broken post-migration and must be
investigated before any counter-based conclusions are drawn.

### Step 2 — Confirm Recurrence Sentinel counters

After the probe passes, verify that real incident dispatches (if any) are
being recorded by checking `voice_healing_history` for rows with
`class != 'bedrock-verification-test'` in the last 7 days. If the table is
empty and the platform has had voice sessions, investigate whether the
transport-layer change altered the event emission path.

### Step 3 — 7-day monitoring window

Accumulate at least 7 days of real dispatch data before drawing any
conclusions about pipeline health or architectural fitness. Do not use the
`0aa7f760` report as a basis for architectural decisions — it was produced
from zero evidence.

### Step 4 — Re-trigger if real failures emerge

If real failures emerge during the monitoring window, re-trigger the
Architecture Investigator with the actual incident class and evidence:

```
POST /api/v1/voice-lab/investigate
{
  "class": "<actual class>",
  "normalized_signature": "<actual signature>",
  "trigger_reason": "manual",
  "notes": "Post-Bedrock-migration monitoring window — real incident"
}
```

---

## What would invalidate "VERIFY THEN HOLD"

If post-migration monitoring reveals that real incident dispatches were
occurring during the 30-day window but were silently dropped or miscounted
due to a transport-layer bug introduced during the Bedrock migration, the
"hold and verify" track is invalidated and an immediate rollback or
escalation is required.

Rollback path: revert the `llm_routing_policy` row for the `triage` stage to
the previous provider. **Do not revert to direct `anthropic` API** — that
account has no credit balance (VTID-03563). The safe rollback target is a
different Bedrock model or a hard failure.

---

## Open human decisions (not decided in code)

1. **Is the zero `dispatch_count` over 30 days expected** (pre-launch,
   maintenance window, or low-traffic period) or does it indicate a telemetry
   gap that must be investigated before proceeding?

2. **Has the team independently verified** (outside this investigator) that
   the Bedrock Claude Sonnet 4.6 transport migration did not alter prompt
   formatting, token limits, or response parsing in ways that could cause
   silent failures on real incident classes?

3. **What is the acceptable latency and error-rate threshold** for the Bedrock
   transport path, and has a baseline been established from the prior transport
   for comparison?

---

## Alternative architectures (documented for future reference only)

These were surfaced by the investigator and are **not being evaluated for
adoption** until a real failure pattern emerges:

- **LiveKit Agents** — OSS, provider-agnostic, medium integration effort
- **OpenAI Realtime API** — low latency, vendor lock-in concern
- **Pipecat** — modular OSS, high assembly effort
- **Deepgram Voice Agent** — vendor, unknown maturity on this stack

---

## Related

- VTID-03563: Claude always via Bedrock, never direct Anthropic (standing rule)
- VTID-01962: Voice Recurrence Sentinel
- VTID-01963: Voice Architecture Investigator
- VTID-04626: Investigator LLM routing via `callViaRouter`
- Report ID: `0aa7f760-9491-4732-b24d-c47661996703`

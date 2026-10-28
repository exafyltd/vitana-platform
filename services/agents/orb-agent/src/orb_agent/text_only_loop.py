"""L2.2b.2 (VTID-02990): Gemini-via-Vertex text/model loop for the agent's
text-only mode.

What this is
============
The agent's "no STT, no TTS, no audio" proof of life. When
`ORB_AGENT_TEXT_ONLY=true` (default during L2.2b.2), `agent_entrypoint`
skips the full STT/LLM/TTS cascade build + AgentSession start and calls
`run_text_only_self_test` instead. The self-test:

  1. Reads `GOOGLE_CLOUD_PROJECT` + `VERTEX_AI_LOCATION` (or sensible
     defaults). Cloud Run's default service account provides ADC for
     Vertex AI — no API key required.
  2. If the `google-genai` SDK is unavailable → emits
     `model_request_failed` with reason `genai_sdk_not_installed`.
  3. Emits `model_request_started`, calls Gemini with a fixed canary
     prompt at 15s timeout, emits `model_request_succeeded` or
     `_failed` based on outcome.
  4. NEVER raises. Telemetry never blocks the room.

Why Gemini-via-Vertex (not Anthropic)
=====================================
The gateway's Vertex pipeline already uses Google ADC via Cloud Run's
default service account — the same auth path is available to this
service. No new secrets in Secret Manager. Operationally cheaper than
Anthropic for the canary proof. L2.2b.3+ may add Anthropic as an
alternate provider; the boundary in this file makes that drop-in.

Hard rules
==========
- This module NEVER touches STT/TTS/AudioSession code paths. L2.2b.3
  reintroduces those when Deepgram + Cartesia secrets are in place.
- Gemini call uses `google.genai.Client(vertexai=True, ...)`. The
  client lib comes transitively via `livekit-plugins-google`.
- All emits are fire-and-forget. Gemini failures NEVER raise out of
  this function.
- The canary prompt is a fixed short string that doesn't depend on
  conversation state — proves the boundary only.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from .oasis import (
    OasisEmitter,
    TOPIC_AGENT_MODEL_REQUEST_FAILED,
    TOPIC_AGENT_MODEL_REQUEST_STARTED,
    TOPIC_AGENT_MODEL_REQUEST_SUCCEEDED,
)

logger = logging.getLogger(__name__)


VTID = "VTID-02990"

# Fixed canary prompt — proves the boundary without depending on any
# conversation state. Short on purpose so a slow/failing model call
# fails fast rather than hanging the room for a real prompt.
CANARY_PROMPT = (
    "Reply in one short sentence to confirm you are online. "
    "Say: 'L2.2b.2 canary online.'"
)

# Default model. Override via env `ORB_AGENT_L22B2_MODEL`. The fast/cheap
# Gemini lite variant is fine for a one-shot canary call.
DEFAULT_MODEL = "gemini-2.5-flash-lite"

# Hard cap on model call latency. The agent should fail loud rather
# than hang the room indefinitely on a stuck request.
MODEL_TIMEOUT_S = 15.0


async def run_text_only_self_test(
    *,
    oasis: OasisEmitter,
    room_name: str | None,
    code_version: str,
) -> dict[str, Any]:
    """Run one Gemini-via-Vertex round-trip + emit the 3 lifecycle events.

    Returns a small dict describing the outcome (for caller logging /
    optional data-channel publish). NEVER raises.
    """
    project = (os.getenv("GOOGLE_CLOUD_PROJECT") or "lovable-vitana-vers1").strip()
    location = (os.getenv("VERTEX_AI_LOCATION") or "us-central1").strip()
    model = (os.getenv("ORB_AGENT_L22B2_MODEL") or DEFAULT_MODEL).strip()
    base_payload: dict[str, Any] = {
        "room_name": room_name,
        "model": model,
        "provider": "gemini-vertex",
        "project": project,
        "location": location,
        "vtid": VTID,
        "code_version": code_version,
        "prompt_len": len(CANARY_PROMPT),
    }

    # Gate 1: google-genai SDK not installed → typed failure. The lib
    # ships as a transitive dep of livekit-plugins-google in
    # requirements.txt, but this guard exists so import-time smoke
    # checks + non-prod environments never crash.
    try:
        from google import genai  # type: ignore[import-not-found]
    except ImportError as exc:
        logger.warning("L2.2b.2: google-genai SDK not installed: %s", exc)
        await oasis.emit(
            topic=TOPIC_AGENT_MODEL_REQUEST_FAILED,
            payload=dict(
                base_payload,
                reason="genai_sdk_not_installed",
                error=str(exc),
            ),
            vtid=VTID,
        )
        return {"ok": False, "reason": "genai_sdk_not_installed"}

    await oasis.emit(
        topic=TOPIC_AGENT_MODEL_REQUEST_STARTED,
        payload=dict(base_payload, phase="started"),
        vtid=VTID,
    )

    started_at = time.monotonic()
    try:
        client = genai.Client(vertexai=True, project=project, location=location)
    except Exception as exc:  # noqa: BLE001
        latency_ms = int((time.monotonic() - started_at) * 1000)
        logger.warning(
            "L2.2b.2: Gemini client init failed: type=%s err=%s",
            type(exc).__name__,
            exc,
        )
        await oasis.emit(
            topic=TOPIC_AGENT_MODEL_REQUEST_FAILED,
            payload=dict(
                base_payload,
                reason="vertex_client_init_error",
                latency_ms=latency_ms,
                error=str(exc),
                error_type=type(exc).__name__,
            ),
            vtid=VTID,
        )
        return {"ok": False, "reason": "vertex_client_init_error", "latency_ms": latency_ms}

    try:
        # `generate_content` may be sync; wrap in `asyncio.to_thread` so
        # we don't block the asyncio loop, AND wrap in `wait_for` so the
        # canary fails loud at 15s rather than hanging.
        response = await asyncio.wait_for(
            asyncio.to_thread(
                client.models.generate_content,
                model=model,
                contents=CANARY_PROMPT,
            ),
            timeout=MODEL_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        latency_ms = int((time.monotonic() - started_at) * 1000)
        logger.warning("L2.2b.2: Gemini call timed out after %dms", latency_ms)
        await oasis.emit(
            topic=TOPIC_AGENT_MODEL_REQUEST_FAILED,
            payload=dict(
                base_payload,
                reason="timeout",
                latency_ms=latency_ms,
                error=f"Gemini call exceeded {MODEL_TIMEOUT_S}s",
            ),
            vtid=VTID,
        )
        return {"ok": False, "reason": "timeout", "latency_ms": latency_ms}
    except Exception as exc:  # noqa: BLE001
        latency_ms = int((time.monotonic() - started_at) * 1000)
        logger.warning(
            "L2.2b.2: Gemini call failed: type=%s err=%s",
            type(exc).__name__,
            exc,
        )
        await oasis.emit(
            topic=TOPIC_AGENT_MODEL_REQUEST_FAILED,
            payload=dict(
                base_payload,
                reason="vertex_api_error",
                latency_ms=latency_ms,
                error=str(exc),
                error_type=type(exc).__name__,
            ),
            vtid=VTID,
        )
        return {"ok": False, "reason": "vertex_api_error", "latency_ms": latency_ms}

    latency_ms = int((time.monotonic() - started_at) * 1000)
    # Best-effort extract of the response text. google-genai returns
    # responses with a `.text` accessor; defensive against shape changes.
    response_text = ""
    try:
        text_attr = getattr(response, "text", None)
        if isinstance(text_attr, str):
            response_text = text_attr
        else:
            # Fall back to walking candidates → content → parts.
            candidates = getattr(response, "candidates", None) or []
            for cand in candidates:
                content = getattr(cand, "content", None)
                parts = getattr(content, "parts", None) or []
                for part in parts:
                    t = getattr(part, "text", None)
                    if isinstance(t, str):
                        response_text += t
    except Exception:  # noqa: BLE001
        response_text = ""

    await oasis.emit(
        topic=TOPIC_AGENT_MODEL_REQUEST_SUCCEEDED,
        payload=dict(
            base_payload,
            phase="succeeded",
            latency_ms=latency_ms,
            response_len=len(response_text),
            response_preview=response_text[:200],
        ),
        vtid=VTID,
    )
    return {
        "ok": True,
        "response_text": response_text,
        "latency_ms": latency_ms,
        "model": model,
        "provider": "gemini-vertex",
    }


def text_only_mode_enabled(env: dict[str, str] | None = None) -> bool:
    """Read `ORB_AGENT_TEXT_ONLY` env flag. Defaults to True during the
    L2.2b.2 phase so the agent never tries to build the STT/TTS cascade
    against missing Deepgram/Cartesia secrets."""
    src = env if env is not None else os.environ
    raw = (src.get("ORB_AGENT_TEXT_ONLY") or "true").strip().lower()
    return raw in ("true", "1", "yes")

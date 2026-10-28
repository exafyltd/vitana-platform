"""Embedded FastAPI health server — Cloud Run probe target.

Returns 200 with a structured payload that EXEC-DEPLOY's smoke test asserts
against. Mirrors the contract documented in
.claude/plans/here-is-what-our-valiant-stearns.md /api/v1/orb/livekit/health
on the gateway side.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI

logger = logging.getLogger(__name__)


def make_health_app() -> FastAPI:
    app = FastAPI(title="orb-agent-health", version="0.1.0")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "service": "orb-agent",
            "vtid": "VTID-LIVEKIT-FOUNDATION",
            "version": "0.1.0",
            "livekit": {
                "url_configured": bool(os.getenv("LIVEKIT_URL")),
                "api_key_configured": bool(os.getenv("LIVEKIT_API_KEY")),
            },
            "providers": {
                # Each true if the corresponding API key is set; false otherwise.
                # Real reachability probe is the responsibility of the
                # /voice-providers/:id/test endpoint on the gateway.
                "anthropic_configured": bool(os.getenv("ANTHROPIC_API_KEY")),
                "openai_configured": bool(os.getenv("OPENAI_API_KEY")),
                "deepgram_configured": bool(os.getenv("DEEPGRAM_API_KEY")),
                "assemblyai_configured": bool(os.getenv("ASSEMBLYAI_API_KEY")),
                "cartesia_configured": bool(os.getenv("CARTESIA_API_KEY")),
                "elevenlabs_configured": bool(os.getenv("ELEVENLABS_API_KEY")),
            },
            "active_provider_hint": os.getenv("VOICE_ACTIVE_PROVIDER", "vertex"),
        }

    @app.get("/alive")
    async def alive() -> dict[str, bool]:
        return {"ok": True}

    return app

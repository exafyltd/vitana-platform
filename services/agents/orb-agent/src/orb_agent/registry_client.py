"""agents_registry self-register heartbeat client.

Posts to POST /api/v1/agents/registry/heartbeat every 60 s so the gateway's
agents_registry table reflects this service's status. The agent_id used
here MUST match the seed row added by the eventual migration that adds
'orb-agent' to agents_registry.

Mirrors the inline pattern in services/agents/cognee-extractor/main.py:474
and the future shared helper at services/agents/shared/agents_registry_client.py.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

AGENT_ID = "orb-agent"
DISPLAY_NAME = "ORB LiveKit Agent"
DESCRIPTION = (
    "LiveKit-based ORB voice agent worker — standby alternative to the Vertex Live "
    "pipeline (services/gateway/src/routes/orb-live.ts). Joins LiveKit rooms as a "
    "participant and runs a configurable STT/LLM/TTS cascade."
)
TIER = "service"
ROLE = "voice"
SOURCE_PATH = "services/agents/orb-agent/"


class RegistryHeartbeat:
    """Background async task that posts heartbeats."""

    def __init__(
        self,
        gateway_url: str,
        service_token: str,
        *,
        interval_s: int = 60,
        timeout_s: float = 5.0,
    ) -> None:
        self._endpoint = gateway_url.rstrip("/") + "/api/v1/agents/registry/heartbeat"
        self._headers: dict[str, str] = {"Content-Type": "application/json"}
        self._token_present = bool(service_token)
        if service_token:
            self._headers["Authorization"] = f"Bearer {service_token}"
        self._interval_s = interval_s
        self._timeout_s = timeout_s
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        if self._task is None and self._token_present:
            self._task = asyncio.create_task(self._loop())
        elif not self._token_present:
            logger.info("registry_heartbeat.disabled — GATEWAY_SERVICE_TOKEN not set")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
            self._task = None

    async def _loop(self) -> None:
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            while not self._stop.is_set():
                try:
                    await self._post(client, status="healthy")
                except Exception as exc:  # noqa: BLE001
                    logger.warning("agents_registry heartbeat failed: %s", exc)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self._interval_s)
                except TimeoutError:
                    pass

    async def _post(self, client: httpx.AsyncClient, status: str = "healthy") -> None:
        payload: dict[str, Any] = {
            "agent_id": AGENT_ID,
            "display_name": DISPLAY_NAME,
            "description": DESCRIPTION,
            "tier": TIER,
            "role": ROLE,
            "source_path": SOURCE_PATH,
            "status": status,
            "metadata": {
                "language": "python",
                "framework": "livekit-agents",
                "vtid": "VTID-LIVEKIT-FOUNDATION",
            },
        }
        r = await client.post(self._endpoint, json=payload, headers=self._headers)
        if r.status_code >= 400:
            logger.warning(
                "agents_registry heartbeat returned %s: %s", r.status_code, r.text[:200]
            )

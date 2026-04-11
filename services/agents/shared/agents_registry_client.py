"""
Agents Registry Client (Python)

Self-registration helper for FastAPI-based Vitana agent services. Posts a
heartbeat to the Gateway's agents registry on startup, then heartbeats
every 60 seconds in a background task.

NOT YET WIRED into any service — staged for a follow-up.

Usage from a FastAPI service:

    from agents_shared.agents_registry_client import register_agent_with_fastapi

    app = FastAPI(...)

    register_agent_with_fastapi(
        app,
        agent_id="vitana-orchestrator",
        display_name="Vitana Verification Engine",
        tier="service",
        role="verification",
        llm_provider="claude",
        llm_model="claude-3-5-sonnet-20241022",
        source_path="services/agents/vitana-orchestrator/",
        health_endpoint="/health",
    )

Errors are logged but never raised — agent registration must NEVER block
the host service from starting up.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_HEARTBEAT_INTERVAL_S = 60
DEFAULT_HTTP_TIMEOUT_S = 5.0


async def _send_heartbeat(gateway_url: str, payload: Dict[str, Any]) -> bool:
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_HTTP_TIMEOUT_S) as client:
            response = await client.post(
                f"{gateway_url}/api/v1/agents/registry/heartbeat",
                json=payload,
            )
            if response.status_code >= 400:
                logger.warning(
                    "[agents-registry] Heartbeat for %s failed: %d %s",
                    payload.get("agent_id"),
                    response.status_code,
                    response.text[:200],
                )
                return False
            return True
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "[agents-registry] Heartbeat for %s threw: %s",
            payload.get("agent_id"),
            str(e),
        )
        return False


async def _heartbeat_loop(gateway_url: str, agent_id: str, interval_s: int) -> None:
    light_payload: Dict[str, Any] = {"agent_id": agent_id, "status": "healthy"}
    while True:
        try:
            await asyncio.sleep(interval_s)
            await _send_heartbeat(gateway_url, light_payload)
        except asyncio.CancelledError:
            logger.info("[agents-registry] Heartbeat loop cancelled for %s", agent_id)
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("[agents-registry] Heartbeat loop error for %s: %s", agent_id, e)


def register_agent_with_fastapi(
    app: Any,
    *,
    agent_id: str,
    display_name: str,
    tier: str,
    source_path: str,
    description: Optional[str] = None,
    role: Optional[str] = None,
    llm_provider: Optional[str] = None,
    llm_model: Optional[str] = None,
    health_endpoint: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    gateway_url: Optional[str] = None,
    heartbeat_interval_s: int = DEFAULT_HEARTBEAT_INTERVAL_S,
) -> None:
    """Wire agents-registry self-registration into a FastAPI app's lifecycle."""
    resolved_gateway = gateway_url or os.getenv("GATEWAY_URL") or os.getenv("OASIS_GATEWAY_URL")
    if not resolved_gateway:
        logger.warning(
            "[agents-registry] No gateway URL set — self-registration disabled for %s.",
            agent_id,
        )
        return

    full_payload: Dict[str, Any] = {
        "agent_id": agent_id,
        "status": "healthy",
        "display_name": display_name,
        "tier": tier,
        "source_path": source_path,
    }
    if description is not None:
        full_payload["description"] = description
    if role is not None:
        full_payload["role"] = role
    if llm_provider is not None:
        full_payload["llm_provider"] = llm_provider
    if llm_model is not None:
        full_payload["llm_model"] = llm_model
    if health_endpoint is not None:
        full_payload["health_endpoint"] = health_endpoint
    if metadata is not None:
        full_payload["metadata"] = metadata

    state: Dict[str, Any] = {"task": None}

    @app.on_event("startup")
    async def _agents_registry_startup() -> None:  # type: ignore[misc]
        ok = await _send_heartbeat(resolved_gateway, full_payload)
        if ok:
            logger.info("[agents-registry] Registered %s with %s", agent_id, resolved_gateway)
        state["task"] = asyncio.create_task(
            _heartbeat_loop(resolved_gateway, agent_id, heartbeat_interval_s)
        )

    @app.on_event("shutdown")
    async def _agents_registry_shutdown() -> None:  # type: ignore[misc]
        task = state.get("task")
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await _send_heartbeat(
            resolved_gateway,
            {"agent_id": agent_id, "status": "down"},
        )

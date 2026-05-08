"""Context-bootstrap fetcher.

Calls GET /api/v1/orb/context-bootstrap on the gateway, which returns the
exact same payload the Vertex SSE path builds inline — memory garden + role +
last session info + admin briefing + (NEW) the agent's agent_voice_configs row.

Mirrors the `await contextReadyPromise` pattern in orb-live.ts:
the agent does not start the LLM session until context is ready or a 5 s
timeout fires (degraded mode).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

CONTEXT_BOOTSTRAP_TIMEOUT_S = 5.0


@dataclass
class BootstrapResult:
    """Payload returned by the gateway's context-bootstrap endpoint."""

    bootstrap_context: str
    active_role: str | None
    conversation_summary: str | None
    last_turns: str | None
    last_session_info: dict[str, Any] | None
    current_route: str | None
    recent_routes: list[str]
    client_context: dict[str, Any]
    vitana_id: str | None
    voice_config: dict[str, Any] | None  # agent_voice_configs row
    display_name: str | None = None  # full display name from app_users.display_name
    first_name: str | None = None  # first token of display_name (or memory_facts.user_name)
    identity_facts: list[dict[str, Any]] | None = None  # raw memory_facts whitelisted by identity-core keys
    is_degraded: bool = False


class ContextBootstrap:
    def __init__(self, gateway_url: str, service_token: str) -> None:
        self._endpoint = gateway_url.rstrip("/") + "/api/v1/orb/context-bootstrap"
        # VTID-02696: when service_token is empty (smoke deploy without
        # GATEWAY_SERVICE_TOKEN secret) skip the Authorization header
        # entirely instead of sending the malformed 'Bearer ' which httpx
        # rejects with 'Illegal header value'.
        self._headers: dict[str, str] = {}
        if service_token:
            self._headers["Authorization"] = f"Bearer {service_token}"
        self._client = httpx.AsyncClient(timeout=CONTEXT_BOOTSTRAP_TIMEOUT_S)

    async def fetch(
        self,
        *,
        user_jwt: str,
        agent_id: str = "vitana",
        is_reconnect: bool = False,
        last_n_turns: int = 0,
        lang: str | None = None,
    ) -> BootstrapResult:
        params: dict[str, str | int | bool] = {
            "agent_id": agent_id,
            "is_reconnect": is_reconnect,
            "last_n_turns": last_n_turns,
        }
        # VTID-LIVEKIT-AGENT-JWT: prefer the per-session user JWT in the
        # standard Authorization header (the gateway's optionalAuth checks
        # only Bearer). Fall back to the service-token header pre-built in
        # __init__ when no per-session JWT is available (anonymous sessions).
        request_headers: dict[str, str] = dict(self._headers)
        if user_jwt:
            request_headers["Authorization"] = f"Bearer {user_jwt}"
        # PR 1.B-Lang-4: pass the user's language via Accept-Language so the
        # gateway's /orb/context-bootstrap builds the system prompt in the
        # right language. Without this the gateway defaults to 'en' and the
        # LLM keeps responding in English even when the user speaks German.
        if lang:
            request_headers["Accept-Language"] = lang
        try:
            r = await self._client.get(
                self._endpoint,
                params=params,
                headers=request_headers,
            )
            r.raise_for_status()
            data: dict[str, Any] = r.json()
            return BootstrapResult(
                bootstrap_context=data.get("bootstrap_context", ""),
                active_role=data.get("active_role"),
                conversation_summary=data.get("conversation_summary"),
                last_turns=data.get("last_turns"),
                last_session_info=data.get("last_session_info"),
                current_route=data.get("current_route"),
                recent_routes=data.get("recent_routes", []),
                client_context=data.get("client_context", {}),
                vitana_id=data.get("vitana_id"),
                voice_config=data.get("voice_config"),
                display_name=data.get("display_name"),
                first_name=data.get("first_name"),
                identity_facts=data.get("identity_facts") or [],
                is_degraded=False,
            )
        except (httpx.TimeoutException, httpx.HTTPError) as exc:
            logger.warning("context-bootstrap fetch failed: %s — entering degraded mode", exc)
            return BootstrapResult(
                bootstrap_context="",
                active_role=None,
                conversation_summary=None,
                last_turns=None,
                last_session_info=None,
                current_route=None,
                recent_routes=[],
                client_context={},
                vitana_id=None,
                voice_config=None,
                is_degraded=True,
            )

    async def aclose(self) -> None:
        await self._client.aclose()

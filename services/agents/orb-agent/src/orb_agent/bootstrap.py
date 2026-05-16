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
    # L2.2b.6 (VTID-03010): the gateway now renders the full Vertex
    # buildLiveSystemInstruction output and returns it here. session.py
    # uses this verbatim — no parallel Python builder. None if the gateway
    # render failed or the field isn't present (pre-L2.2b.6 gateway).
    system_instruction: str | None = None
    # L2.2b.6 (VTID-03010): Life Compass row for cockpit / tooling inspection.
    # Already inlined into bootstrap_context; this field is for tooling.
    life_compass: dict[str, Any] | None = None
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

    async def fetch_greeting(
        self,
        *,
        user_jwt: str,
        agent_id: str = "vitana",
        lang: str | None = None,
        client_ip: str | None = None,
    ) -> BootstrapResult:
        """VTID-03017: greeting-critical fast path.

        Calls /orb/context-bootstrap?greeting_only=true so the gateway skips
        the slow render work (bootstrap_context compile, system_instruction
        render, identity_facts compile, life_compass, decision_context).
        Returns a BootstrapResult populated with ONLY:
          - voice_config (per-agent STT/LLM/TTS row, needed for cascade)
          - first_name + display_name + vitana_id (for the templated greeting)
          - active_role (for the placeholder system prompt)
        Slow-context fields are left empty; caller is expected to background
        a separate `.fetch(...)` call to hydrate them post-greeting.

        Total cost: ~150–300ms (2 Supabase row lookups). Compare to the full
        fetch at 500ms–1s.
        """
        return await self._do_fetch(
            user_jwt=user_jwt,
            agent_id=agent_id,
            lang=lang,
            client_ip=client_ip,
            is_reconnect=False,
            last_n_turns=0,
            greeting_only=True,
        )

    async def fetch(
        self,
        *,
        user_jwt: str,
        agent_id: str = "vitana",
        is_reconnect: bool = False,
        last_n_turns: int = 0,
        lang: str | None = None,
        client_ip: str | None = None,
        handoff_summary: str | None = None,
    ) -> BootstrapResult:
        return await self._do_fetch(
            user_jwt=user_jwt,
            agent_id=agent_id,
            lang=lang,
            client_ip=client_ip,
            is_reconnect=is_reconnect,
            last_n_turns=last_n_turns,
            greeting_only=False,
            handoff_summary=handoff_summary,
        )

    async def _do_fetch(
        self,
        *,
        user_jwt: str,
        agent_id: str,
        lang: str | None,
        client_ip: str | None,
        is_reconnect: bool,
        last_n_turns: int,
        greeting_only: bool,
        handoff_summary: str | None = None,
    ) -> BootstrapResult:
        params: dict[str, str | int | bool] = {
            "agent_id": agent_id,
            "is_reconnect": is_reconnect,
            "last_n_turns": last_n_turns,
        }
        if greeting_only:
            params["greeting_only"] = True
        # VTID-03027: when the agent is rebuilding the session for a
        # specialist persona after a report_to_specialist handoff, pass
        # the user's brief through to the gateway so the persona's
        # rendered system_instruction includes a [HANDOFF NOTE] section.
        # Without this, Devon would have to ask "what's the issue?" again,
        # since he wouldn't know what Vitana already heard.
        if handoff_summary:
            params["handoff_summary"] = handoff_summary[:2000]
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
        # VTID-03014 + VTID-03022: forward the user's real client IP captured
        # at token mint time. Sent via BOTH X-Forwarded-For AND X-Real-IP.
        #
        # Why both:
        # The agent→gateway hop traverses Cloud Run's internal load balancer,
        # which AUTOMATICALLY adds an X-Forwarded-For header on every request
        # naming the AGENT's us-central1 egress IP. The gateway's
        # orb-live.ts:getClientIP reads X-Forwarded-For FIRST (splits on
        # comma, takes [0]):
        #
        #   - X-Real-IP only: Cloud Run synthesizes XFF = "<agent_google_ip>"
        #     and X-Real-IP gets ignored by getClientIP precedence
        #     → gateway resolves "Council Bluffs, United States"
        #       (us-central1 datacenter, observed in VTID-03021 traces).
        #
        #   - X-Forwarded-For set explicitly: Cloud Run preserves and
        #     APPENDS its IP → XFF = "<user_ip>, <agent_google_ip>".
        #     getClientIP splits on comma, takes [0] = user's IP.
        #     → gateway resolves the user's real city.
        #
        # X-Real-IP stays as a redundant fallback for environments where
        # XFF gets stripped or rewritten.
        if client_ip:
            request_headers["X-Forwarded-For"] = client_ip
            request_headers["X-Real-IP"] = client_ip
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
                # L2.2b.6 (VTID-03010): full Vertex-rendered system instruction.
                # Pre-L2.2b.6 gateways won't include this field — `.get()`
                # defaults to None and session.py falls back to the legacy
                # build_live_system_instruction passthrough.
                system_instruction=data.get("system_instruction"),
                life_compass=data.get("life_compass"),
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

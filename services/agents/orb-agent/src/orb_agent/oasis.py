"""OASIS event emitter — POSTs to the gateway's /api/v1/oasis/emit endpoint.

Topic naming follows the parity contract in voice-pipeline-spec/spec.json.
The libcst extractor walks every `oasis.emit(topic=...)` call site and feeds
it to the parity scanner — so use string literals, not f-strings or
variables, for the topic argument when you want it visible to the scanner.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class OasisEmitter:
    """Thin async client that POSTs OASIS events to the gateway."""

    def __init__(self, gateway_url: str, service_token: str, *, timeout_s: float = 5.0) -> None:
        self._endpoint = gateway_url.rstrip("/") + "/api/v1/oasis/emit"
        self._headers: dict[str, str] = {"Content-Type": "application/json"}
        if service_token:
            self._headers["Authorization"] = f"Bearer {service_token}"
        self._token_present = bool(service_token)
        self._client = httpx.AsyncClient(timeout=timeout_s)

    async def emit(
        self,
        *,
        topic: str,
        payload: dict[str, Any] | None = None,
        vtid: str | None = None,
    ) -> None:
        """Fire-and-log emit. Errors are logged, never raised — telemetry must
        never break the voice path."""
        body = {"topic": topic, "payload": payload or {}, "vtid": vtid}
        if not self._token_present:
            # No service token configured — skip the network call entirely
            # rather than spamming logs every time. Telemetry comes back
            # online when GATEWAY_SERVICE_TOKEN is set.
            return
        try:
            r = await self._client.post(self._endpoint, json=body, headers=self._headers)
            if r.status_code >= 400:
                logger.warning("oasis emit failed: topic=%s status=%s", topic, r.status_code)
        except Exception as exc:
            logger.warning("oasis emit exception: topic=%s err=%s", topic, exc)

    async def aclose(self) -> None:
        await self._client.aclose()


# Common topic constants — keep these as module-level string literals so the
# libcst extractor can walk them. Topics not in this list are also valid;
# this list is just for readability / IDE autocomplete.
TOPIC_SESSION_START = "livekit.session.start"
TOPIC_SESSION_STOP = "livekit.session.stop"
TOPIC_TOOL_EXECUTED = "livekit.tool.executed"
TOPIC_TOOL_LOOP_GUARD = "livekit.tool_loop_guard_activated"
TOPIC_STALL_DETECTED = "livekit.stall_detected"
TOPIC_CONNECTION_FAILED = "livekit.connection_failed"
TOPIC_CONFIG_MISSING = "livekit.config_missing"
TOPIC_PROVIDER_QUOTA_EXCEEDED = "livekit.provider_quota_exceeded"
TOPIC_PROVIDER_FAILOVER = "livekit.provider_failover"
TOPIC_CONTEXT_BOOTSTRAP = "livekit.context.bootstrap"
TOPIC_CONTEXT_BOOTSTRAP_SKIPPED = "livekit.context.bootstrap.skipped"
TOPIC_HANDOFF_START = "voice.handoff.start"
TOPIC_HANDOFF_COMPLETE = "voice.handoff.complete"
TOPIC_HANDOFF_FAILED = "voice.handoff.failed"
TOPIC_PERSONA_SWAP = "agent.voice.persona_swap"

# L2.2b.1 (VTID-02987): backend orb-agent lifecycle observability. Emitted at
# the earliest possible points in `agent_entrypoint` so any failure joining
# the LiveKit room is visible in OASIS without needing logs. These 5 topics
# are also added to the gateway's CicdEventType union; the gateway's
# POST /api/v1/oasis/emit route allowlists the `orb.livekit.` prefix.
TOPIC_AGENT_STARTING = "orb.livekit.agent.starting"
TOPIC_AGENT_ROOM_JOIN_STARTED = "orb.livekit.agent.room_join_started"
TOPIC_AGENT_ROOM_JOIN_SUCCEEDED = "orb.livekit.agent.room_join_succeeded"
TOPIC_AGENT_ROOM_JOIN_FAILED = "orb.livekit.agent.room_join_failed"
TOPIC_AGENT_DISCONNECTED = "orb.livekit.agent.disconnected"

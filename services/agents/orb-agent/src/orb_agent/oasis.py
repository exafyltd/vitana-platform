"""OASIS event emitter — POSTs to the gateway's /api/v1/oasis/emit endpoint.

Topic naming follows the parity contract in voice-pipeline-spec/spec.json.
The libcst extractor walks every `oasis.emit(topic=...)` call site and feeds
it to the parity scanner — so use string literals, not f-strings or
variables, for the topic argument when you want it visible to the scanner.

VTID-02986 (LiveKit Voice Lab parity): session-lifecycle topics renamed
from `livekit.*` → `vtid.live.*` so Voice Lab's `/live/sessions` route
(which filters on `topic IN ('voice.live.session.started', 'vtid.live.session.start', ...)`
plus `vtid IN ('VTID-01218A', 'VTID-01155', 'VTID-LIVEKIT-AGENT', ...)`)
surfaces LiveKit sessions next to Vertex ones in the same panel. The
emitter also now logs a WARNING on missing GATEWAY_SERVICE_TOKEN
instead of silently returning — telemetry must fail LOUD, not silent.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# VTID-02986: default VTID stamped on every emit so Voice Lab's vtid IN
# filter (voice-lab.ts:166) returns the row. Keep this stable — adding it
# to a new allowlist entry is a one-line change there.
DEFAULT_VTID = "VTID-LIVEKIT-AGENT"


class OasisEmitter:
    """Thin async client that POSTs OASIS events to the gateway."""

    def __init__(self, gateway_url: str, service_token: str, *, timeout_s: float = 5.0) -> None:
        self._endpoint = gateway_url.rstrip("/") + "/api/v1/oasis/emit"
        self._headers: dict[str, str] = {"Content-Type": "application/json"}
        if service_token:
            self._headers["Authorization"] = f"Bearer {service_token}"
        self._token_present = bool(service_token)
        self._client = httpx.AsyncClient(timeout=timeout_s)
        # VTID-02986: log the missing-token state ONCE at construction so
        # the operator sees it in Cloud Run logs immediately, not buried in
        # per-emit warnings. Still fail loud on each emit too — silent
        # telemetry is how the LiveKit stall_detected signal disappeared.
        self._missing_token_warned = False
        if not self._token_present:
            logger.warning(
                "OasisEmitter: GATEWAY_SERVICE_TOKEN not set — every emit will be "
                "skipped and logged as 'token_missing'. Set the env var on the "
                "orb-agent Cloud Run service to restore session telemetry "
                "(vtid.live.session.start/stop, vtid.live.stall_detected, etc.).",
            )

    async def emit(
        self,
        *,
        topic: str,
        payload: dict[str, Any] | None = None,
        vtid: str | None = None,
    ) -> None:
        """Fire-and-log emit. Errors are logged, never raised — telemetry must
        never break the voice path.

        VTID-02986: when GATEWAY_SERVICE_TOKEN is unset, log a WARNING per
        emit (not a silent return). The previous silent path is why the
        LiveKit pipeline appeared functional while session.start/stop and
        stall_detected events never landed in oasis_events — Voice Lab had
        no signal to display, and operators had no way to know.
        """
        effective_vtid = vtid or DEFAULT_VTID
        body = {"topic": topic, "payload": payload or {}, "vtid": effective_vtid}
        if not self._token_present:
            logger.warning(
                "oasis emit skipped (token_missing): topic=%s vtid=%s",
                topic,
                effective_vtid,
            )
            return
        try:
            r = await self._client.post(self._endpoint, json=body, headers=self._headers)
            if r.status_code >= 400:
                logger.warning(
                    "oasis emit failed: topic=%s vtid=%s status=%s body=%s",
                    topic,
                    effective_vtid,
                    r.status_code,
                    (r.text or "")[:200],
                )
        except Exception as exc:
            logger.warning(
                "oasis emit exception: topic=%s vtid=%s err=%s", topic, effective_vtid, exc,
            )

    async def aclose(self) -> None:
        await self._client.aclose()


# Common topic constants — keep these as module-level string literals so the
# libcst extractor can walk them.
#
# VTID-02986: session-lifecycle topics moved to `vtid.live.*` namespace
# (matching Vertex's orb-live.ts emitter at orb-live.ts:11838 / 12207)
# so Voice Lab's /api/v1/voice-lab/live/sessions endpoint surfaces both
# providers in the same panel. Non-lifecycle topics stay on `livekit.*`
# because they're LiveKit-specific (stall, tool execution, provider
# events) and don't have a Vertex counterpart in the Voice Lab query.
TOPIC_SESSION_START = "vtid.live.session.start"
TOPIC_SESSION_STOP = "vtid.live.session.stop"
TOPIC_STALL_DETECTED = "vtid.live.stall_detected"
TOPIC_TOOL_EXECUTED = "livekit.tool.executed"
# BOOTSTRAP-VOICE-DATASET-EMITTER (LiveKit parity): voice-tool-routing dataset
# source. The agent emits a RAW payload (reply_text + raw transcript + tool
# signal + user/tenant ids); the gateway's /api/v1/oasis/emit re-runs the same
# consent/PII gate the Vertex path uses before persisting — no unconsented
# transcript is ever stored. Extractor reads oasis_events WHERE topic = this.
TOPIC_TURN_RESPONDED = "orb.turn.responded"
TOPIC_TOOL_LOOP_GUARD = "livekit.tool_loop_guard_activated"
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

# L2.2b.2 (VTID-02990): Gemini-via-Vertex text/model loop telemetry.
# Emitted by the agent's text-only self-test path (`ORB_AGENT_TEXT_ONLY=true`)
# so the agent/model boundary is provable without any STT/TTS providers and
# without any new API keys (Cloud Run's default service account provides
# Vertex ADC). The 3 events fire in order:
#   model_request_started → (model_request_succeeded | model_request_failed)
# Failure payload includes a typed `reason` (genai_sdk_not_installed,
# vertex_client_init_error, vertex_api_error, timeout) plus the underlying
# error string.
TOPIC_AGENT_MODEL_REQUEST_STARTED = "orb.livekit.agent.model_request_started"
TOPIC_AGENT_MODEL_REQUEST_SUCCEEDED = "orb.livekit.agent.model_request_succeeded"
TOPIC_AGENT_MODEL_REQUEST_FAILED = "orb.livekit.agent.model_request_failed"

# VTID-03046: per-turn diagnostic. Captures the gap between STT-finalize
# (user_input_transcribed) and the agent's speech_created event — the
# wall-clock "wait after the user stops talking" the user actually feels.
# Payload also carries `system_instruction_chars` so we can correlate
# per-turn latency with prompt size and prove (or disprove) that
# system_instruction growth is what slowed the cascade after 2026-05-16.
TOPIC_AGENT_TURN_MEASURED = "orb.livekit.agent.turn.measured"

# VTID-03050: STT failure observability. The cascade build_cascade returns a
# `livekit.agents.stt.FallbackAdapter` wrapping 3 instances (Google primary +
# Google mirror + Deepgram, from VTID-03038/03041). The adapter is supposed
# to swap on STT failure — but until now no telemetry surfaced WHEN it
# swaps, WHICH instance died, or WHAT error class the SDK saw. These three
# topics close that gap. On the live debugging side, grep oasis_events for
# `livekit.stt.*` to see the per-instance health timeline of any session.
TOPIC_STT_ERROR = "livekit.stt.error"                           # SDK ErrorEvent from STT/LLM/TTS, source-typed
TOPIC_STT_AVAILABILITY_CHANGED = "livekit.stt.availability_changed"  # FallbackAdapter swap or recovery
TOPIC_STT_METRICS = "livekit.stt.metrics"                       # metrics_collected from STT subsystem

# VTID-03075: agent-level silent-stall detection. Fires when VAD reports
# user_state_changed → "speaking" but no `user_input_transcribed` event
# appears within SILENT_STALL_THRESHOLD_S seconds. The cascade
# FallbackAdapter can't help — it swaps on errors only, and the silent-buffer
# failure produces none. Pairs with a `client.alert.show` data message
# published into the LiveKit room so the Test Bench frontend can render a
# "Hold on, reconnecting…" banner + an audio chime mirroring Vertex's
# INSTANT-FEEDBACK behavior.
TOPIC_STT_SILENT_STALL = "livekit.stt.silent_stall"

# VTID-03078: STT recovery telemetry. Fires when the silent-stall watchdog
# decides to attempt an in-place STT swap (build fresh cascade →
# session.update_agent with a new Agent carrying stt=fresh + preserved
# llm/tts/instructions/tools/chat_ctx). Outcomes:
#   - `attempted`: swap scheduled. Includes per-session attempt count.
#   - `succeeded`: a user_input_transcribed event arrived within the
#     recovery verify window after the swap completed.
#   - `gave_up`: per-session max swap count reached. We stop trying.
TOPIC_STT_RECOVERY = "livekit.stt.recovery"

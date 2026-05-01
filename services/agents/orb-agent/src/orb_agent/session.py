"""Agent session lifecycle.

Owns: agent joins room → fetch context-bootstrap → build system instruction
→ instantiate STT/LLM/TTS via providers.py → start the livekit-agents
VoicePipelineAgent → on every model turn, call transcript-append on the
gateway → on session end, call /session/finalize.

Also owns the **persona-swap path** (multi-specialist handoff) — when the
LLM calls report_to_specialist or the gateway pushes a switch message:

  1. Emit voice.handoff.start
  2. Play bridge cue in *current* voice
  3. Fetch new agent's voice config + system prompt via context-bootstrap
  4. Swap LLM + TTS plugin instances in-place (STT keeps running)
  5. Update room metadata (active_specialist=new_id)
  6. Emit voice.handoff.complete

Skeleton today: structural scaffolding + lifecycle hooks. Real
livekit-agents wiring lands in a follow-up PR.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .bootstrap import BootstrapResult, ContextBootstrap
from .config import AgentConfig
from .identity import Identity
from .instructions import build_anonymous_system_instruction, build_live_system_instruction
from .oasis import (
    TOPIC_HANDOFF_COMPLETE,
    TOPIC_HANDOFF_START,
    TOPIC_PERSONA_SWAP,
    TOPIC_SESSION_START,
    TOPIC_SESSION_STOP,
    OasisEmitter,
)
from .providers import ResolvedCascade, build_cascade
from .watchdogs import ReconnectBucket

logger = logging.getLogger(__name__)


@dataclass
class SessionContext:
    """Per-session mutable state."""

    orb_session_id: str
    identity: Identity
    bootstrap: BootstrapResult
    cascade: ResolvedCascade
    active_agent_id: str
    reconnect_bucket: ReconnectBucket


class AgentSession:
    """Owns one user voice session end-to-end."""

    def __init__(self, cfg: AgentConfig, oasis: OasisEmitter, ctx_fetcher: ContextBootstrap) -> None:
        self._cfg = cfg
        self._oasis = oasis
        self._ctx_fetcher = ctx_fetcher

    async def start(self, *, room_metadata: dict, user_jwt: str) -> SessionContext:
        """Bootstrap a session for the user identified by `room_metadata`.

        TODO(VTID-LIVEKIT-FOUNDATION): wire this into the livekit-agents
        worker entrypoint. For now this is a structural placeholder that
        future PRs flesh out.
        """
        from .identity import resolve_identity_from_room_metadata  # local import for testability

        identity = resolve_identity_from_room_metadata(room_metadata, user_jwt=user_jwt)
        agent_id = str(room_metadata.get("agent_id", "vitana"))

        bootstrap = await self._ctx_fetcher.fetch(
            user_jwt=user_jwt, agent_id=agent_id, is_reconnect=False, last_n_turns=0
        )
        cascade = build_cascade(bootstrap.voice_config)

        # System instruction selected based on whether identity is anonymous.
        if identity.is_anonymous:
            sys_prompt = build_anonymous_system_instruction(
                lang=identity.lang, voice_style="warm", ctx=bootstrap.client_context
            )
        else:
            sys_prompt = build_live_system_instruction(
                lang=identity.lang,
                voice_style="warm",
                bootstrap_context=bootstrap.bootstrap_context,
                active_role=bootstrap.active_role or identity.role,
                conversation_summary=bootstrap.conversation_summary,
                conversation_history=bootstrap.last_turns,
                is_reconnect=False,
                last_session_info=None,
                current_route=bootstrap.current_route,
                recent_routes=bootstrap.recent_routes,
                client_context=bootstrap.client_context,
                vitana_id=bootstrap.vitana_id or identity.vitana_id,
            )

        await self._oasis.emit(
            topic=TOPIC_SESSION_START,
            payload={
                "user_id": identity.user_id,
                "tenant_id": identity.tenant_id,
                "agent_id": agent_id,
                "lang": identity.lang,
                "is_mobile": identity.is_mobile,
                "stt": bootstrap.voice_config.get("stt_provider") if bootstrap.voice_config else None,
                "llm": bootstrap.voice_config.get("llm_provider") if bootstrap.voice_config else None,
                "tts": bootstrap.voice_config.get("tts_provider") if bootstrap.voice_config else None,
            },
        )

        # TODO(VTID-LIVEKIT-FOUNDATION): instantiate livekit.agents.VoicePipelineAgent
        # with sys_prompt + cascade.{stt,llm,tts} + tools from tools.py.
        logger.info(
            "AgentSession started (skeleton): user=%s agent=%s sys_prompt_len=%d cascade_notes=%s",
            identity.user_id,
            agent_id,
            len(sys_prompt),
            cascade.notes,
        )

        return SessionContext(
            orb_session_id=str(room_metadata.get("orb_session_id", "")),
            identity=identity,
            bootstrap=bootstrap,
            cascade=cascade,
            active_agent_id=agent_id,
            reconnect_bucket=ReconnectBucket(),
        )

    async def handoff_to_specialist(
        self,
        *,
        ctx: SessionContext,
        target_agent_id: str,
        reason: str,
        context_summary: str,
    ) -> SessionContext:
        """Persona-swap path. Mid-session, swap LLM + TTS for the new specialist;
        STT and the room remain. Bridge cue plays in the CURRENT voice before swap.
        """
        await self._oasis.emit(
            topic=TOPIC_HANDOFF_START,
            payload={
                "from_agent_id": ctx.active_agent_id,
                "to_agent_id": target_agent_id,
                "reason": reason,
                "context_summary": context_summary,
                "user_id": ctx.identity.user_id,
            },
        )

        # TODO(VTID-LIVEKIT-FOUNDATION): play bridge cue via current TTS,
        # then re-fetch context-bootstrap with new agent_id, swap llm + tts
        # plugins, update room metadata.

        new_bootstrap = await self._ctx_fetcher.fetch(
            user_jwt="",  # will be re-resolved from room metadata in real impl
            agent_id=target_agent_id,
            is_reconnect=True,
            last_n_turns=10,
        )
        new_cascade = build_cascade(new_bootstrap.voice_config)

        await self._oasis.emit(
            topic=TOPIC_PERSONA_SWAP,
            payload={
                "room_id": ctx.orb_session_id,
                "agent_id": target_agent_id,
                "tts_provider": (new_bootstrap.voice_config or {}).get("tts_provider"),
                "tts_model": (new_bootstrap.voice_config or {}).get("tts_model"),
            },
        )
        await self._oasis.emit(
            topic=TOPIC_HANDOFF_COMPLETE,
            payload={
                "from_agent_id": ctx.active_agent_id,
                "to_agent_id": target_agent_id,
                "latency_ms": 0,  # TODO: measure real swap latency
            },
        )

        return SessionContext(
            orb_session_id=ctx.orb_session_id,
            identity=ctx.identity,
            bootstrap=new_bootstrap,
            cascade=new_cascade,
            active_agent_id=target_agent_id,
            reconnect_bucket=ctx.reconnect_bucket,
        )

    async def stop(self, ctx: SessionContext) -> None:
        await self._oasis.emit(
            topic=TOPIC_SESSION_STOP,
            payload={
                "user_id": ctx.identity.user_id,
                "agent_id": ctx.active_agent_id,
                "orb_session_id": ctx.orb_session_id,
            },
        )

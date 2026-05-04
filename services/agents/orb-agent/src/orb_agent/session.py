"""Agent session lifecycle — real livekit-agents wiring.

Owns the entire room lifecycle:

  1. agent_entrypoint(ctx) is called by livekit-agents when the SFU
     dispatches a room job to this worker.
  2. Read room metadata → resolve identity (mobile-community coercion).
  3. Fetch context-bootstrap via gateway.
  4. Build system instruction (build_live or build_anonymous).
  5. Instantiate STT/LLM/TTS via providers.build_cascade().
  6. Create livekit-agents Agent + AgentSession with the tool catalogue,
     userdata=GatewayClient (so tools can call the gateway with the
     user's JWT).
  7. AgentSession runs the voice pipeline. Tools fire as @function_tool
     calls, OASIS events emit on key transitions.
  8. On report_to_specialist tool call → swap LLM + TTS in place.
  9. On disconnect → emit livekit.session.stop, OASIS finalize.

If livekit-agents isn't installed (test env), the entrypoint becomes a
no-op that just emits a session.start/stop pair so the gateway can see
the agent is alive.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from .bootstrap import ContextBootstrap
from .config import AgentConfig
from .gateway_client import GatewayClient
from .identity import resolve_identity_from_room_metadata
from .instructions import (
    build_anonymous_system_instruction,
    build_live_system_instruction,
)
from .oasis import (
    TOPIC_HANDOFF_COMPLETE,
    TOPIC_HANDOFF_START,
    TOPIC_PERSONA_SWAP,
    TOPIC_SESSION_START,
    TOPIC_SESSION_STOP,
    OasisEmitter,
)
from .providers import build_cascade
from .tools import all_tools

logger = logging.getLogger(__name__)

# Tool-loop guard threshold (matches Vertex VTID-TOOLGUARD). livekit-agents'
# AgentSession enforces tool_choice='none' once max_tool_steps consecutive
# tool calls happen without the LLM emitting an audio response.
MAX_TOOL_STEPS = 5


# livekit-agents primitives, lazily imported so unit tests on the rest of
# the agent code don't need the full SDK.
try:
    from livekit.agents import Agent, AgentSession, JobContext  # type: ignore[import-not-found]
    LK_AVAILABLE = True
except ImportError:
    Agent = AgentSession = JobContext = None  # type: ignore[assignment,misc]
    LK_AVAILABLE = False


async def agent_entrypoint(ctx: "JobContext") -> None:
    """livekit-agents JobContext entrypoint.

    Called by `cli.run_app(WorkerOptions(entrypoint_fnc=...))` for every
    new room dispatch. Owns the full session lifecycle.
    """
    if not LK_AVAILABLE:
        logger.warning("agent_entrypoint called but livekit-agents not installed")
        return

    cfg = AgentConfig.from_env()
    oasis = OasisEmitter(gateway_url=cfg.gateway_url, service_token=cfg.gateway_service_token)
    ctx_fetcher = ContextBootstrap(
        gateway_url=cfg.gateway_url, service_token=cfg.gateway_service_token
    )

    # Connect to the room first — required to read remote participant
    # metadata. The orb-agent itself does not publish; the user is the
    # publisher.
    await ctx.connect()

    # Read room metadata: the gateway's /orb/livekit/token endpoint
    # embeds resolved identity here.
    metadata_str = ctx.room.metadata or ""
    try:
        metadata = json.loads(metadata_str) if metadata_str else {}
    except (json.JSONDecodeError, TypeError):
        metadata = {}

    # VTID-LIVEKIT-AGENT-JWT: the gateway's /orb/livekit/token endpoint
    # mints a short-lived Supabase JWT for this user and embeds it as
    # `user_jwt` in the room metadata. Same secret + claim shape as the
    # user's normal JWT, so existing optionalAuth/requireAuth middleware on
    # every gateway tool endpoint validates it transparently. Anonymous
    # sessions get null and most tool calls will return 401, which is
    # acceptable (anonymous users don't have authoritative tools).
    user_jwt = (
        os.getenv("AGENT_USER_JWT_OVERRIDE")  # dev override beats metadata
        or metadata.get("user_jwt")
        or None
    )
    if not user_jwt:
        logger.info("agent_entrypoint: no user_jwt in metadata — tool calls will be anonymous")
    gw = GatewayClient(
        base_url=cfg.gateway_url,
        user_jwt=user_jwt,
        service_token=cfg.gateway_service_token,
    )

    identity = resolve_identity_from_room_metadata(metadata)
    agent_id = str(metadata.get("agent_id", "vitana"))
    orb_session_id = str(metadata.get("orb_session_id", ""))

    # Fetch the merged context (memory + role + agent voice config).
    bootstrap = await ctx_fetcher.fetch(
        user_jwt=user_jwt or "",
        agent_id=agent_id,
        is_reconnect=False,
        last_n_turns=0,
    )

    # System instruction.
    if identity.is_anonymous:
        sys_prompt = build_anonymous_system_instruction(
            lang=identity.lang,
            voice_style="warm",
            ctx=bootstrap.client_context,
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

    # Cascade.
    cascade = build_cascade(bootstrap.voice_config)

    # OASIS session start.
    await oasis.emit(
        topic=TOPIC_SESSION_START,
        payload={
            "user_id": identity.user_id,
            "tenant_id": identity.tenant_id,
            "agent_id": agent_id,
            "lang": identity.lang,
            "is_mobile": identity.is_mobile,
            "orb_session_id": orb_session_id,
            "stt": (bootstrap.voice_config or {}).get("stt_provider"),
            "llm": (bootstrap.voice_config or {}).get("llm_provider"),
            "tts": (bootstrap.voice_config or {}).get("tts_provider"),
        },
    )

    # Tool catalogue from tools.py — every @function_tool-decorated async
    # function in the module, exported via all_tools(). Each tool body is a
    # thin async call to a gateway endpoint via the GatewayClient carried on
    # RunContext.userdata (set on AgentSession below).
    #
    # VTID-LIVEKIT-TOOLS root cause: the earlier blocker was a wrong import
    # path in tools.py (`from livekit.agents.llm import RunContext` no longer
    # exists in livekit-agents 1.x; RunContext moved to `livekit.agents`). The
    # try/except ImportError fallback was substituting a no-op decorator that
    # returned the raw function, which AgentSession then rejected. Fix landed
    # in tools.py's import block; tools list is now real.
    agent = Agent(
        instructions=sys_prompt,
        tools=list(all_tools()),
    )

    # AgentSession glues together STT + LLM + TTS + the room. userdata
    # carries the per-session GatewayClient so each tool body can pull it off
    # RunContext.userdata. max_tool_steps is the tool-loop guard threshold.
    session = AgentSession(
        stt=cascade.stt,
        llm=cascade.llm,
        tts=cascade.tts,
        userdata=gw,
        max_tool_steps=MAX_TOOL_STEPS,
    )

    # Wire teardown for AFTER the room disconnects, not for after start()
    # returns. AgentSession.start() exits as soon as the room IO and the
    # background tasks are wired (it does NOT block until disconnect — it
    # returns RunResult|None). If we close GatewayClient/OasisEmitter in a
    # bare `finally:` here, every tool call lands on a closed client and
    # the session telemetry stops half a second after it began. Move the
    # cleanup to ctx.add_shutdown_callback so it fires when the room ends.
    disconnected_evt = asyncio.Event()

    async def _teardown() -> None:
        try:
            await oasis.emit(
                topic=TOPIC_SESSION_STOP,
                payload={
                    "user_id": identity.user_id,
                    "agent_id": agent_id,
                    "orb_session_id": orb_session_id,
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("session.stop oasis emit failed: %s", exc)
        try:
            await gw.aclose()
        except Exception:  # noqa: BLE001
            pass
        try:
            await ctx_fetcher.aclose()
        except Exception:  # noqa: BLE001
            pass
        try:
            await oasis.aclose()
        except Exception:  # noqa: BLE001
            pass
        disconnected_evt.set()

    ctx.add_shutdown_callback(_teardown)

    try:
        await session.start(agent=agent, room=ctx.room)
    except Exception as exc:  # noqa: BLE001
        logger.exception("AgentSession.start crashed: %s", exc)
        return

    # Initial greeting — fire as soon as the session is ready so the user
    # hears their personalized hello on connect. Mirrors the Vertex pipeline
    # behaviour (orb-live.ts opens with a generated greeting). The
    # bootstrap_context already has the user's display_name / vitana_id /
    # verified facts, so the LLM can reach into the prompt and pull the
    # right name without an extra tool call.
    if not identity.is_anonymous:
        try:
            await session.generate_reply(
                instructions=(
                    "Greet the user warmly RIGHT NOW. Pull their first name from "
                    "the verified-facts block of your context (look for "
                    "`user_name` or the `Authoritative identity` line). Confirm "
                    "you recognize them by mentioning their @vitana_id handle. "
                    "Keep it ONE short sentence followed by a brief 'what can I "
                    "help with?'. If — and ONLY if — neither a name nor a "
                    f"@vitana_id is present, fall back to: 'Hi! I'm Vitana — "
                    f"signed in as {identity.user_id[:8]}…, what can I help with "
                    "today?'."
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("initial greeting generate_reply failed: %s", exc)
    else:
        try:
            await session.generate_reply(
                instructions=(
                    "Greet the visitor briefly as Vitana. They are not signed "
                    "in, so do not invent personal details. Offer to help with "
                    "general questions or guide them to sign in for personalized "
                    "answers. One short sentence."
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("anonymous greeting generate_reply failed: %s", exc)

    # Park here until the room disconnects. The AgentSession keeps running
    # autonomously via the tasks it spawned in start(); we just need to
    # keep the entrypoint alive so the shutdown callback above fires at
    # the right moment.
    await disconnected_evt.wait()


# ---------------------------------------------------------------------------
# Persona-swap helper — invoked from the report_to_specialist tool body once
# the gateway responds with the new agent_id. Swaps LLM + TTS plugin
# instances in-place; STT and the room continue.
# ---------------------------------------------------------------------------


async def perform_handoff(
    *,
    session: "AgentSession",
    oasis: OasisEmitter,
    ctx_fetcher: ContextBootstrap,
    user_jwt: str,
    user_id: str,
    orb_session_id: str,
    from_agent_id: str,
    to_agent_id: str,
    reason: str,
    context_summary: str,
) -> None:
    """Swap to a new specialist mid-session. STT/mic continue; LLM+TTS swap."""
    await oasis.emit(
        topic=TOPIC_HANDOFF_START,
        payload={
            "from_agent_id": from_agent_id,
            "to_agent_id": to_agent_id,
            "reason": reason,
            "context_summary": context_summary,
            "user_id": user_id,
            "orb_session_id": orb_session_id,
        },
    )

    # Bridge cue plays in CURRENT voice before swap (livekit-agents
    # session.say() blocks until audio is queued).
    try:
        await session.say(
            f"Transferring you to {to_agent_id} for {reason}…",
            add_to_chat_ctx=False,
        )
    except Exception:  # noqa: BLE001
        pass

    # Fetch new agent's context + voice config.
    new_bootstrap = await ctx_fetcher.fetch(
        user_jwt=user_jwt, agent_id=to_agent_id, is_reconnect=True, last_n_turns=10
    )
    new_cascade = build_cascade(new_bootstrap.voice_config)

    # Swap LLM + TTS instances. STT untouched.
    if new_cascade.llm is not None:
        try:
            session.llm = new_cascade.llm  # type: ignore[assignment]
        except Exception:
            pass
    if new_cascade.tts is not None:
        try:
            session.tts = new_cascade.tts  # type: ignore[assignment]
        except Exception:
            pass

    await oasis.emit(
        topic=TOPIC_PERSONA_SWAP,
        payload={
            "orb_session_id": orb_session_id,
            "agent_id": to_agent_id,
            "tts_provider": (new_bootstrap.voice_config or {}).get("tts_provider"),
            "tts_model": (new_bootstrap.voice_config or {}).get("tts_model"),
        },
    )
    await oasis.emit(
        topic=TOPIC_HANDOFF_COMPLETE,
        payload={
            "from_agent_id": from_agent_id,
            "to_agent_id": to_agent_id,
            "user_id": user_id,
            "orb_session_id": orb_session_id,
        },
    )

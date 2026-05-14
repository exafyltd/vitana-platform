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
import time
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
    TOPIC_AGENT_DISCONNECTED,
    TOPIC_AGENT_ROOM_JOIN_FAILED,
    TOPIC_AGENT_ROOM_JOIN_STARTED,
    TOPIC_AGENT_ROOM_JOIN_SUCCEEDED,
    TOPIC_AGENT_STARTING,
    TOPIC_HANDOFF_COMPLETE,
    TOPIC_HANDOFF_START,
    TOPIC_PERSONA_SWAP,
    TOPIC_SESSION_START,
    TOPIC_SESSION_STOP,
    TOPIC_STALL_DETECTED,
    OasisEmitter,
)
from .providers import build_cascade
from .tools import all_tools
from .watchdogs import StallWatchdog, STALL_THRESHOLD_MS

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


CODE_VERSION = "agent-2026-05-07-name-and-facts"


async def _early_trace_heartbeat(gateway_url: str, payload: dict) -> None:
    """Best-effort beacon proving the agent's deployed code includes the
    trace path. Uses bare httpx (no GatewayClient — that path failed
    silently somewhere). Posts to /api/v1/orb/agent-trace with no auth
    (the endpoint accepts anonymous traces). Wrapped so any failure
    here NEVER kills the entrypoint.
    """
    import httpx as _httpx  # local import to keep top-level minimal
    try:
        async with _httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                gateway_url.rstrip("/") + "/api/v1/orb/agent-trace",
                json=payload,
                headers={"Content-Type": "application/json"},
            )
    except Exception:  # noqa: BLE001
        pass


async def agent_entrypoint(ctx: "JobContext") -> None:
    """livekit-agents JobContext entrypoint.

    Called by `cli.run_app(WorkerOptions(entrypoint_fnc=...))` for every
    new room dispatch. Owns the full session lifecycle.
    """
    if not LK_AVAILABLE:
        logger.warning("agent_entrypoint called but livekit-agents not installed")
        return

    cfg = AgentConfig.from_env()

    # Earliest possible trace heartbeat — fires BEFORE bootstrap, BEFORE
    # any LLM/tool wiring. Proves whether this code revision is even
    # serving. We don't have user_id yet (metadata not read), so use the
    # job/room id as the unique tag and let the gateway store the row
    # under user_id="<unknown>". A second, full trace fires after we
    # have identity (below).
    asyncio.create_task(
        _early_trace_heartbeat(
            cfg.gateway_url,
            {
                "user_id": "agent-heartbeat",
                "code_version": CODE_VERSION,
                "phase": "entry",
                "ts": "early",
            },
        )
    )

    oasis = OasisEmitter(gateway_url=cfg.gateway_url, service_token=cfg.gateway_service_token)
    ctx_fetcher = ContextBootstrap(
        gateway_url=cfg.gateway_url, service_token=cfg.gateway_service_token
    )

    # L2.2b.1 (VTID-02987): emit agent-lifecycle telemetry at the earliest
    # possible points so any failure joining the LiveKit room is visible
    # in OASIS without scraping logs. The 5 events are: starting →
    # room_join_started → (room_join_succeeded | room_join_failed) →
    # disconnected (from the shutdown_callback below). Every emit is
    # fire-and-forget; OasisEmitter swallows network errors so telemetry
    # never blocks the voice path.
    _room_name = None
    try:
        _room_name = getattr(getattr(ctx, "room", None), "name", None)
    except Exception:  # noqa: BLE001
        pass
    _agent_lifecycle_base = {
        "room_name": _room_name,
        "code_version": CODE_VERSION,
        "vtid": "VTID-02987",
    }
    await oasis.emit(
        topic=TOPIC_AGENT_STARTING,
        payload=dict(_agent_lifecycle_base, phase="starting"),
        vtid="VTID-02987",
    )
    await oasis.emit(
        topic=TOPIC_AGENT_ROOM_JOIN_STARTED,
        payload=dict(_agent_lifecycle_base, phase="room_join_started"),
        vtid="VTID-02987",
    )

    # Connect to the room first — required to read remote participant
    # metadata. The orb-agent itself does not publish; the user is the
    # publisher.
    try:
        await ctx.connect()
    except Exception as _join_exc:  # noqa: BLE001
        await oasis.emit(
            topic=TOPIC_AGENT_ROOM_JOIN_FAILED,
            payload=dict(
                _agent_lifecycle_base,
                phase="room_join_failed",
                error=str(_join_exc),
                error_type=type(_join_exc).__name__,
            ),
            vtid="VTID-02987",
        )
        # Re-raise so the worker dispatcher knows the job failed; no audio
        # path is wired yet so there's nothing to clean up here.
        raise
    await oasis.emit(
        topic=TOPIC_AGENT_ROOM_JOIN_SUCCEEDED,
        payload=dict(_agent_lifecycle_base, phase="room_join_succeeded"),
        vtid="VTID-02987",
    )

    # L2.2b.2 (VTID-02990): text-only model loop. When `ORB_AGENT_TEXT_ONLY`
    # is true (default during the L2.2b.2 phase), skip the STT/LLM/TTS
    # cascade build + AgentSession start — those need Deepgram + Cartesia
    # secrets which haven't been populated yet. Instead, run a single
    # Anthropic round-trip self-test to prove the agent/model boundary
    # works from canary room context, emit the 3 model_request_* lifecycle
    # events, and idle until the room disconnects.
    #
    # When ops flips `ORB_AGENT_TEXT_ONLY=false` (after Deepgram + Cartesia
    # secrets land in L2.2b.3), this branch is skipped and the existing
    # cascade path below runs.
    from .text_only_loop import run_text_only_self_test, text_only_mode_enabled

    if text_only_mode_enabled():
        logger.info(
            "L2.2b.2: ORB_AGENT_TEXT_ONLY enabled — running Anthropic self-test, "
            "skipping cascade build"
        )

        # Register a small teardown for the text-only path that mirrors the
        # L2.2b.1 disconnected-event semantics — emit `agent.disconnected`
        # then close OasisEmitter + ctx_fetcher. The full cascade teardown
        # (GatewayClient, AgentSession finalization) is NOT needed here
        # because those resources are never created in text-only mode.
        async def _text_only_teardown() -> None:
            try:
                await oasis.emit(
                    topic=TOPIC_AGENT_DISCONNECTED,
                    payload=dict(
                        _agent_lifecycle_base,
                        phase="disconnected",
                        mode="text_only",
                    ),
                    vtid="VTID-02987",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("L2.2b.2: agent.disconnected emit failed: %s", exc)
            try:
                await oasis.aclose()
            except Exception:  # noqa: BLE001
                pass
            try:
                await ctx_fetcher.aclose()
            except Exception:  # noqa: BLE001
                pass

        try:
            ctx.add_shutdown_callback(_text_only_teardown)  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "L2.2b.2: add_shutdown_callback unavailable; disconnect event "
                "may not fire. err=%s",
                exc,
            )

        try:
            result = await run_text_only_self_test(
                oasis=oasis,
                room_name=_room_name,
                code_version=CODE_VERSION,
            )
            logger.info("L2.2b.2: self-test result=%s", result)
        except Exception as exc:  # noqa: BLE001
            # run_text_only_self_test should NEVER raise (it catches its own
            # errors and emits typed failure events). This guard is purely
            # defensive — if something does escape, log it and continue so
            # the agent doesn't fail the room dispatch.
            logger.exception("L2.2b.2: unexpected self-test exception: %s", exc)

        # Stay in the room until LiveKit disconnects us (the shutdown_callback
        # above emits `agent.disconnected` on teardown). The agent worker
        # process tears itself down when the SFU closes the room.
        return

    # ── Identity metadata lives on the USER PARTICIPANT, not the room. ──
    # The gateway's /api/v1/orb/livekit/token mints a LiveKit AccessToken
    # with `metadata: JSON.stringify({user_id, tenant_id, vitana_id,
    # user_jwt, ...})`. AccessToken metadata becomes the *participant's*
    # metadata at join time. `ctx.room.metadata` is room-level metadata
    # (a separate, server-side field set via LiveKit Server API), which
    # the gateway does NOT write — it has always been empty, which is why
    # every session was resolving to user_id="anon" before this fix.
    #
    # Strategy: try participants already in the room first (the user
    # typically joins before the agent dispatch), then fall back to
    # waiting for the next participant join.
    metadata_str = ""
    user_participant = None
    for p in ctx.room.remote_participants.values():
        if p.metadata:
            user_participant = p
            metadata_str = p.metadata
            logger.info("agent_entrypoint: read metadata from already-joined participant %s", p.identity)
            break

    if not metadata_str:
        try:
            user_participant = await asyncio.wait_for(ctx.wait_for_participant(), timeout=10.0)
            metadata_str = user_participant.metadata or ""
            logger.info("agent_entrypoint: waited for participant %s, metadata_len=%d",
                        user_participant.identity, len(metadata_str))
        except asyncio.TimeoutError:
            logger.warning("agent_entrypoint: no participant joined within 10s — anonymous fallback")
        except Exception as exc:  # noqa: BLE001
            logger.warning("agent_entrypoint: wait_for_participant failed: %s", exc)

    try:
        metadata = json.loads(metadata_str) if metadata_str else {}
    except (json.JSONDecodeError, TypeError):
        logger.warning("agent_entrypoint: participant metadata is not valid JSON: %r", metadata_str[:200])
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

    identity = resolve_identity_from_room_metadata(metadata)
    agent_id = str(metadata.get("agent_id", "vitana"))
    orb_session_id = str(metadata.get("orb_session_id", ""))
    # PR-VTID-02853: per-session voice override from the LiveKit test page
    # dropdown. None / empty string means "use the language default from
    # LANG_DEFAULTS." Operators experiment with different Chirp3-HD
    # personas (Aoede / Kore / Leda / Charon / etc.) without a code-deploy
    # cycle by picking from the dropdown — the value flows token mint →
    # AccessToken metadata → here → build_cascade(voice_override=…).
    voice_override = metadata.get("voice_override") or None
    if voice_override is not None:
        voice_override = str(voice_override).strip() or None

    # GatewayClient carries the user JWT (Bearer) PLUS X-User-ID /
    # X-Tenant-ID / X-Vitana-Active-Role headers as defense-in-depth for
    # routes whose auth middleware predates auth-supabase-jwt and reads
    # those legacy headers instead of req.identity.
    gw = GatewayClient(
        base_url=cfg.gateway_url,
        user_jwt=user_jwt,
        service_token=cfg.gateway_service_token,
        user_id=identity.user_id or None,
        tenant_id=identity.tenant_id or None,
        active_role=identity.role or None,
    )

    # Fetch the merged context (memory + role + agent voice config).
    # PR 1.B-Lang-4: pass identity.lang so the system prompt is built in
    # the user's language. Without this the gateway falls back to 'en'
    # and the LLM keeps responding in English even for German users.
    bootstrap = await ctx_fetcher.fetch(
        user_jwt=user_jwt or "",
        agent_id=agent_id,
        is_reconnect=False,
        last_n_turns=0,
        lang=identity.lang,
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
            first_name=bootstrap.first_name,
            display_name=bootstrap.display_name,
        )

    # Cascade. If any of stt/llm/tts is None it means the corresponding
    # plugin failed to instantiate (wrong provider name, ImportError,
    # config kwarg not accepted, ADC missing scopes, etc.). Trace the
    # cascade.notes so we never have to guess again.
    # PR 1.B-Lang: thread identity.lang into the cascade so STT receives
    # the matching BCP-47 code and TTS picks a per-language voice via
    # voices_per_lang / LANG_DEFAULTS. Without this, German users get
    # English STT models + an English Chirp speaking German text.
    cascade = build_cascade(bootstrap.voice_config, lang=identity.lang, voice_override=voice_override)
    cascade_summary = {
        "stt_present": cascade.stt is not None,
        "llm_present": cascade.llm is not None,
        "tts_present": cascade.tts is not None,
        "notes": list(cascade.notes),
    }
    asyncio.create_task(
        _early_trace_heartbeat(
            cfg.gateway_url,
            {
                "user_id": identity.user_id or "unknown",
                "code_version": CODE_VERSION,
                "phase": "cascade_built",
                "orb_session_id": orb_session_id,
                "cascade_summary": cascade_summary,
            },
        )
    )

    # OASIS session start.
    # VTID-02986: payload shape mirrors Vertex's orb-live.ts:11838 emit so
    # Voice Lab's /api/v1/voice-lab/live/sessions can build a unified
    # LiveSessionSummary from a single query. Key fields the route reads:
    # session_id, transport, lang, user_id, tenant_id, email, user_agent,
    # origin, is_mobile, voice. `transport: 'livekit'` is the new value the
    # UI badges to distinguish LiveKit vs Vertex (websocket/sse) sessions.
    session_started_at_ms = int(time.time() * 1000)
    voice_cfg = bootstrap.voice_config or {}
    await oasis.emit(
        topic=TOPIC_SESSION_START,
        payload={
            "session_id": orb_session_id,
            "transport": "livekit",
            "user_id": identity.user_id,
            "tenant_id": identity.tenant_id,
            "agent_id": agent_id,
            "lang": identity.lang,
            "is_mobile": identity.is_mobile,
            "is_anonymous": identity.is_anonymous,
            "vitana_id": bootstrap.vitana_id or identity.vitana_id,
            "email": getattr(identity, "email", None),
            "orb_session_id": orb_session_id,
            "stt_provider": voice_cfg.get("stt_provider"),
            "stt_model": voice_cfg.get("stt_model"),
            "llm_provider": voice_cfg.get("llm_provider"),
            "llm_model": voice_cfg.get("llm_model"),
            "tts_provider": voice_cfg.get("tts_provider"),
            "tts_model": voice_cfg.get("tts_model"),
            "voice": voice_cfg.get("tts_model"),  # Vertex parity: `voice` = TTS model name
            "active_role": bootstrap.active_role,
        },
    )

    # Tool catalogue from tools.py — every @function_tool-decorated async
    # function in the module, exported via all_tools(). Each tool body is a
    # thin async call to a gateway endpoint via the GatewayClient carried on
    # RunContext.userdata (set on AgentSession below).
    tool_list = list(all_tools())
    # PR-VTID-02856: Native Gemini Google Search grounding. Mirrors Vertex's
    # orb-live.ts:3732 `{ google_search: {} }` declaration. Without this the
    # LiveKit LLM has no way to fetch fresh facts (sports scores, news, etc.)
    # — the search_web custom function is a stub when PERPLEXITY_API_KEY
    # isn't set (it isn't, and per orb-live.ts the comment explicitly says
    # native google_search REPLACED the broken Perplexity path). Add the
    # GoogleSearch ProviderTool to the agent's tool list when the LLM
    # provider is google_llm; the model handles tool calls automatically
    # and returns answers with citations.
    if (bootstrap.voice_config or {}).get("llm_provider") == "google_llm":
        try:
            from livekit.plugins.google.tools import GoogleSearch  # type: ignore[import-not-found]
            tool_list.append(GoogleSearch())
            logger.info("GoogleSearch grounding enabled (Gemini native tool)")
        except ImportError as exc:
            logger.warning("GoogleSearch grounding unavailable: %s", exc)
    agent = Agent(
        instructions=sys_prompt,
        tools=tool_list,
    )

    # VTID-LIVEKIT-AGENT-TRACE: post a structured trace to the gateway so
    # the diagnostics panel can show what the agent ACTUALLY had at session
    # start — proves whether the prompt rewrite is reaching the LLM and
    # the bootstrap context is enriched.
    try:
        tool_names: list[str] = []
        for t in tool_list:
            try:
                tool_names.append(getattr(getattr(t, "info", None), "name", None) or repr(t))
            except Exception:
                tool_names.append("<?>")
        trace_payload = {
            "user_id": identity.user_id,
            "tenant_id": identity.tenant_id,
            "vitana_id": bootstrap.vitana_id or identity.vitana_id,
            "role": identity.role,
            "lang": identity.lang,
            "orb_session_id": orb_session_id,
            "agent_id": agent_id,
            "is_mobile": identity.is_mobile,
            "is_anonymous": identity.is_anonymous,
            "user_jwt_present": bool(user_jwt),
            "user_jwt_len": len(user_jwt) if user_jwt else 0,
            "bootstrap_context_length": len(bootstrap.bootstrap_context or ""),
            "bootstrap_first_1500_chars": (bootstrap.bootstrap_context or "")[:1500],
            "bootstrap_active_role": bootstrap.active_role,
            "bootstrap_vitana_id": bootstrap.vitana_id,
            "bootstrap_display_name": bootstrap.display_name,
            "bootstrap_first_name": bootstrap.first_name,
            "bootstrap_identity_facts_count": len(bootstrap.identity_facts or []),
            "bootstrap_identity_fact_keys": [
                f.get("fact_key") for f in (bootstrap.identity_facts or [])
            ],
            "bootstrap_voice_config_llm": (bootstrap.voice_config or {}).get("llm_model"),
            "bootstrap_voice_config_stt": (bootstrap.voice_config or {}).get("stt_model"),
            "bootstrap_voice_config_tts": (bootstrap.voice_config or {}).get("tts_model"),
            "system_prompt_length": len(sys_prompt),
            "system_prompt_first_600_chars": sys_prompt[:600],
            "tools_count": len(tool_list),
            "tools_first_5": tool_names[:5],
            "tools_handle_in_first_chars": "@" + (bootstrap.vitana_id or identity.vitana_id or "") in sys_prompt[:600],
            "tools_first_name_in_first_chars": bool(
                bootstrap.first_name and bootstrap.first_name.lower() in sys_prompt[:600].lower()
            ),
        }
        await gw.post("/api/v1/orb/agent-trace", trace_payload)
    except Exception as exc:  # noqa: BLE001
        logger.warning("agent-trace post failed: %s", exc)

    # AgentSession glues together STT + LLM + TTS + the room. userdata
    # carries the per-session GatewayClient so each tool body can pull it off
    # RunContext.userdata. max_tool_steps is the tool-loop guard threshold.
    # PR 1.B-0: stash the live Room handle on the GatewayClient so tool
    # wrappers that receive a `directive` payload can publish on the data
    # channel via publish_orb_directive(gw.room, directive). The frontend's
    # data-channel listener applies the directive (open_url, navigate, etc.)
    # the same way the SSE/WS branch does on Vertex.
    gw.room = ctx.room

    # PR 1.B-3 (VTID-NAV-TIMEJOURNEY): seed the agent's view of the user's
    # current screen + recent-routes trail from the bootstrap response. The
    # get_current_screen tool wrapper reads these and the gateway's shared
    # tool_get_current_screen resolves them through the navigation catalog
    # for a friendly answer to "where am I?". Future PRs in this phase
    # (1.B-4 free-text navigate, 1.B-5 navigator gates) eagerly update them
    # post-navigate so subsequent get_current_screen calls see fresh values.
    gw.current_route = bootstrap.current_route
    gw.recent_routes = list(bootstrap.recent_routes or [])
    # PR 1.B-5 — identity facts the navigator gates need at dispatch.
    gw.is_mobile = bool(identity.is_mobile)
    gw.is_anonymous = bool(identity.is_anonymous)

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

    # VTID-02986: per-session counters feed the gateway's session-stop
    # metrics so classifyQualityFromSessionStop (voice-failure-taxonomy.ts)
    # can return a failure_class for LiveKit sessions identical to Vertex.
    # Counters are read at _teardown time below. Defined here (not inside
    # the hook closures) so both the user_input_transcribed handler AND
    # the speech_created handler can mutate them. `stall_count` is hoisted
    # too so _teardown can include it in the stop payload — the watchdog
    # binds the same dict instance later via stall_count["n"] += 1.
    user_turns_counter = {"n": 0}
    model_turns_counter = {"n": 0}
    stall_count = {"n": 0}

    async def _teardown() -> None:
        # L2.2b.1: emit the lifecycle `disconnected` event FIRST (it pairs
        # with the room_join_succeeded event from session start). The
        # vtid.live.session.stop event follows with the full quality-metrics
        # payload that the Voice Lab classifier needs.
        try:
            await oasis.emit(
                topic=TOPIC_AGENT_DISCONNECTED,
                payload=dict(
                    _agent_lifecycle_base,
                    phase="disconnected",
                    user_id=identity.user_id,
                    agent_id=agent_id,
                    orb_session_id=orb_session_id,
                ),
                vtid="VTID-02987",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("agent.disconnected oasis emit failed: %s", exc)
        # VTID-02986: full session-stop payload — same shape Vertex emits
        # at orb-live.ts:12207 so the Voice Lab quality classifier picks
        # the right failure_class. audio_in_chunks / audio_out_chunks are
        # approximations from turn counts (livekit-agents doesn't expose
        # raw frame counts on AgentSession). The classifier thresholds
        # (ai>=20 for no_engagement, ai>=100 for model_under_responds,
        # ai>=50 for low_turn_progression) still trigger correctly with
        # turn-derived approximations.
        duration_ms = max(0, int(time.time() * 1000) - session_started_at_ms)
        user_turns = user_turns_counter["n"]
        model_turns = model_turns_counter["n"]
        turn_count = user_turns + model_turns
        # ~50 chunks per turn = ~1s of 20ms-frame audio. Conservative; real
        # utterances are longer but the classifier only checks lower bounds.
        approx_in_chunks = user_turns * 50
        approx_out_chunks = model_turns * 50
        try:
            await oasis.emit(
                topic=TOPIC_SESSION_STOP,
                payload={
                    "session_id": orb_session_id,
                    "transport": "livekit",
                    "user_id": identity.user_id,
                    "tenant_id": identity.tenant_id,
                    "agent_id": agent_id,
                    "orb_session_id": orb_session_id,
                    "duration_ms": duration_ms,
                    "turn_count": turn_count,
                    "user_turns": user_turns,
                    "model_turns": model_turns,
                    "audio_in_chunks": approx_in_chunks,
                    "audio_out_chunks": approx_out_chunks,
                    "video_frames": 0,
                    "stall_count": stall_count["n"],
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

    # Phase trace: about to call session.start. If we never see a
    # post_start trace for the same orb_session_id, session.start crashed.
    asyncio.create_task(
        _early_trace_heartbeat(
            cfg.gateway_url,
            {
                "user_id": identity.user_id or "unknown",
                "code_version": CODE_VERSION,
                "phase": "pre_start",
                "orb_session_id": orb_session_id,
                "agent_id": agent_id,
                "vitana_id": bootstrap.vitana_id or identity.vitana_id,
            },
        )
    )
    try:
        await session.start(agent=agent, room=ctx.room)
    except Exception as exc:  # noqa: BLE001
        logger.exception("AgentSession.start crashed: %s", exc)
        try:
            await _early_trace_heartbeat(
                cfg.gateway_url,
                {
                    "user_id": identity.user_id or "unknown",
                    "code_version": CODE_VERSION,
                    "phase": "start_crashed",
                    "orb_session_id": orb_session_id,
                    "agent_id": agent_id,
                    "error": str(exc)[:500],
                },
            )
        except Exception:  # noqa: BLE001
            pass
        return

    # session.start returned cleanly — emit a phase trace so we can
    # distinguish "no audio because start() crashed" from "no audio
    # because greeting/TTS crashed".
    asyncio.create_task(
        _early_trace_heartbeat(
            cfg.gateway_url,
            {
                "user_id": identity.user_id or "unknown",
                "code_version": CODE_VERSION,
                "phase": "post_start",
                "orb_session_id": orb_session_id,
                "agent_id": agent_id,
                "vitana_id": bootstrap.vitana_id or identity.vitana_id,
            },
        )
    )

    # ── speech_created phase trace (kept post-fix for ongoing visibility) ──
    # Surfaces every TTS turn in the firehose so future cascade regressions
    # are visible in seconds, not weeks.
    #
    # PR-VTID-02854: also feeds the StallWatchdog. The watchdog fires when
    # NEITHER agent speech NOR user state transitions land within
    # STALL_THRESHOLD_MS (30s). On stall: emit livekit.stall_detected +
    # force the room to disconnect, which provokes the LiveKit SDK's
    # transparent transport reconnect (chat_ctx is preserved across it,
    # so the conversation resumes where it left off — same behaviour the
    # user observed today, just triggered in 30s instead of 60-120s).
    # PR-VTID-02856: telemetry-only watchdog. The previous version called
    # ctx.room.disconnect() to provoke the SDK's auto-reconnect — but that
    # surfaces as a visible "disconnect" to the user, which the user
    # explicitly said is wrong: the connection must stay active until
    # they manually disconnect. Instead, we just record the stall in
    # OASIS so operators can see the rate, and let livekit-agents'
    # underlying transport reconnect (which IS organic and silent — same
    # 1-2 min recovery the user observed before my watchdog) handle it.
    # Future option: add a soft pipeline-reset path that resets STT/LLM
    # without dropping the room. For now: telemetry-only.
    # stall_count was hoisted above _teardown so the stop-payload sees it.
    stall = StallWatchdog(threshold_ms=STALL_THRESHOLD_MS)

    async def _on_stall() -> None:
        stall_count["n"] += 1
        logger.warning(
            "StallWatchdog: no activity in %ds (count=%d) for orb_session_id=%s — telemetry only, no disconnect",
            int(STALL_THRESHOLD_MS / 1000),
            stall_count["n"],
            orb_session_id,
        )
        try:
            await oasis.emit(
                topic=TOPIC_STALL_DETECTED,
                payload={
                    "orb_session_id": orb_session_id,
                    "user_id": identity.user_id,
                    "agent_id": agent_id,
                    "stall_count": stall_count["n"],
                    "threshold_ms": STALL_THRESHOLD_MS,
                    "action": "telemetry_only",
                },
            )
        except Exception:  # noqa: BLE001
            pass

    stall.start(on_stall=_on_stall)

    try:
        @session.on("speech_created")  # type: ignore[misc]
        def _on_speech(ev: Any) -> None:  # noqa: ARG001
            # VTID-02986: increment model_turns counter for the session.stop
            # quality classifier in addition to feeding the watchdog +
            # firehose trace.
            model_turns_counter["n"] += 1
            stall.feed()
            asyncio.create_task(
                _early_trace_heartbeat(
                    cfg.gateway_url,
                    {
                        "user_id": identity.user_id or "unknown",
                        "code_version": CODE_VERSION,
                        "phase": "speech_created",
                        "orb_session_id": orb_session_id,
                    },
                )
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not hook speech_created: %s", exc)

    # PR-VTID-02854: also feed on agent + user state transitions so a long
    # user utterance (no agent speech for >30s) doesn't false-fire the
    # watchdog, and a long silent agent (waiting for user input) doesn't
    # either. We don't know which exact event names AgentSession emits in
    # this version of livekit-agents, so subscribe defensively.
    #
    # VTID-02986: user_input_transcribed also increments user_turns counter
    # so the quality classifier sees both sides of the conversation. Other
    # hooks stay watchdog-only.
    def _on_user_transcribed(_ev: Any = None) -> None:
        user_turns_counter["n"] += 1
        stall.feed()

    try:
        session.on("user_input_transcribed")(_on_user_transcribed)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook user_input_transcribed: %s", exc)

    for ev_name in ("user_state_changed", "agent_state_changed"):
        try:
            session.on(ev_name)(lambda _ev=None: stall.feed())  # type: ignore[misc]
        except Exception as exc:  # noqa: BLE001
            logger.debug("could not hook %s: %s", ev_name, exc)

    # Stop the watchdog when the room disconnects so we don't leak the task.
    async def _stop_stall_on_shutdown() -> None:
        try:
            await stall.stop()
        except Exception:  # noqa: BLE001
            pass

    ctx.add_shutdown_callback(_stop_stall_on_shutdown)

    # Initial greeting — uses the LLM (via generate_reply) so the agent reads
    # the user's name and verified facts from the system-prompt's WHO YOU ARE
    # TALKING TO block. The TTS bug that caused 25s of dead air on every
    # session is fixed in providers.py (language_code → language).
    if not identity.is_anonymous:
        vid = (bootstrap.vitana_id or "").strip()
        first_name = (bootstrap.first_name or "").strip()
        if first_name:
            greeting_instructions = (
                f"Greet the user warmly RIGHT NOW by their first name: '{first_name}'. "
                f"Examples: 'Hi {first_name}!' or 'Hey {first_name}, good to hear from you.' "
                f"Their Vitana handle ({'@' + vid if vid else '<no handle>'}) is "
                f"available as a fallback but DO NOT lead with it — '{first_name}' is "
                f"the natural way a real person would address them. ONE short sentence "
                f"+ brief 'What can I help with today?'. NEVER say you don't know them — "
                f"you do. NEVER apologize for anything in the greeting."
            )
        else:
            greeting_instructions = (
                f"Greet the user warmly RIGHT NOW using their @vitana_id handle "
                f"(it is @{vid or 'their handle'}). Example: 'Hi @{vid or 'there'}!'. "
                f"ONE short sentence + brief 'What can I help with today?'. NEVER say "
                f"you don't know them — you do. NEVER apologize for anything in the greeting."
            )
        try:
            await session.generate_reply(instructions=greeting_instructions)
        except Exception as exc:  # noqa: BLE001
            logger.warning("initial greeting generate_reply failed: %s", exc)
            asyncio.create_task(
                _early_trace_heartbeat(
                    cfg.gateway_url,
                    {
                        "user_id": identity.user_id or "unknown",
                        "code_version": CODE_VERSION,
                        "phase": "greeting_failed",
                        "orb_session_id": orb_session_id,
                        "error": str(exc)[:500],
                    },
                )
            )
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
    lang: str = "en",
) -> None:
    """Swap to a new specialist mid-session. STT/mic continue; LLM+TTS swap.

    PR 1.B-Lang: `lang` propagates the user's identity.lang into the new
    cascade so the specialist's TTS picks a voice in the user's language.
    Defaults to English so callers that haven't been updated keep working.
    """
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
        user_jwt=user_jwt, agent_id=to_agent_id, is_reconnect=True, last_n_turns=10, lang=lang,
    )
    new_cascade = build_cascade(new_bootstrap.voice_config, lang=lang)

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

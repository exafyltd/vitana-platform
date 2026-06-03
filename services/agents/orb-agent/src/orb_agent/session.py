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
    TOPIC_AGENT_TURN_MEASURED,
    TOPIC_HANDOFF_COMPLETE,
    TOPIC_HANDOFF_START,
    TOPIC_PERSONA_SWAP,
    TOPIC_SESSION_START,
    TOPIC_SESSION_STOP,
    TOPIC_STALL_DETECTED,
    TOPIC_STT_AVAILABILITY_CHANGED,
    TOPIC_STT_ERROR,
    TOPIC_STT_METRICS,
    TOPIC_STT_RECOVERY,
    TOPIC_STT_SILENT_STALL,
    TOPIC_TURN_RESPONDED,
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

# VTID-03003: Silero VAD for cascade-pipeline turn detection. Without an
# explicit VAD, AgentSession's STT-cascade has unreliable turn boundaries
# — the first user turn happens to align, but subsequent turns drift and
# the user_input_transcribed event never fires after the agent's reply.
# `livekit-plugins-silero` is already in requirements.txt. Lazy-imported
# so tests that don't have the binary plugin still pass.
try:
    from livekit.plugins import silero  # type: ignore[import-not-found]
    SILERO_AVAILABLE = True
except ImportError:
    silero = None  # type: ignore[assignment]
    SILERO_AVAILABLE = False

# VTID-03012: module-level Silero VAD instance. Loading PyTorch models is
# slow (1.5–3s observed in tests) and was happening on every new room
# dispatch — directly inflating the click-to-greeting latency. The model
# is stateless across sessions (Silero VAD just classifies short audio
# frames); sharing one instance is safe and the canonical livekit-agents
# pattern. `_get_vad()` lazy-loads on first call, then returns the cached
# instance to every subsequent agent_entrypoint.
_SHARED_VAD: Any = None

# VTID-03086: Silero VAD tuning. The 2026-05-18 20:56-21:03 UTC session
# diagnosed the root cause behind the silent-stall thrash — STT recognition
# cycles were consuming 79-86 SECONDS of audio per cycle because Silero's
# defaults treat natural German speech (with comma-pauses + breathing)
# as one continuous "speech" state. Both Google STT and Deepgram are
# working correctly; they're just being handed one-minute audio streams
# and finalizing one giant transcript at the end.
#
# Three tuned parameters:
#   * min_silence_duration 0.55 → 0.25
#     Catches the natural comma-pauses in conversational German that
#     don't cross the half-second silence threshold of the default.
#   * activation_threshold 0.5 → 0.6
#     Slightly less sensitive to breathing / ambient noise being
#     classified as ongoing speech (especially during a long pause).
#   * max_buffered_speech 60.0 → 8.0
#     Hard ceiling. Regardless of silence-detection, Silero will declare
#     end-of-speech after 8 seconds of continuous "speech" state. This
#     is the safety net: STT cycles can NEVER again hit the 79-86s
#     batches we saw. Worst case for a single user utterance: it splits
#     into 8-second chunks, each transcribed in order, LLM responds per
#     chunk. Better than 80 seconds of dead air.
_VAD_MIN_SILENCE_DURATION_S = 0.25
_VAD_ACTIVATION_THRESHOLD = 0.6
_VAD_MAX_BUFFERED_SPEECH_S = 8.0


def _get_vad() -> Any:
    global _SHARED_VAD
    if _SHARED_VAD is not None:
        return _SHARED_VAD
    if not SILERO_AVAILABLE:
        return None
    try:
        _SHARED_VAD = silero.VAD.load(  # type: ignore[union-attr]
            min_silence_duration=_VAD_MIN_SILENCE_DURATION_S,
            activation_threshold=_VAD_ACTIVATION_THRESHOLD,
            max_buffered_speech=_VAD_MAX_BUFFERED_SPEECH_S,
        )
        logger.info(
            "VTID-03086: module-level Silero VAD loaded "
            "(min_silence=%.2fs, activation=%.2f, max_buffered_speech=%.1fs)",
            _VAD_MIN_SILENCE_DURATION_S,
            _VAD_ACTIVATION_THRESHOLD,
            _VAD_MAX_BUFFERED_SPEECH_S,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("VTID-03086: silero.VAD.load() failed: %s", exc)
    return _SHARED_VAD


CODE_VERSION = "agent-2026-05-17-vtid-03046-turn-telemetry"


# VTID-03014: localized first-greeting templates. session.say() speaks the
# literal string we pass — there is NO LLM translation between us and TTS,
# so the greeting MUST be in the user's language at the source. The system
# instruction's "LANGUAGE: Respond ONLY in <lang>" only governs LLM-generated
# turns; it can't translate a hardcoded English string after we've already
# handed it to TTS.
#
# Language coverage matches voice-pipeline-spec/spec.json.supported_languages
# ("en", "de", "fr", "es", "ar", "zh", "ru", "sr"). Unknown lang falls back
# to English so the agent never goes silent.
def _localized_greeting(
    lang: str,
    *,
    first_name: str = "",
    vitana_handle: str = "",
) -> str:
    """Return the agent's first-turn greeting in the user's language.

    Preference order: first_name (drops the @handle so Gemini sees one
    addressing signal, not two) → @handle → generic.
    """
    name = first_name.strip()
    handle = vitana_handle.strip()
    code = (lang or "en").lower()[:2]
    if name:
        templates = {
            "en": f"Hi {name}! What can I help with today?",
            "de": f"Hallo {name}! Womit kann ich dir heute helfen?",
            "fr": f"Salut {name} ! Comment puis-je t'aider aujourd'hui ?",
            "es": f"¡Hola {name}! ¿En qué puedo ayudarte hoy?",
            "ar": f"مرحباً يا {name}! كيف يمكنني مساعدتك اليوم؟",
            "zh": f"你好 {name}！今天我能为你做些什么？",
            "ru": f"Привет, {name}! Чем могу помочь сегодня?",
            "sr": f"Zdravo {name}! Kako mogu da ti pomognem danas?",
        }
        return templates.get(code, templates["en"])
    if handle:
        templates = {
            "en": f"Hi @{handle}! What can I help with today?",
            "de": f"Hallo @{handle}! Womit kann ich dir heute helfen?",
            "fr": f"Salut @{handle} ! Comment puis-je t'aider aujourd'hui ?",
            "es": f"¡Hola @{handle}! ¿En qué puedo ayudarte hoy?",
            "ar": f"مرحباً @{handle}! كيف يمكنني مساعدتك اليوم؟",
            "zh": f"你好 @{handle}！今天我能为你做些什么？",
            "ru": f"Привет, @{handle}! Чем могу помочь сегодня?",
            "sr": f"Zdravo @{handle}! Kako mogu da ti pomognem danas?",
        }
        return templates.get(code, templates["en"])
    templates = {
        "en": "Hi there! What can I help with today?",
        "de": "Hallo! Womit kann ich dir heute helfen?",
        "fr": "Bonjour ! Comment puis-je vous aider aujourd'hui ?",
        "es": "¡Hola! ¿En qué puedo ayudarte hoy?",
        "ar": "مرحباً! كيف يمكنني مساعدتك اليوم؟",
        "zh": "你好！今天我能为你做些什么？",
        "ru": "Здравствуйте! Чем могу помочь сегодня?",
        "sr": "Zdravo! Kako mogu da ti pomognem danas?",
    }
    return templates.get(code, templates["en"])


def _localized_anonymous_greeting(lang: str) -> str:
    code = (lang or "en").lower()[:2]
    templates = {
        "en": "Hi! How can I help today?",
        "de": "Hallo! Wie kann ich heute helfen?",
        "fr": "Bonjour ! Comment puis-je aider aujourd'hui ?",
        "es": "¡Hola! ¿En qué puedo ayudar hoy?",
        "ar": "مرحباً! كيف يمكنني المساعدة اليوم؟",
        "zh": "你好！今天我能帮上什么忙？",
        "ru": "Здравствуйте! Чем могу помочь?",
        "sr": "Zdravo! Kako mogu danas da pomognem?",
    }
    return templates.get(code, templates["en"])


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

    # VTID-03021: BLOCK on the full bootstrap before AgentSession is built.
    #
    # Reverts VTID-03017's "fast-path placeholder + bg hydration" split.
    # The runtime instruction-swap from the bg task did NOT actually take
    # on the deployed livekit-agents version — every session emitted
    # `applied_instructions: false`, so the LIVE LLM kept using the 324-
    # char placeholder prompt (no ENVIRONMENT CONTEXT, no intent
    # classifier, no identity lock, no tool rules, no decision contract).
    # User-facing impact: "where am I?" answered "United States" no
    # matter what client_ip we forwarded — because the location was
    # in the unapplied 65KB prompt, not the live one.
    #
    # Trade-off: greeting latency is back up by ~500-1000ms. Correctness
    # beats latency until VTID-03018 (proper runtime instruction-update
    # SDK research) lands. The localized greeting (VTID-03014) and
    # client_ip forwarding (VTID-03014) stay in place; they were never
    # the issue.
    bootstrap_started_at = time.monotonic()
    try:
        bootstrap = await ctx_fetcher.fetch(
            user_jwt=user_jwt or "",
            agent_id=agent_id,
            is_reconnect=False,
            last_n_turns=0,
            lang=identity.lang,
            client_ip=identity.client_ip,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("VTID-03021: full bootstrap fetch failed, using degraded fallback: %s", exc)
        # Degraded path: keep cascade/agent setup alive with voice_config=None
        # (triggers hardcoded Google fallback in providers.build_cascade)
        # so the user still gets a greeting and basic conversation, just
        # without the full Vertex-rendered system instruction. This is
        # rare and observable via is_degraded=True in the trace.
        from .bootstrap import BootstrapResult
        bootstrap = BootstrapResult(
            bootstrap_context="",
            active_role=None,
            conversation_summary=None,
            last_turns=None,
            last_session_info=None,
            current_route=None,
            recent_routes=[],
            client_context={},
            vitana_id=identity.vitana_id,
            voice_config=None,
            is_degraded=True,
        )
    bootstrap_latency_ms = int((time.monotonic() - bootstrap_started_at) * 1000)

    # System instruction.
    #
    # L2.2b.6 (VTID-03010): the gateway now renders the full Vertex
    # buildLiveSystemInstruction output and returns it under
    # `bootstrap.system_instruction`. Use it verbatim when present —
    # this is the only way the LiveKit and Vertex pipelines share a
    # single source of truth for the ~17-section prompt (greeting policy,
    # identity lock, intent classifier, route integrity, retired-pillar
    # handling, diary-logging rules, AVAILABLE TOOLS catalog, etc.).
    # When the field is None (pre-L2.2b.6 gateway, or render exception),
    # fall back to the legacy Python builder.
    if identity.is_anonymous:
        sys_prompt = build_anonymous_system_instruction(
            lang=identity.lang,
            voice_style="warm",
            ctx=bootstrap.client_context,
        )
    elif bootstrap.system_instruction:
        sys_prompt = bootstrap.system_instruction
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
            # VTID-03015: diagnostic — directly expose the values needed to
            # debug "ENVIRONMENT CONTEXT still says United States" after
            # VTID-03014 wired client_ip end-to-end. Three questions to
            # answer from one trace:
            #   1. Did the gateway embed client_ip in LiveKit metadata?
            #      → identity_client_ip non-null = yes; null = gateway gap.
            #   2. Did the agent forward X-Real-IP to bootstrap?
            #      → bootstrap.fetch is called with identity.client_ip already
            #        (verified in code); this just records what got sent.
            #   3. Did the gateway's bootstrap geo-resolve correctly?
            #      → bootstrap_client_context_{city,country,timezone}.
            "identity_client_ip": identity.client_ip,
            # VTID-03021: telemetry for the blocking-bootstrap revert.
            # bootstrap_latency_ms measures the cost of correctness so we
            # can compare against VTID-03017's claimed 150-300ms fast path
            # in real production data, not synthetic estimates.
            # applied_instructions is now ALWAYS true (assuming sys_prompt
            # is non-empty), because Agent(instructions=sys_prompt) binds
            # at construction — there is no runtime swap that can silently
            # fail. The field stays so dashboards built against VTID-03017
            # data keep working.
            "bootstrap_latency_ms": bootstrap_latency_ms,
            "applied_instructions": bool(sys_prompt) and not bootstrap.is_degraded,
            "bootstrap_is_degraded": bootstrap.is_degraded,
            "bootstrap_client_context_city": (bootstrap.client_context or {}).get("city"),
            "bootstrap_client_context_country": (bootstrap.client_context or {}).get("country"),
            "bootstrap_client_context_timezone": (bootstrap.client_context or {}).get("timezone"),
            # Full ENVIRONMENT CONTEXT block from the rendered system_instruction.
            # This is the literal text the LLM sees. If it says "United States"
            # the geo resolved to us-central1; if it says the user's real city
            # the X-Real-IP forwarding worked.
            "system_prompt_env_context_excerpt": (
                (sys_prompt[sys_prompt.find("ENVIRONMENT CONTEXT"):sys_prompt.find("ENVIRONMENT CONTEXT") + 500]
                 if "ENVIRONMENT CONTEXT" in sys_prompt else "")
            ),
            # Full bootstrap_context so we can see the full ENV block even
            # when it's past the first 1500 chars (which truncates).
            "bootstrap_context_full": bootstrap.bootstrap_context or "",
        }
        # VTID-03012: fire-and-forget — this trace is observability-only,
        # nothing downstream blocks on it. Awaiting it was adding 200-500ms
        # of gateway round-trip to every session before the greeting could
        # fire.
        asyncio.create_task(gw.post("/api/v1/orb/agent-trace", trace_payload))
    except Exception as exc:  # noqa: BLE001
        logger.warning("agent-trace payload build failed: %s", exc)

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

    # VTID-03027: stash everything the report_to_specialist tool body
    # needs to SIGNAL a persona rebuild (handoff_event). The main loop
    # below watches the event; on set, it gracefully stops the current
    # session, fetches the persona's bootstrap, and starts a fresh
    # AgentSession in the same room. Vertex-parity flow.
    gw.oasis_emitter = oasis
    gw.ctx_fetcher = ctx_fetcher
    gw.user_jwt = user_jwt or ""
    gw.user_id = identity.user_id or ""
    gw.orb_session_id = orb_session_id
    gw.identity_lang = identity.lang
    gw.identity_client_ip = identity.client_ip
    gw.current_agent_id = agent_id
    gw.handoff_event = asyncio.Event()
    gw.handoff_target = None
    gw.handoff_summary = None
    gw.handoff_reason = None

    # VTID-03003: wire Silero VAD so the cascade-pipeline can detect turn
    # boundaries reliably. VTID-03012: VAD is now module-level cached
    # (loaded once, reused across sessions) so first-time PyTorch model
    # init no longer adds 1.5–3s to every new agent_entrypoint call.
    vad_instance = _get_vad()
    if vad_instance is None and not SILERO_AVAILABLE:
        logger.warning("livekit-plugins-silero not installed, no VAD")

    # VTID-03075: the `turn_handling.user_turn_limit.max_duration=20.0` cap
    # shipped in VTID-03074 was a no-op for the 170-second STT-buffer bug.
    # Per livekit-agents source (audio_recognition.py _check_user_turn_limit,
    # called only on FINAL transcripts), the cap only triggers AFTER a
    # transcript event arrives — which means it cannot fire DURING the
    # silent-buffer window. Removed; real detection lives in the
    # silent-stall watchdog wired further down in this file.
    session_kwargs: dict[str, Any] = {
        "stt": cascade.stt,
        "llm": cascade.llm,
        "tts": cascade.tts,
        "userdata": gw,
        "max_tool_steps": MAX_TOOL_STEPS,
    }
    if vad_instance is not None:
        session_kwargs["vad"] = vad_instance
    session = AgentSession(**session_kwargs)
    # VTID-03027: live session reference for the handoff main loop below.
    # The loop replaces this when a persona rebuild fires.
    gw.live_session = session

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

    # VTID-03076 (P0-C): activeContinuation voice state.
    #
    # When the agent speaks a wake-brief (proactive opener at orb_wake),
    # the LLM has historically not remembered it because session.say()
    # ran with add_to_chat_ctx=False — the line was TTS-output only,
    # never appended to chat_ctx. The user replying "ja" then triggered
    # the LLM with NO record of an offer; the model fell back on
    # system_instruction content (Vitanaland, Vitana Index, ...) and
    # produced unrelated answers. The user then asked "was hast du
    # gerade gesagt?" and the agent denied saying it.
    #
    # This dict carries the spoken offer's identity AND a TTL so:
    #   1. on user "ja" / "yes" / "okay" / "mach das", we POST
    #      /api/v1/voice/next-action/event (accepted) for OASIS.
    #   2. on user "nein" / "no" / "not now", we POST (dismissed).
    #   3. on TTL expiry / session end / topic-shift, we clear state.
    # The wake-brief say() now adds to chat_ctx so the LLM can answer
    # "was hast du gerade gesagt?" naturally — no special intercept
    # needed for the repeat case.
    #
    # Shape mirrors the wake_brief_decision payload + a wall-clock
    # deadline. None = no active offer.
    active_continuation: dict[str, Any] = {}
    # 3 minutes: long enough that "ja" after a 30s pause still works,
    # short enough that a stale offer doesn't claim "yes" said much
    # later about an unrelated topic.
    _CONTINUATION_TTL_SECONDS = 180.0

    def _continuation_is_active() -> bool:
        if not active_continuation:
            return False
        deadline = active_continuation.get("expires_at_monotonic")
        if not isinstance(deadline, (int, float)):
            return False
        return time.monotonic() < deadline

    def _clear_continuation(reason: str) -> None:
        if active_continuation:
            logger.info(
                "VTID-03076: clearing activeContinuation (reason=%s, decision_id=%s)",
                reason,
                active_continuation.get("decision_id"),
            )
            active_continuation.clear()

    # VTID-03076: short-reply patterns live in continuation_intent.py
    # so they can be unit-tested without spinning up an AgentSession.
    # `classify_short_reply` returns 'accept' / 'dismiss' / None.
    # `is_topic_shift` returns True when the reply is long enough to
    # clear active_continuation as a precaution.
    # VTID-03077: was `from orb_agent.continuation_intent import ...` —
    # absolute. The orb-agent worker process loads this module as
    # `src.orb_agent.session` (Dockerfile + worker_entry.py spawn
    # `python -m src.orb_agent.worker_entry`), so the absolute name
    # `orb_agent.continuation_intent` is not importable at runtime.
    # Every agent_entrypoint dispatched since VTID-03076 raised
    # ImportError right after the bootstrap trace fired and exited
    # silently — users on the canary saw cascade_built emit, then 5+
    # minutes of dead air. Use the relative form like every other
    # sibling import at the top of this file.
    from .continuation_intent import (
        classify_short_reply as _short_reply_intent,
        is_topic_shift as _is_topic_shift,
    )

    async def _post_continuation_event(event_name: str) -> None:
        """Fire-and-forget POST to /api/v1/voice/next-action/event.

        event_name: 'accepted' | 'dismissed'. Reads from active_continuation
        snapshot taken at call time so a concurrent clear doesn't race.
        """
        snapshot = dict(active_continuation)
        decision_id = snapshot.get("decision_id")
        dedupe_key = snapshot.get("dedupe_key")
        if not isinstance(decision_id, str) or not isinstance(dedupe_key, str):
            logger.warning(
                "VTID-03076: skip continuation event (missing decision_id or dedupe_key)",
            )
            return
        body = {
            "decisionId": decision_id,
            "dedupeKey": dedupe_key,
            "eventName": event_name,
            "surface": snapshot.get("surface") or "orb_wake",
        }
        src = snapshot.get("source_key")
        if isinstance(src, str) and src:
            body["source"] = src
        try:
            res = await gw.post("/api/v1/voice/next-action/event", body)
            ok = isinstance(res, dict) and res.get("ok") is True
            if ok:
                logger.info(
                    "VTID-03076: continuation %s emitted (decision_id=%s)",
                    event_name, decision_id,
                )
            else:
                logger.warning(
                    "VTID-03076: continuation %s emit failed: %s",
                    event_name, res,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "VTID-03076: continuation %s POST exception: %s",
                event_name, exc,
            )

    # VTID-03046: per-turn latency state. user_input_transcribed sets
    # `user_done_at` and `user_text_len`; the next speech_created reads them,
    # computes the wait gap, and emits orb.livekit.agent.turn.measured. We
    # carry `system_instruction_chars` (the rendered prompt size) as a
    # constant so every emit can correlate latency with prompt size — that's
    # the whole point of this diagnostic. Cleared on emit so a duplicate
    # speech_created (handover etc.) doesn't re-fire with stale numbers.
    turn_state: dict[str, Any] = {
        "index": 0,
        "user_done_at": None,
        "user_text_len": 0,
        "system_instruction_chars": len(
            getattr(bootstrap, "system_instruction", None) or ""
        ),
    }

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

    # VTID-03007: unbounded soft-reset on stall. The earlier cap
    # (VTID-03004 MAX_SOFT_RESETS=3) was pure paranoia — once VTID-03005
    # proved the _stt swap works cleanly (3/3 in test bench), there is
    # no reason to ever GIVE UP on recovery: a dead agent is strictly
    # worse than rebuilding STT one more time. Telemetry is preserved
    # via soft_reset_count so we can still see how often it fires.
    soft_reset_count = {"n": 0}

    async def _on_stall() -> None:
        stall_count["n"] += 1
        soft_reset_count["n"] += 1
        logger.warning(
            "StallWatchdog: no activity in %ds (count=%d, soft_resets=%d) for orb_session_id=%s",
            int(STALL_THRESHOLD_MS / 1000),
            stall_count["n"],
            soft_reset_count["n"],
            orb_session_id,
        )

        # Rebuild the cascade and hot-swap STT in place. Same pattern
        # perform_handoff() uses for LLM/TTS during persona swap.
        # VTID-03005 proved Strategy B (session._stt) is the working
        # path on the deployed livekit-agents. Other strategies kept
        # as fallback in case the SDK version changes.
        reset_status = "not_attempted"
        reset_error: str | None = None
        strategy_results: list[str] = []
        try:
            fresh_cascade = build_cascade(
                bootstrap.voice_config,
                lang=identity.lang,
                voice_override=voice_override,
            )
            if fresh_cascade.stt is None:
                reset_status = "rebuild_returned_none"
                reset_error = f"cascade.notes={list(fresh_cascade.notes)[:5]}"[:300]
            else:
                new_stt = fresh_cascade.stt

                def _verify_swap() -> bool:
                    """Did the swap actually take?"""
                    candidates = [
                        getattr(session, "stt", None),
                        getattr(getattr(session, "_activity", None), "stt", None),
                        getattr(session, "_stt", None),
                    ]
                    return any(c is new_stt for c in candidates if c is not None)

                # Strategy A: livekit-agents 0.12+ pattern via _activity.
                try:
                    activity = getattr(session, "_activity", None)
                    if activity is not None:
                        setattr(activity, "stt", new_stt)
                        strategy_results.append("_activity.stt:assigned")
                        if _verify_swap():
                            reset_status = "swapped"
                            strategy_results.append("_activity.stt:verified")
                except Exception as exc:  # noqa: BLE001
                    strategy_results.append(f"_activity.stt:err={type(exc).__name__}")

                # Strategy B: private slot. Proven path on deployed SDK.
                if reset_status != "swapped":
                    try:
                        setattr(session, "_stt", new_stt)
                        strategy_results.append("_stt:assigned")
                        if _verify_swap():
                            reset_status = "swapped"
                            strategy_results.append("_stt:verified")
                    except Exception as exc:  # noqa: BLE001
                        strategy_results.append(f"_stt:err={type(exc).__name__}")

                # Strategy C: explicit update method, if SDK adds one.
                if reset_status != "swapped":
                    update_fn = getattr(session, "update_stt", None) or getattr(session, "set_stt", None)
                    if callable(update_fn):
                        try:
                            update_fn(new_stt)
                            strategy_results.append("update_stt:called")
                            if _verify_swap():
                                reset_status = "swapped"
                                strategy_results.append("update_stt:verified")
                        except Exception as exc:  # noqa: BLE001
                            strategy_results.append(f"update_stt:err={type(exc).__name__}")

                # Strategy D: bypass the @property — last resort.
                if reset_status != "swapped":
                    try:
                        object.__setattr__(session, "stt", new_stt)
                        strategy_results.append("__setattr__:applied")
                        if _verify_swap():
                            reset_status = "swapped"
                            strategy_results.append("__setattr__:verified")
                    except Exception as exc:  # noqa: BLE001
                        strategy_results.append(f"__setattr__:err={type(exc).__name__}")

                if reset_status != "swapped":
                    reset_status = "swap_failed"
                    reset_error = f"strategies={strategy_results}"[:500]
                else:
                    reset_error = f"strategies={strategy_results}"[:300]
                    logger.info(
                        "soft-reset swapped STT (n=%d) orb_session_id=%s via %s",
                        soft_reset_count["n"],
                        orb_session_id,
                        strategy_results[-2] if len(strategy_results) >= 2 else strategy_results[-1],
                    )
        except Exception as exc:  # noqa: BLE001
            reset_status = "rebuild_crashed"
            reset_error = f"strategies={strategy_results} rebuild_err={exc}"[:500]
            logger.warning("STT rebuild crashed: %s", exc)

        # Feed the watchdog so the next stall fires after a fresh
        # STALL_THRESHOLD_MS window, not immediately after this attempt.
        stall.feed()

        try:
            await oasis.emit(
                topic=TOPIC_STALL_DETECTED,
                payload={
                    "orb_session_id": orb_session_id,
                    "user_id": identity.user_id,
                    "agent_id": agent_id,
                    "stall_count": stall_count["n"],
                    "threshold_ms": STALL_THRESHOLD_MS,
                    "action": "soft_reset_stt",
                    "soft_reset_count": soft_reset_count["n"],
                    "soft_reset_status": reset_status,
                    "soft_reset_error": reset_error,
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
            # VTID-03046: per-turn measurement. Only emit if we have a
            # paired user_input_transcribed timestamp — skips the initial
            # greeting (session.say at room-join, no preceding user turn).
            # Null the timestamp on read so a follow-up speech_created in
            # the same turn (e.g. tool-loop continuation) doesn't re-fire.
            user_done = turn_state.get("user_done_at")
            if user_done is not None:
                wait_ms = int((time.monotonic() - user_done) * 1000)
                turn_state["index"] += 1
                payload = {
                    "user_id": identity.user_id or "unknown",
                    "code_version": CODE_VERSION,
                    "room_name": _room_name or "",
                    "orb_session_id": orb_session_id,
                    "turn_index": turn_state["index"],
                    "user_text_len": turn_state.get("user_text_len", 0),
                    "stt_done_to_speech_created_ms": wait_ms,
                    "system_instruction_chars": turn_state.get(
                        "system_instruction_chars", 0,
                    ),
                }
                turn_state["user_done_at"] = None
                turn_state["user_text_len"] = 0
                asyncio.create_task(
                    oasis.emit(topic=TOPIC_AGENT_TURN_MEASURED, payload=payload),
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
        # VTID-03046: mark the moment STT considered the user's turn
        # complete. Paired with the next speech_created in _on_speech
        # above. Capture transcript length defensively — the field name
        # varies across livekit-agents versions.
        turn_state["user_done_at"] = time.monotonic()
        text_len = 0
        try:
            t = (
                getattr(_ev, "transcript", None)
                or getattr(_ev, "text", None)
                or ""
            )
            if isinstance(t, str):
                text_len = len(t)
                # BOOTSTRAP-VOICE-DATASET-EMITTER: keep the raw transcript for
                # the turn so the paired assistant reply can emit
                # orb.turn.responded with the voice-tool-routing signal
                # (consent/PII-gated server-side at /api/v1/oasis/emit).
                turn_state["user_text"] = t
        except Exception:  # noqa: BLE001
            pass
        turn_state["user_text_len"] = text_len
        # VTID-03001: also surface the event in the trace firehose so we
        # can see STT completing user turns even when no audible agent
        # response follows. Pairs with agent_state_changed below to map
        # the full turn lifecycle.
        asyncio.create_task(
            _early_trace_heartbeat(
                cfg.gateway_url,
                {
                    "user_id": identity.user_id or "unknown",
                    "code_version": CODE_VERSION,
                    "phase": "user_input_transcribed",
                    "orb_session_id": orb_session_id,
                },
            )
        )

    try:
        session.on("user_input_transcribed")(_on_user_transcribed)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook user_input_transcribed: %s", exc)

    # VTID-03076 (P0-C): activeContinuation accept/dismiss intercept.
    #
    # Runs alongside the watchdog/counter handler above. When the user
    # replies "ja"/"yes"/"okay"/"nein"/"no" AND we have an unexpired
    # active_continuation, fire the accepted/dismissed event so OASIS
    # closes the suggested → accepted lifecycle with the same
    # decision_id. We do NOT silence the LLM — the wake-brief is in
    # chat_ctx, so the LLM will see the prior assistant turn and the
    # "ja" reply together and produce a coherent next response. This
    # handler is purely additive telemetry + clear-state.
    def _on_user_transcribed_for_continuation(_ev: Any = None) -> None:
        try:
            if not _continuation_is_active():
                if active_continuation:
                    # Stale offer — sweep it now.
                    _clear_continuation("ttl_expired")
                return
            transcript = ""
            try:
                t = (
                    getattr(_ev, "transcript", None)
                    or getattr(_ev, "text", None)
                    or ""
                )
                if isinstance(t, str):
                    transcript = t
            except Exception:  # noqa: BLE001
                return
            intent = _short_reply_intent(transcript)
            if intent == "accept":
                # Fire-and-forget. POST runs on the event loop; we clear
                # state immediately so a duplicate transcript event
                # can't double-fire.
                logger.info(
                    "VTID-03076: short-reply ACCEPT for decision_id=%s",
                    active_continuation.get("decision_id"),
                )
                asyncio.create_task(_post_continuation_event("accepted"))
                _clear_continuation("accepted")
            elif intent == "dismiss":
                logger.info(
                    "VTID-03076: short-reply DISMISS for decision_id=%s",
                    active_continuation.get("decision_id"),
                )
                asyncio.create_task(_post_continuation_event("dismissed"))
                _clear_continuation("dismissed")
            else:
                # Long / topical reply → treat as topic shift. The user
                # changed subject; the offer is no longer the live
                # context. Clear so a later "ja" on a different topic
                # doesn't accidentally accept the old offer.
                if _is_topic_shift(transcript):
                    _clear_continuation("topic_shift")
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "VTID-03076: continuation intercept handler failed: %s", exc,
            )

    try:
        session.on("user_input_transcribed")(_on_user_transcribed_for_continuation)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "VTID-03076: could not hook user_input_transcribed for continuation: %s",
            exc,
        )

    # VTID-03001: trace agent_state_changed so we can see the agent
    # transition idle → thinking → speaking. If `speaking` never fires
    # despite speech_created firing, the LLM produced no text (TTS got
    # nothing to synthesize). If `speaking` fires but no audio reaches
    # the browser, the break is downstream (TTS publish or playback).
    def _on_agent_state(ev: Any = None) -> None:
        stall.feed()
        new_state = None
        try:
            new_state = getattr(ev, "new_state", None) or getattr(ev, "state", None)
        except Exception:
            pass
        asyncio.create_task(
            _early_trace_heartbeat(
                cfg.gateway_url,
                {
                    "user_id": identity.user_id or "unknown",
                    "code_version": CODE_VERSION,
                    "phase": "agent_state_changed",
                    "orb_session_id": orb_session_id,
                    "new_state": str(new_state) if new_state is not None else None,
                },
            )
        )

    try:
        session.on("agent_state_changed")(_on_agent_state)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook agent_state_changed: %s", exc)

    # VTID-03075: the user_state_changed handler is wired below by
    # _record_user_state (does what this lambda did + records VAD
    # speaking-start timestamp for the silent-stall watchdog).

    # VTID-03001: conversation_item_added fires whenever something is
    # appended to chat_ctx — LLM responses, tool calls, etc. If we see
    # `assistant` role items with non-empty text but no audible
    # output, the LLM is producing text but TTS isn't producing audio.
    # BOOTSTRAP-VOICE-DATASET-EMITTER: emit a RAW orb.turn.responded for the
    # voice-tool-routing dataset. The gateway (/api/v1/oasis/emit) re-runs the
    # consent/PII gate before persisting, so transcript/tool fields are dropped
    # server-side when the tenant hasn't consented — the agent can't read
    # tenant policy itself, so it sends everything and lets the gateway gate.
    async def _emit_turn_responded(
        reply_text: str,
        user_text: str,
        tool_name: str | None,
        tool_args: dict[str, Any] | None,
    ) -> None:
        payload: dict[str, Any] = {
            "orb_session_id": orb_session_id,
            "conversation_id": orb_session_id,
            "reply_text": reply_text,
            "provider": "livekit",
            "user_id": identity.user_id,
            "tenant_id": identity.tenant_id,
        }
        if user_text:
            payload["input_text"] = user_text
            payload["transcript"] = user_text
        if tool_name:
            payload["tool_name"] = tool_name
            tc: dict[str, Any] = {"name": tool_name}
            if tool_args:
                tc["arguments"] = tool_args
            payload["tool_call"] = tc
        try:
            await oasis.emit(topic=TOPIC_TURN_RESPONDED, payload=payload)
        except Exception as exc:  # noqa: BLE001
            logger.debug("orb.turn.responded emit failed: %s", exc)

    def _on_conversation_item(ev: Any = None) -> None:
        item = getattr(ev, "item", None) or ev
        role = None
        text_len = 0
        reply_text_val = ""
        try:
            role = getattr(item, "role", None) or (
                item.get("role") if isinstance(item, dict) else None
            )
            text = (
                getattr(item, "text_content", None)
                or getattr(item, "text", None)
                or (item.get("text_content") if isinstance(item, dict) else None)
                or (item.get("text") if isinstance(item, dict) else None)
                or ""
            )
            text_len = len(text) if isinstance(text, str) else 0
            reply_text_val = text if isinstance(text, str) else ""
        except Exception:
            pass
        asyncio.create_task(
            _early_trace_heartbeat(
                cfg.gateway_url,
                {
                    "user_id": identity.user_id or "unknown",
                    "code_version": CODE_VERSION,
                    "phase": "conversation_item_added",
                    "orb_session_id": orb_session_id,
                    "role": str(role) if role is not None else None,
                    "text_len": text_len,
                },
            )
        )
        # BOOTSTRAP-VOICE-DATASET-EMITTER: on a substantive assistant reply that
        # answers a real user turn, emit orb.turn.responded. Only fire when a
        # pending user transcript exists — this skips the greeting (no preceding
        # user turn). Clear the per-turn signal on read so a tool-loop's extra
        # assistant items don't double-emit the same turn.
        try:
            if str(role) == "assistant" and reply_text_val.strip():
                pending_user = turn_state.get("user_text")
                if pending_user:
                    tool_name = getattr(gw, "last_tool_name", None)
                    tool_args = getattr(gw, "last_tool_args", None)
                    turn_state["user_text"] = None
                    gw.last_tool_name = None
                    gw.last_tool_args = None
                    asyncio.create_task(
                        _emit_turn_responded(
                            reply_text_val, pending_user, tool_name, tool_args,
                        )
                    )
        except Exception as exc:  # noqa: BLE001
            logger.debug("orb.turn.responded hook failed: %s", exc)

    try:
        session.on("conversation_item_added")(_on_conversation_item)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook conversation_item_added: %s", exc)

    # ------------------------------------------------------------------
    # VTID-03064 (B0d-real Xg): turn-end next-action wiring.
    #
    # Every time the assistant finishes saying something substantial,
    # ask the gateway for a structured continuation (the highest-priority
    # B0d-real candidate for surface=orb_turn_end). If one comes back,
    # speak it as a brief closing doorway after a small gap.
    #
    # Guards (kept tight to avoid feeling spammy):
    #   1. Only fire on role='assistant' items with text_len > 30 — skip
    #      tool acks + very short responses that don't end a turn.
    #   2. Skip when the assistant text ends with '?' — they already
    #      asked the user something.
    #   3. Per-session dedupe via a small set; same dedupe_key in the
    #      last 3 turns suppresses the speak.
    #   4. Fire-and-forget; gateway/network errors never block voice.
    # ------------------------------------------------------------------
    _turn_end_recent_dedupe: list[str] = []
    _TURN_END_DEDUPE_HISTORY = 3
    _TURN_END_MIN_TEXT_LEN = 30
    _TURN_END_GAP_SECONDS = 1.5

    async def _turn_end_fetch_and_speak(assistant_text: str) -> None:
        try:
            body = await gw.post(
                "/api/v1/voice/next-action/turn-end",
                {"lang": identity.lang or "en"},
            )
            if not isinstance(body, dict) or body.get("ok") is not True:
                return
            cont = body.get("continuation")
            if not isinstance(cont, dict):
                return
            line = cont.get("user_facing_line")
            dedupe_key = cont.get("dedupe_key")
            if not isinstance(line, str) or not line.strip():
                return
            if isinstance(dedupe_key, str) and dedupe_key in _turn_end_recent_dedupe:
                return

            # Pause briefly so the doorway doesn't bleed into the just-
            # spoken response. session.say() blocks until audio queues;
            # the sleep keeps the boundary audible.
            await asyncio.sleep(_TURN_END_GAP_SECONDS)
            try:
                await session.say(line.strip(), add_to_chat_ctx=False)
            except Exception as say_err:  # noqa: BLE001
                logger.warning(
                    "VTID-03064: turn-end session.say failed: %s", say_err,
                )
                return

            if isinstance(dedupe_key, str):
                _turn_end_recent_dedupe.append(dedupe_key)
                if len(_turn_end_recent_dedupe) > _TURN_END_DEDUPE_HISTORY:
                    del _turn_end_recent_dedupe[0]
        except Exception as exc:  # noqa: BLE001
            logger.warning("VTID-03064: turn-end fetch failed: %s", exc)

    def _on_turn_end_candidate(ev: Any = None) -> None:
        try:
            item = getattr(ev, "item", None) or ev
            role = getattr(item, "role", None) or (
                item.get("role") if isinstance(item, dict) else None
            )
            if role != "assistant":
                return
            text = (
                getattr(item, "text_content", None)
                or getattr(item, "text", None)
                or (item.get("text_content") if isinstance(item, dict) else None)
                or (item.get("text") if isinstance(item, dict) else None)
                or ""
            )
            if not isinstance(text, str):
                return
            stripped = text.strip()
            if len(stripped) < _TURN_END_MIN_TEXT_LEN:
                return
            if stripped.endswith("?") or stripped.endswith("?"):
                # Already a question; don't tack on another doorway.
                return
            asyncio.create_task(_turn_end_fetch_and_speak(stripped))
        except Exception as exc:  # noqa: BLE001
            logger.debug("VTID-03064: turn-end hook setup failed: %s", exc)

    try:
        session.on("conversation_item_added")(_on_turn_end_candidate)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook turn-end conversation_item_added: %s", exc)

    # ------------------------------------------------------------------
    # VTID-03050: STT FAILURE OBSERVABILITY (DIAGNOSTIC — no behavior
    # change). Three listeners that surface what was previously invisible:
    #
    #   1. `error` (livekit.agents events.ErrorEvent) — fires whenever an
    #      STT/LLM/TTS/RealtimeModel raises. Source-typed; we extract the
    #      `_orb_slot` tag set in providers.py so the emitted oasis event
    #      names *which* instance in the FallbackAdapter chain just died.
    #
    #   2. `stt_availability_changed` — emitted by FallbackAdapter on its
    #      OWN object (not on AgentSession), so we register on cascade.stt
    #      directly when it's an adapter. Fires every primary→mirror swap
    #      and every recovery. Closes the "did the chain actually swap?"
    #      diagnostic gap that VTID-03038/03041 left wide open.
    #
    #   3. `metrics_collected` — per-turn STT latency, audio durations,
    #      VAD confidence. Deprecated for usage tracking per the SDK but
    #      still the only clean way to see per-turn STT health.
    #
    # All three are fire-and-forget oasis emits. They MUST NOT raise back
    # into the SDK event-emitter loop or they'll desync the session.
    # ------------------------------------------------------------------
    def _slot_for(source: Any) -> str:
        """Best-effort name for an STT/LLM/TTS instance. Reads our
        provider-side `_orb_slot` tag first (set in providers.py), falls
        back to the SDK's `.label` property, then the class name."""
        try:
            slot = getattr(source, "_orb_slot", None)
            if isinstance(slot, str) and slot:
                return slot
        except Exception:  # noqa: BLE001
            pass
        try:
            label = getattr(source, "label", None)
            if isinstance(label, str) and label:
                return label
        except Exception:  # noqa: BLE001
            pass
        try:
            return type(source).__name__
        except Exception:  # noqa: BLE001
            return "unknown"

    def _source_kind(source: Any) -> str:
        """STT / LLM / TTS / RealtimeModel — by walking MRO names so we
        don't need to import the concrete SDK types here."""
        try:
            for cls in type(source).__mro__:
                name = cls.__name__
                if name in ("STT", "LLM", "TTS", "RealtimeModel"):
                    return name.lower()
        except Exception:  # noqa: BLE001
            pass
        return "unknown"

    def _on_session_error(ev: Any = None) -> None:
        try:
            err = getattr(ev, "error", None)
            src = getattr(ev, "source", None)
            err_type = type(err).__name__ if err is not None else "unknown"
            err_msg = (str(err) if err is not None else "")[:500]
            slot = _slot_for(src)
            kind = _source_kind(src)
            asyncio.create_task(
                oasis.emit(
                    topic=TOPIC_STT_ERROR,
                    payload={
                        "user_id": identity.user_id,
                        "orb_session_id": orb_session_id,
                        "source_kind": kind,           # stt / llm / tts / realtimemodel
                        "source_slot": slot,           # google_primary / google_mirror / deepgram_crossprovider / …
                        "error_type": err_type,        # APIError / TimeoutError / AssertionError / …
                        "error_message": err_msg,
                        "recoverable": getattr(err, "recoverable", None),
                    },
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("on_session_error emit failed: %s", exc)

    try:
        session.on("error")(_on_session_error)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook session.error: %s", exc)

    def _on_metrics(ev: Any = None) -> None:
        # Only emit STT-class metrics; LLM/TTS metrics are a separate
        # discussion and would flood the bus. The SDK exposes the
        # underlying metric type via `.type` on most plugins.
        try:
            m = getattr(ev, "metrics", None)
            if m is None:
                return
            mtype = (
                getattr(m, "type", None)
                or type(m).__name__
                or "unknown"
            )
            if "stt" not in str(mtype).lower():
                return
            # Compact payload — full metric dump would inflate oasis.
            payload = {
                "user_id": identity.user_id,
                "orb_session_id": orb_session_id,
                "metric_type": str(mtype),
                "audio_duration": getattr(m, "audio_duration", None),
                "duration": getattr(m, "duration", None),
                "streamed": getattr(m, "streamed", None),
                "label": getattr(m, "label", None),
            }
            asyncio.create_task(
                oasis.emit(topic=TOPIC_STT_METRICS, payload=payload)
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("on_metrics emit failed: %s", exc)

    try:
        session.on("metrics_collected")(_on_metrics)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook metrics_collected: %s", exc)

    # FallbackAdapter emits `stt_availability_changed` on ITS OWN
    # EventEmitter, not on AgentSession. Register on the cascade.stt
    # object directly. Skip cleanly if cascade.stt isn't a FallbackAdapter
    # (e.g. when ORB_STT_FALLBACK_ENABLED=false or only 1 instance was
    # built — providers.py returns a single STT unwrapped in those cases).
    def _on_stt_availability(ev: Any = None) -> None:
        try:
            stt_inst = getattr(ev, "stt", None)
            available = getattr(ev, "available", None)
            slot = _slot_for(stt_inst)
            asyncio.create_task(
                oasis.emit(
                    topic=TOPIC_STT_AVAILABILITY_CHANGED,
                    payload={
                        "user_id": identity.user_id,
                        "orb_session_id": orb_session_id,
                        "source_slot": slot,
                        "available": bool(available) if available is not None else None,
                    },
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("on_stt_availability emit failed: %s", exc)

    try:
        stt_obj = getattr(cascade, "stt", None)
        # Only FallbackAdapter implements this event; the bare STT classes
        # have an `on` method but never emit it. Guarding on isinstance is
        # fragile across SDK versions, so we just try-register; the SDK's
        # EventEmitter accepts subscribers for any event name.
        if stt_obj is not None and hasattr(stt_obj, "on"):
            stt_obj.on("stt_availability_changed")(_on_stt_availability)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook stt_availability_changed: %s", exc)

    # ------------------------------------------------------------------
    # VTID-03075: SILENT-STALL WATCHDOG. Cascade FallbackAdapter only
    # advances on STT errors. Production telemetry (2026-05-18 10:07-10:10
    # UTC: livekit.stt.metrics with audio_duration=170s, zero error/
    # availability events) proved Google STT can silently buffer minutes
    # of audio without raising. From the user's seat: agent in `listening`
    # forever, no response, dead conversation, 5-10s tolerance.
    #
    # This watchdog watches for: user_state_changed → "speaking" without
    # a `user_input_transcribed` event for SILENT_STALL_THRESHOLD_S. On
    # detection:
    #   (a) emit `livekit.stt.silent_stall` oasis (telemetry)
    #   (b) publish a `client.alert.show` data message into the LiveKit
    #       room so the frontend can paint a "Hold on, reconnecting…"
    #       banner + audio chime (Vertex INSTANT-FEEDBACK parity).
    #
    # ACTUAL STT recovery (forcing FallbackAdapter to swap) is NOT in
    # this PR — needs telemetry from this watchdog firing in real sessions
    # before picking the recovery primitive (custom FallbackAdapter
    # subclass with stream-idle detection, or AgentSession restart).
    # Today's value: user immediately sees "we know it's broken" instead
    # of "dead for 3 minutes."
    # ------------------------------------------------------------------
    SILENT_STALL_THRESHOLD_S = 3.0
    # VTID-03079: combined predicate. The old single-condition watchdog
    # (just `speaking_for >= 3s`) fired during NORMAL 5-8s utterances
    # because Google STT often takes that long to finalize a turn — and
    # the user heard the recovery chime mid-sentence with no logic. The
    # 2026-05-18 18:43-18:46 session showed the issue exactly:
    #   stall #1: since_last_transcript=80.14s  ← real bug, recover
    #   stall #2: since_last_transcript=3.37s   ← FALSE POSITIVE
    #   stall #3: since_last_transcript=33.14s  ← maybe real
    # Adding `since_last_transcript_s >= MIN_TRANSCRIPT_AGE_S` as a
    # second required condition makes the predicate
    #   VAD says speaking for ≥3s  AND  no transcript for ≥15s
    # which is the signature of an actual stall (the 80s and 33s cases),
    # not normal STT latency.
    SILENT_STALL_MIN_TRANSCRIPT_AGE_S = 15.0
    SILENT_STALL_REPEAT_S = 8.0  # rate-limit: one alert per window

    # VTID-03080: the proper detection primitive. When VAD says
    # `user_state_changed → listening` (= user stopped speaking),
    # Google STT should produce a final transcript within ~1s. If 2s
    # pass without `user_input_transcribed`, that's an unambiguous
    # stall — orders of magnitude faster than the VTID-03079 fallback
    # path (which needs 15s of silence) and structurally accurate
    # (no false positives during normal STT finalization).
    VAD_SPEECH_END_TRANSCRIPT_TIMEOUT_S = 2.0

    stall_state: dict[str, Any] = {
        "user_speaking_since": None,           # monotonic when VAD → speaking
        "expecting_transcript_since": None,    # monotonic when VAD said speech_end (user→listening from speaking)
        "last_transcript_at": time.monotonic(),
        "last_alert_at": 0.0,
    }

    async def _publish_client_alert(reason: str, detail: str | None = None) -> None:
        """Send a JSON data-message to the LiveKit room so the frontend
        can paint a banner + play a chime. Best-effort; agent must not
        crash if publish_data isn't available on this SDK version."""
        try:
            room = getattr(ctx, "room", None)
            lp = getattr(room, "local_participant", None) if room is not None else None
            if lp is None:
                return
            payload = json.dumps({
                "type": "client.alert.show",
                "reason": reason,
                "detail": detail,
                "timestamp_ms": int(time.time() * 1000),
            }).encode("utf-8")
            pub = getattr(lp, "publish_data", None)
            if callable(pub):
                res = pub(payload, topic="orb_alert")
                if asyncio.iscoroutine(res):
                    await res
        except Exception as exc:  # noqa: BLE001
            logger.debug("publish_client_alert(%s) failed: %s", reason, exc)

    def _record_user_state(ev: Any = None) -> None:
        """Feeds the stall watchdog (VTID-02854) and tracks two transitions:
          - speaking-start → arms the wall-clock fallback detector (VTID-03079)
          - speaking → listening → arms the VAD-speech-end primary detector
            (VTID-03080). After VAD declares end of speech, STT must
            produce a final transcript within ~2s or it's a stall.
        Any speaking transition cancels a pending speech-end timer
        (user resumed talking before STT finalized — that's just a
        long utterance, not a stall)."""
        stall.feed()
        try:
            new_state = getattr(ev, "new_state", None)
            old_state = getattr(ev, "old_state", None)
        except Exception:  # noqa: BLE001
            new_state = None
            old_state = None
        if new_state == "speaking":
            stall_state["user_speaking_since"] = time.monotonic()
            # User talking again — clear any pending speech-end watchdog.
            stall_state["expecting_transcript_since"] = None
        elif new_state in ("listening", "away", None):
            stall_state["user_speaking_since"] = None
            # VTID-03080: VAD just said the user stopped. Expect a final
            # transcript shortly. Only arm if we're transitioning FROM
            # "speaking" (otherwise this is an idle-state shuffle, not a
            # speech turn that needs finalization).
            if old_state == "speaking" and new_state == "listening":
                stall_state["expecting_transcript_since"] = time.monotonic()

    try:
        session.on("user_state_changed")(_record_user_state)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook user_state_changed for silent-stall: %s", exc)

    def _on_transcript_for_stall(_ev: Any = None) -> None:
        stall_state["last_transcript_at"] = time.monotonic()
        stall_state["user_speaking_since"] = None        # turn closed cleanly
        stall_state["expecting_transcript_since"] = None  # VTID-03080: transcript arrived after speech_end

    try:
        session.on("user_input_transcribed")(_on_transcript_for_stall)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        logger.debug("could not hook user_input_transcribed for stall-state: %s", exc)

    # ------------------------------------------------------------------
    # VTID-03078: ACTUAL STT RECOVERY on silent-stall detection.
    #
    # The session at 2026-05-18 16:07-16:14 UTC confirmed the diagnostic
    # gap VTID-03075 left open: the watchdog detected silent_stall within
    # 3s as designed, but the FallbackAdapter could not advance (its swap
    # logic only fires on stream exceptions; Google STT silently buffers
    # without raising). 18 stalls, 2 minutes of dead audio, user gave up.
    #
    # This block adds the actual swap. When silent_stall fires:
    #   1. Build a fresh cascade.stt via providers.build_cascade — three
    #      NEW STT instances, new gRPC connections to Google + Deepgram.
    #   2. Create a new Agent carrying stt=fresh, preserving everything
    #      else from the current Agent (instructions, tools, llm, tts,
    #      chat_ctx). Agent-level stt= overrides session-level stt at
    #      agent_activity.py:3717 (verified upstream source).
    #   3. session.update_agent(new_agent) — in-place swap (same path
    #      as VTID-03046 persona handoff). Bounded by 5s wait on the
    #      activity-transition task.
    #
    # Bounded to STT_RECOVERY_MAX_ATTEMPTS per session. After exhausting
    # attempts the watchdog stays telemetry-only — likely a deeper
    # LiveKit transport problem, not STT. Kill switch:
    # ORB_STT_RECOVERY_ENABLED=false reverts to detection-only behavior.
    # ------------------------------------------------------------------
    # VTID-03079: bumped from 3 → 5. The previous cap was burned by
    # false-positive triggers (see SILENT_STALL_MIN_TRANSCRIPT_AGE_S
    # comment above); after VTID-03079's tighter predicate every fired
    # attempt should be a real stall, and a longer session may
    # legitimately need 4-5 recoveries. Each attempt is bounded to ~3s
    # by the activity-swap wait, so 5 attempts cost at most ~15s of
    # total session disruption — still well under any user's patience.
    STT_RECOVERY_MAX_ATTEMPTS = 5

    def _stt_recovery_enabled() -> bool:
        return os.environ.get("ORB_STT_RECOVERY_ENABLED", "true").lower() not in (
            "false", "0", "no", "off",
        )

    recovery_state: dict[str, Any] = {
        "attempts": 0,
        "last_attempt_at": 0.0,
        "in_flight": False,
    }

    async def _attempt_stt_recovery() -> None:
        """Build a fresh STT cascade and swap it onto the current Agent.
        Bounded; runs at most STT_RECOVERY_MAX_ATTEMPTS per session and
        guards against re-entry while a previous swap is still completing."""
        if not _stt_recovery_enabled():
            return
        if recovery_state["in_flight"]:
            return
        attempts = int(recovery_state["attempts"])
        if attempts >= STT_RECOVERY_MAX_ATTEMPTS:
            # Emit gave_up exactly once when we hit the cap.
            if attempts == STT_RECOVERY_MAX_ATTEMPTS:
                recovery_state["attempts"] = attempts + 1  # idempotent
                asyncio.create_task(
                    oasis.emit(
                        topic=TOPIC_STT_RECOVERY,
                        payload={
                            "user_id": identity.user_id,
                            "orb_session_id": orb_session_id,
                            "outcome": "gave_up",
                            "attempts": attempts,
                            "max_attempts": STT_RECOVERY_MAX_ATTEMPTS,
                        },
                    )
                )
            return

        recovery_state["in_flight"] = True
        recovery_state["attempts"] = attempts + 1
        recovery_state["last_attempt_at"] = time.monotonic()
        attempt_no = recovery_state["attempts"]

        # Telemetry: announce the attempt.
        asyncio.create_task(
            oasis.emit(
                topic=TOPIC_STT_RECOVERY,
                payload={
                    "user_id": identity.user_id,
                    "orb_session_id": orb_session_id,
                    "outcome": "attempted",
                    "attempt_no": attempt_no,
                    "max_attempts": STT_RECOVERY_MAX_ATTEMPTS,
                },
            )
        )

        try:
            # Step 1: fresh cascade. Same build_cascade call as session
            # bootstrap — keeps language, voice override, all options.
            fresh_cascade = build_cascade(
                bootstrap.voice_config,
                lang=identity.lang,
                voice_override=voice_override,
            )
            if fresh_cascade.stt is None:
                logger.warning(
                    "VTID-03078: fresh cascade has no STT (build_cascade notes=%s) — abort recovery",
                    list(fresh_cascade.notes)[:5],
                )
                return

            # Step 2: snapshot the current Agent so we preserve everything
            # except STT. The Agent on this session is the same object
            # passed to session.start; we grab it back via session.agent.
            current = getattr(session, "agent", None)
            if current is None:
                logger.warning("VTID-03078: session.agent is None — abort recovery")
                return

            new_agent = Agent(
                instructions=getattr(current, "_instructions", "") or "",
                tools=list(getattr(current, "_tools", []) or []),
                chat_ctx=getattr(current, "_chat_ctx", None),
                stt=fresh_cascade.stt,
                llm=getattr(current, "_llm", None),
                tts=getattr(current, "_tts", None),
            )

            # Step 3: in-place swap. update_agent is sync; the activity
            # transition runs as a background task. Bounded wait so we
            # know within ~5s whether the swap landed.
            session.update_agent(new_agent)
            swap_task = getattr(session, "_update_activity_atask", None)
            if swap_task is not None:
                try:
                    await asyncio.wait_for(swap_task, timeout=5.0)
                except asyncio.TimeoutError:
                    logger.warning(
                        "VTID-03078: activity-swap task didn't finish in 5s for STT recovery"
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "VTID-03078: activity-swap task raised: %s", exc
                    )

            # Reset the stall-state so the watchdog doesn't re-fire
            # immediately on the same stale `user_speaking_since`.
            stall_state["user_speaking_since"] = None
            stall_state["last_transcript_at"] = time.monotonic()

            logger.info(
                "VTID-03078: STT recovery swap completed (attempt %d/%d)",
                attempt_no, STT_RECOVERY_MAX_ATTEMPTS,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("VTID-03078: STT recovery attempt %d failed: %s", attempt_no, exc)
        finally:
            recovery_state["in_flight"] = False

    def _check_for_stall(now: float) -> tuple[str, dict[str, Any]] | None:
        """Return (detection_reason, telemetry_extras) if a stall should
        fire this tick, else None. Two detectors in priority order:

          1. VTID-03080 — VAD-speech-end. Best signal. After VAD says
             user stopped speaking, STT should produce a final transcript
             within ~1s. If 2s+ pass without one, real stall — fast,
             accurate, no false positives during normal STT finalization.

          2. VTID-03079 — wall-clock fallback. Catches cases where VAD
             never reports "listening" (Silero misclassifies ambient
             noise as continuous speech). Requires BOTH speaking_for≥3s
             AND since_last_transcript≥15s. Slower (~15s detection) but
             covers the gap where the primary detector is blind.
        """
        # Primary: VAD speech-end without follow-up transcript.
        expecting = stall_state.get("expecting_transcript_since")
        if expecting is not None:
            waiting_after_end = now - expecting
            if waiting_after_end >= VAD_SPEECH_END_TRANSCRIPT_TIMEOUT_S:
                return ("vad_speech_end_no_transcript", {
                    "waiting_after_speech_end_s": round(waiting_after_end, 2),
                    "detector": "vad_speech_end",
                })
        # Fallback: long VAD-speaking-without-transcript (when speech_end
        # never fired because VAD treats ambient noise as continuous).
        started = stall_state.get("user_speaking_since")
        if started is not None:
            speaking_for = now - started
            if speaking_for >= SILENT_STALL_THRESHOLD_S:
                last_transcript_at = stall_state.get("last_transcript_at") or now
                since_last_transcript = now - last_transcript_at
                if since_last_transcript >= SILENT_STALL_MIN_TRANSCRIPT_AGE_S:
                    return ("speaking_no_transcript", {
                        "speaking_for_s": round(speaking_for, 2),
                        "since_last_transcript_s": round(since_last_transcript, 2),
                        "detector": "vad_speaking_timer",
                    })
        return None

    async def _silent_stall_watchdog() -> None:
        """Poll every 1s. Check both stall detectors (VAD-speech-end and
        wall-clock fallback). Rate-limited by SILENT_STALL_REPEAT_S so
        one long stall doesn't spam the client."""
        while True:
            try:
                await asyncio.sleep(1.0)
                now = time.monotonic()
                detection = _check_for_stall(now)
                if detection is None:
                    continue
                reason, extras = detection
                last_alert = stall_state.get("last_alert_at") or 0.0
                if (now - last_alert) < SILENT_STALL_REPEAT_S:
                    continue
                stall_state["last_alert_at"] = now
                # Clear the trigger state so we don't immediately re-fire
                # on the next tick before recovery runs.
                if reason == "vad_speech_end_no_transcript":
                    stall_state["expecting_transcript_since"] = None
                payload = {
                    "user_id": identity.user_id,
                    "orb_session_id": orb_session_id,
                    "reason": reason,
                    "since_last_transcript_s": round(
                        now - (stall_state.get("last_transcript_at") or now), 2
                    ),
                    "threshold_s": SILENT_STALL_THRESHOLD_S,
                    "min_transcript_age_s": SILENT_STALL_MIN_TRANSCRIPT_AGE_S,
                    "vad_speech_end_timeout_s": VAD_SPEECH_END_TRANSCRIPT_TIMEOUT_S,
                }
                payload.update(extras)
                asyncio.create_task(
                    oasis.emit(topic=TOPIC_STT_SILENT_STALL, payload=payload)
                )
                client_detail = (
                    f"reason={reason} "
                    + " ".join(f"{k}={v}" for k, v in extras.items() if k != "detector")
                )
                await _publish_client_alert(reason="stt_silent_stall", detail=client_detail)
                # VTID-03078: fire the actual recovery — fresh STT cascade
                # swapped onto the current Agent via session.update_agent.
                # Bounded (max 3 attempts per session); kill-switchable via
                # ORB_STT_RECOVERY_ENABLED=false.
                asyncio.create_task(_attempt_stt_recovery())
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.debug("silent_stall_watchdog tick error: %s", exc)

    _silent_stall_task: asyncio.Task[None] | None = None
    try:
        _silent_stall_task = asyncio.create_task(_silent_stall_watchdog())
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not start silent-stall watchdog: %s", exc)

    # Stop the watchdog when the room disconnects so we don't leak the task.
    async def _stop_stall_on_shutdown() -> None:
        try:
            await stall.stop()
        except Exception:  # noqa: BLE001
            pass
        # VTID-03075: also tear down the silent-stall watchdog.
        if _silent_stall_task is not None and not _silent_stall_task.done():
            _silent_stall_task.cancel()
            try:
                await _silent_stall_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    ctx.add_shutdown_callback(_stop_stall_on_shutdown)

    # Initial greeting — VTID-03014: localize the greeting text to
    # identity.lang. Before this fix the greeting was always English even
    # when the user picked German in the Test Bench, because session.say()
    # speaks the literal string we pass — there is no LLM translation
    # step between us and TTS. The system_instruction's "LANGUAGE:
    # Respond ONLY in <lang>" rule only governs LLM-generated turns,
    # not direct session.say() output.
    #
    # Also drops the "@handle as fallback" path when a first_name is
    # present, so Gemini never sees two competing addressing signals.
    if not identity.is_anonymous:
        vid = (bootstrap.vitana_id or "").strip()
        first_name = (bootstrap.first_name or "").strip()
        # VTID-03054: when the gateway returned a wake-brief decision with a
        # non-empty user_facing_line, speak THAT instead of the generic
        # localized greeting. This is the slice that turns the wake-brief
        # framework from "observable telemetry" into user-visible proactive
        # behavior. Fully reversible — empty/missing decision falls back to
        # _localized_greeting() so a degraded bootstrap path never silences
        # the orb.
        wake_brief = getattr(bootstrap, "wake_brief_decision", None) or {}
        wake_line = wake_brief.get("user_facing_line") if isinstance(wake_brief, dict) else None
        # VTID-03076 (P0-C): is this a real proactive offer (wake_brief
        # kind=wake_brief OR next_step) we should remember? The agent
        # only persists state for offers that have a decision_id +
        # dedupe_key so the user's "ja"/"nein" can be POSTed back to
        # /voice/next-action/event for OASIS lifecycle. A generic
        # localized greeting (no decision) gets NO active_continuation.
        is_proactive_offer = (
            isinstance(wake_line, str)
            and wake_line.strip()
            and isinstance(wake_brief, dict)
            and isinstance(wake_brief.get("decision_id"), str)
            and isinstance(wake_brief.get("dedupe_key"), str)
        )
        if isinstance(wake_line, str) and wake_line.strip():
            greeting_text = wake_line.strip()
            logger.info(
                "VTID-03054: speaking wake_brief user_facing_line (kind=%s, decision_id=%s)",
                wake_brief.get("selected_kind") if isinstance(wake_brief, dict) else None,
                wake_brief.get("decision_id") if isinstance(wake_brief, dict) else None,
            )
            # VTID-03076: persist activeContinuation BEFORE the speak so
            # a race with the next user turn finds the state populated.
            if is_proactive_offer:
                active_continuation.update({
                    "decision_id": wake_brief.get("decision_id"),
                    "dedupe_key": wake_brief.get("dedupe_key"),
                    "source_key": wake_brief.get("source_key"),
                    "selected_kind": wake_brief.get("selected_kind"),
                    "user_facing_line": greeting_text,
                    "lang": identity.lang or "en",
                    "surface": "orb_wake",
                    "created_at_monotonic": time.monotonic(),
                    "expires_at_monotonic": time.monotonic() + _CONTINUATION_TTL_SECONDS,
                })
                logger.info(
                    "VTID-03076: activeContinuation set (decision_id=%s, source_key=%s, ttl=%.0fs)",
                    active_continuation.get("decision_id"),
                    active_continuation.get("source_key"),
                    _CONTINUATION_TTL_SECONDS,
                )
        else:
            greeting_text = _localized_greeting(
                identity.lang,
                first_name=first_name,
                vitana_handle=vid,
            )
            is_proactive_offer = False
    else:
        greeting_text = _localized_anonymous_greeting(identity.lang)
        is_proactive_offer = False
    try:
        # VTID-03017: add_to_chat_ctx=False — the greeting is a deterministic
        # template, not an LLM turn, so it shouldn't pollute chat_ctx as if
        # the model authored it. The LLM still knows the user is freshly
        # greeted via the placeholder system prompt + (after hydration) the
        # rendered system_instruction.
        #
        # VTID-03076 (P0-C) exception: a REAL proactive offer (wake_brief
        # with decision_id + dedupe_key) MUST go into chat_ctx so the LLM
        # remembers having said it. Otherwise the user's "ja" hits the
        # model with no context and produces a tangential answer
        # (Vitanaland explanation when a match was offered). Localized
        # greetings stay out of chat_ctx — those are decoration, not
        # offers the user can act on.
        await session.say(greeting_text, add_to_chat_ctx=bool(is_proactive_offer))
    except Exception as exc:  # noqa: BLE001
        logger.warning("initial greeting session.say failed: %s", exc)
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

    # VTID-03021: NO background hydration. The full system_instruction is
    # already bound to Agent(instructions=sys_prompt) at construction time
    # above — no runtime swap needed, no SDK-API research needed, no
    # `applied_instructions:false` failure mode. Correctness > 500ms latency.

    # VTID-03027: PERSONA REBUILD LOOP — Vertex-parity for report_to_specialist.
    #
    # Vertex's transparent-reconnect approach: when user reports a bug,
    # Vitana files the ticket and triggers attemptTransparentReconnect
    # with Devon's system_prompt + Devon's voice config. The Gemini Live
    # WebSocket is torn down and rebuilt with the new persona — same
    # room, new identity, new voice.
    #
    # LiveKit equivalent: the tool wrapper sets gw.handoff_event with
    # gw.handoff_target = 'devon' + gw.handoff_summary = <bug_brief>.
    # The loop here:
    #   1. Waits for EITHER disconnect OR handoff event.
    #   2. On disconnect: break out, normal cleanup runs.
    #   3. On handoff: stops the current AgentSession (so the current
    #      voice's audio frame queue drains), fetches the new persona's
    #      bootstrap with handoff_summary= so the gateway renders
    #      Devon's system_instruction with [HANDOFF NOTE] injected,
    #      builds Devon's cascade, starts a fresh AgentSession in the
    #      same room. Then calls session.generate_reply(...) to trigger
    #      Devon's first turn in Devon's voice referencing the brief.
    #   4. Loop back — Devon's session can also handoff (e.g. back to
    #      Vitana, or laterally), or eventually the user disconnects.
    while True:
        disc_task = asyncio.create_task(disconnected_evt.wait())
        handoff_task = asyncio.create_task(gw.handoff_event.wait())
        done, pending = await asyncio.wait(
            {disc_task, handoff_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()

        if disconnected_evt.is_set():
            break

        # Handoff signal fired. Capture targets, clear event, run rebuild.
        target = (gw.handoff_target or "").strip().lower()
        handoff_brief = (gw.handoff_summary or "").strip()
        reason = (gw.handoff_reason or "").strip() or "handoff"
        gw.handoff_event.clear()
        gw.handoff_target = None
        gw.handoff_summary = None
        gw.handoff_reason = None
        if not target or target not in {"devon", "sage", "atlas", "mira", "vitana"}:
            logger.warning(
                "agent_entrypoint: handoff signal with invalid target %r — ignored",
                target,
            )
            continue

        from_agent_id = gw.current_agent_id
        logger.info(
            "agent_entrypoint: rebuilding session for handoff %s → %s",
            from_agent_id,
            target,
        )
        try:
            await oasis.emit(
                topic=TOPIC_HANDOFF_START,
                payload={
                    "from_agent_id": from_agent_id,
                    "to_agent_id": target,
                    "reason": reason,
                    "context_summary": handoff_brief,
                    "user_id": identity.user_id,
                    "orb_session_id": orb_session_id,
                },
            )
        except Exception:  # noqa: BLE001
            pass

        # VTID-03046: NO aclose, NO new AgentSession, NO session.start.
        # Replaced the rebuild-from-scratch flow with an in-place
        # AgentSession.update_agent(...) swap. Same audio pipeline, same
        # room subscription, same session-level STT (FallbackAdapter from
        # VTID-03038/03041 — Google + Google mirror + Deepgram). Only
        # instructions, tools, LLM, and TTS swap with the persona.
        # The aclose race that hung session 0adc6ff6 for 9 min on
        # 2026-05-17 14:23 UTC is gone by construction — there's nothing
        # to close. VTID-03045's 3-second timeout was the mitigation;
        # this is the proper fix.

        # Fetch the new persona's bootstrap. handoff_summary injects the
        # [HANDOFF NOTE] into the gateway-rendered persona system_instruction.
        try:
            new_bootstrap = await ctx_fetcher.fetch(
                user_jwt=user_jwt or "",
                agent_id=target,
                is_reconnect=True,
                last_n_turns=10,
                lang=identity.lang,
                client_ip=identity.client_ip,
                handoff_summary=handoff_brief or None,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("agent_entrypoint: new persona bootstrap fetch failed: %s", exc)
            break

        # VTID-03028: build the new persona's cascade. Their voice lives in
        # bootstrap.voice_config (agent_voice_configs row for agent_id=devon/sage/…).
        #
        # CRITICAL: do NOT forward voice_override to specialists. That
        # variable is the Test Bench's user-picked voice (Vitana's female
        # voice in our smoke testing). Forwarding it overrides Devon's
        # male voice → Devon answers in Vitana's voice. When swapping
        # BACK to Vitana, keep the override (the user picked her voice
        # intentionally).
        target_is_specialist = target in {"devon", "sage", "atlas", "mira"}
        cascade_voice_override = None if target_is_specialist else voice_override
        new_cascade = build_cascade(
            new_bootstrap.voice_config,
            lang=identity.lang,
            voice_override=cascade_voice_override,
        )
        new_sys_prompt = new_bootstrap.system_instruction or (
            "You are a Vitana specialist. The gateway did not render your "
            "system instruction. Greet the user and help them as best you can."
        )
        new_tool_list = all_tools()
        if (new_bootstrap.voice_config or {}).get("llm_provider") == "google_llm":
            try:
                from livekit.plugins.google.tools import GoogleSearch  # type: ignore[import-not-found]
                new_tool_list.append(GoogleSearch())
            except ImportError:
                pass
        # VTID-03046: Agent carries the persona's LLM + TTS as per-agent
        # overrides. agent_activity.py:3721/3725 resolves LLM/TTS via
        # `self._agent.llm if is_given(self._agent.llm) else self._session.llm`,
        # so passing them on the Agent wins over whatever's at the session
        # level. STT is INTENTIONALLY not passed — the new agent inherits
        # the session-level FallbackAdapter (Google + Google mirror +
        # Deepgram from VTID-03038/03041) so the audio pipeline never
        # disconnects during the persona swap.
        new_agent = Agent(
            instructions=new_sys_prompt,
            tools=new_tool_list,
            llm=new_cascade.llm,
            tts=new_cascade.tts,
        )
        gw.current_agent_id = target

        # In-place swap. update_agent is sync; it sets `_agent` and
        # schedules `_update_activity_task` in the background. Block on
        # that task before generate_reply so the first turn is produced
        # by the new persona's LLM/TTS, not the old. Bounded wait — if
        # the activity transition wedges, log + proceed; generate_reply
        # will queue against whatever activity is current.
        try:
            session.update_agent(new_agent)
        except Exception as exc:  # noqa: BLE001
            logger.exception("agent_entrypoint: session.update_agent failed: %s", exc)
            break

        swap_task = getattr(session, "_update_activity_atask", None)
        if swap_task is not None:
            try:
                await asyncio.wait_for(swap_task, timeout=5.0)
            except asyncio.TimeoutError:
                logger.warning(
                    "agent_entrypoint: activity-swap task didn't finish in 5s — "
                    "calling generate_reply on whatever's current"
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "agent_entrypoint: activity-swap task raised: %s — continuing",
                    exc,
                )

        # Trigger persona's first turn — the LLM speaks as the persona,
        # referencing the handoff brief from its system_instruction.
        # VTID-03028: when the target is Vitana (swap-back from a
        # specialist), the open should be a brief continuity greeting,
        # not a fresh "hi I'm Vitana" — the user already spoke with her.
        try:
            if target == "vitana" and from_agent_id in {"devon", "sage", "atlas", "mira"}:
                first_turn_instr = (
                    "The user just came back from a specialist colleague "
                    f"({from_agent_id.capitalize()}) who handled their request. "
                    "Speak ONE short, warm continuity sentence acknowledging they're "
                    "back with you in their language — vary phrasing every call "
                    "(EN: 'Alright, I'm back with you.' / DE: 'Alles klar, ich bin wieder da.'). "
                    "Then ask one open follow-up question (e.g. 'is there anything else "
                    "I can help with?'). Do NOT introduce yourself ('I'm Vitana') — "
                    "the user already knows who you are. Do NOT ask what was discussed "
                    "with the specialist — they've heard enough."
                )
            else:
                first_turn_instr = (
                    "Open this conversation as yourself (the persona described in your "
                    "system instruction). Greet the user warmly in their language with "
                    "ONE short sentence introducing yourself by role. If a HANDOFF NOTE "
                    "is present in your system instruction, synthesize it in ONE sentence "
                    "in your own words and confirm. Then follow the [BEHAVIORAL RULE] "
                    "sections in your system instruction (confirm ticket logged, ask "
                    "'anything else?', and hand back to Vitana when the user is done). "
                    "Vary your phrasing. NEVER speak as Vitana."
                )
            await session.generate_reply(instructions=first_turn_instr)
        except Exception as exc:  # noqa: BLE001
            logger.warning("agent_entrypoint: persona first turn failed: %s", exc)

        try:
            await oasis.emit(
                topic=TOPIC_HANDOFF_COMPLETE,
                payload={
                    "from_agent_id": from_agent_id,
                    "to_agent_id": target,
                    "user_id": identity.user_id,
                    "orb_session_id": orb_session_id,
                },
            )
        except Exception:  # noqa: BLE001
            pass


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
    client_ip: str | None = None,
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
        user_jwt=user_jwt,
        agent_id=to_agent_id,
        is_reconnect=True,
        last_n_turns=10,
        lang=lang,
        # VTID-03014: keep geo accurate through specialist swaps too.
        client_ip=client_ip,
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
